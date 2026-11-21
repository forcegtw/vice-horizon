// city.js — the Vice Horizon town generator. A blocks×blocks grid of street
// cells; every cell is one raised sidewalk slab packed with slab towers (or,
// sometimes, a park), dressed with lamp posts, storefront bands, street props,
// road paint and rooftop clutter. Everything static gets merged into a few
// draw calls by the box batcher below, so a whole city costs a laptop GPU
// almost nothing.
//
// HALF — the street grid's half-extent — is derived once here and exported:
// traffic, peds, missions and the minimap all clamp against it rather than
// re-deriving bounds. Block layout is drawn from the caller's seeded rng, so
// a given seed always grows the same city; the order in which that rng is
// consulted is part of the contract and must not be reordered.

import * as THREE from '../vendor/three.min.js';
import { WORLD } from './config.js';

export const HALF = (WORLD.blocks * WORLD.lotSize) / 2;

// Grid geometry, derived once at module scope: cells sit on a lotSize pitch,
// the usable inner area is what remains after road and two sidewalks.
const GRID_CELLS = WORLD.blocks * WORLD.blocks;
const CELL_INNER = WORLD.lotSize - WORLD.roadWidth - WORLD.sidewalk * 2;
const LAMP_REACH = CELL_INNER / 2 + 2.4;
const CURB_EDGE = WORLD.lotSize / 2 - WORLD.roadWidth / 2;
const INTERSECTIONS = WORLD.blocks + 1;

// ---------------------------------------------------------------------------
// Canvas texture painters, run once at boot. Grit patterns come from grain01,
// an integer hash standing in for Math.random, so speckle is identical across
// reloads without touching the world seed.
// ---------------------------------------------------------------------------

// Deterministic 0..1 grain for the i-th speck.
function grain01(i) {
  const hashed = (i * 2654435761) >>> 0;
  return (hashed % 1000) / 1000;
}

function canvas2d(size) {
  const surface = document.createElement('canvas');
  surface.width = size;
  surface.height = size;
  return { surface, g: surface.getContext('2d') };
}

// Shared texture finish: repeat on both axes, plus sRGB and anisotropic
// filtering only where a colour texture wants them.
function asTexture(surface, { srgb = true, aniso = 0 } = {}) {
  const tex = new THREE.CanvasTexture(surface);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (aniso) tex.anisotropy = aniso;
  return tex;
}

// Wall styles: [brick red, concrete gray, glass-blue tower].
const TOWER_WALLS = [
  { wall: '#7d5040', trim: '#5e3d32', lit: '#f5d9a8', dark: '#191c24' },
  { wall: '#8b9099', trim: '#6f747d', lit: '#d6e6f5', dark: '#151920' },
  { wall: '#38506e', trim: '#283c56', lit: '#b8d8f0', dark: '#0f1622' },
];

// Window grid density: 7 x 9 per tile reads as windows at street level without
// turning into noise when a tower repeats this texture up its full height.
const FACADE_GRID_X = 7;
const FACADE_GRID_Y = 9;
const FACADE_PANES = FACADE_GRID_X * FACADE_GRID_Y;

// Facade wall: flat base colour, then a window lattice painted pane by pane
// (row-major so the glow twin below can mirror it), with storey lines between
// rows. ~40% of panes read lit; half-drawn blinds and a mullion break the grid.
function paintFacade(styleIdx) {
  const wall = TOWER_WALLS[styleIdx % TOWER_WALLS.length];
  const size = 256;
  const { surface, g } = canvas2d(size);
  g.fillStyle = wall.wall;
  g.fillRect(0, 0, size, size);
  const paneW = size / FACADE_GRID_X;
  const paneH = size / FACADE_GRID_Y;
  for (let pane = 0; pane < FACADE_PANES; pane++) {
    const row = Math.floor(pane / FACADE_GRID_X);
    const col = pane % FACADE_GRID_X;
    const roll = (col * 31 + row * 17 + 7) % 97;
    const lit = roll % 5 < 2; // scattered light, not a lit wall
    const wx = col * paneW + paneW * 0.22;
    const wy = row * paneH + paneH * 0.26;
    const ww = paneW * 0.56;
    const wh = paneH * 0.46;
    g.fillStyle = wall.trim;
    g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
    g.fillStyle = lit ? wall.lit : wall.dark;
    g.fillRect(wx, wy, ww, wh);
    // Half-drawn blinds on some windows break up the grid repetition.
    if (roll % 7 < 3) {
      g.fillStyle = lit ? 'rgba(60,50,40,0.55)' : 'rgba(0,0,0,0.5)';
      g.fillRect(wx, wy, ww, wh * (0.25 + (roll % 10) * 0.05));
    }
    // One vertical mullion per window.
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(wx + ww / 2 - 1, wy, 2, wh);
    // The floor slab line closes each row, giving the facade a storey rhythm.
    if (col === FACADE_GRID_X - 1) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(0, row * paneH + paneH * 0.9, size, Math.max(2, paneH * 0.08));
    }
  }
  return asTexture(surface, { aniso: 8 });
}

// Ground-floor shopfront band: dark glass, mostly shutters, a few warm
// interiors, one restrained sign band per shop — bright only where open.
function paintShopfront(styleIdx) {
  const size = 256;
  const { surface, g } = canvas2d(size);
  g.fillStyle = '#101218';
  g.fillRect(0, 0, size, size);
  const SIGN_HUES = ['#e05a8a', '#58a8d8', '#d8b451', '#58b878'];
  for (let shop = 0; shop < 4; shop++) {
    const x = shop * (size / 4) + 8;
    const w = size / 4 - 16;
    if ((shop + styleIdx) % 3 === 0) {
      // Closed: roller shutter with louver lines.
      g.fillStyle = '#2a2d34';
      g.fillRect(x, 34, w, size - 62);
      for (let louver = 0; louver < 8; louver++) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, 34 + louver * ((size - 62) / 8), w, 3);
      }
    } else {
      // Open: warm (or cool) interior glow with shelf silhouettes.
      g.fillStyle = (shop + styleIdx) % 2 ? '#e8b878' : '#9cc4e0';
      g.fillRect(x, 34, w, size - 62);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(x, 34, w * 0.4, size - 62);
      g.fillStyle = 'rgba(0,0,0,0.6)';
      for (let shelf = 0; shelf < 3; shelf++) g.fillRect(x + 4, 80 + shelf * 42, w - 8, 6);
    }
    // Sign band above the door, one hue per shop.
    g.fillStyle = SIGN_HUES[(shop + styleIdx) % SIGN_HUES.length];
    g.fillRect(x, 8, w, 18);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x, 22, w, 4);
  }
  return asTexture(surface);
}

// Sidewalk paving: concrete slabs with joint lines and noise grit.
function paintPavement() {
  const size = 128;
  const { surface, g } = canvas2d(size);
  g.fillStyle = '#8f939c';
  g.fillRect(0, 0, size, size);
  for (let speck = 0; speck < 500; speck++) {
    const bright = grain01(speck) > 0.5;
    const gx = grain01(speck * 7 + 3);
    const gy = grain01(speck * 13 + 11);
    g.fillStyle = `rgba(${bright ? '255,255,255' : '0,0,0'},0.06)`;
    g.fillRect(gx * size, gy * size, 2, 2);
  }
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = 2;
  for (let joint = 0; joint <= 4; joint++) {
    const p = (joint / 4) * size;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  return asTexture(surface);
}

// Emissive twin of the facade grid: buildings glow at night without extra
// lights. Its pane grid and rects must match paintFacade's exactly, or lit
// panes and glow panes drift apart.
function paintGlow() {
  const size = 256;
  const { surface, g } = canvas2d(size);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);
  const paneW = size / FACADE_GRID_X;
  const paneH = size / FACADE_GRID_Y;
  for (let pane = 0; pane < FACADE_PANES; pane++) {
    const row = Math.floor(pane / FACADE_GRID_X);
    const col = pane % FACADE_GRID_X;
    if ((col * 31 + row * 17 + 7) % 97 % 4 === 0) continue;
    g.fillStyle = (col + row) % 3 === 0 ? '#ffd79a' : '#9fd6ff';
    g.fillRect(col * paneW + paneW * 0.22, row * paneH + paneH * 0.26, paneW * 0.56, paneH * 0.46);
  }
  // The glow map is linear data, not a colour swatch: no sRGB tagging.
  return asTexture(surface, { srgb: false });
}

// Deterministic asphalt roughness so light pools on the wet road land in the
// same speckle pattern between ?shot= replays of a seed.
function paintAsphaltRoughness() {
  const size = 128;
  const { surface, g } = canvas2d(size);
  g.fillStyle = '#c0c0c0';
  g.fillRect(0, 0, size, size);
  for (let grain = 0; grain < 900; grain++) {
    const level = 120 + Math.floor(grain01(grain * 3 + 1) * 130);
    g.fillStyle = `rgb(${level},${level},${level})`;
    g.fillRect(grain01(grain * 5 + 2) * size, grain01(grain * 11 + 4) * size, 3, 3);
  }
  const tex = asTexture(surface, { srgb: false });
  tex.repeat.set(24, 24);
  return tex;
}

// ---------------------------------------------------------------------------
// Box batcher: accumulates axis-aligned boxes into a single BufferGeometry,
// with per-face UV tiling and per-vertex tint. The underside is skipped by
// default — nothing looks at building undersides.
// ---------------------------------------------------------------------------
// One row per face: outward normal, u axis, v axis, face origin offset, and
// which size components span the face's u and v. Row order is the vertex
// emission order, so it is part of the output contract.
const FACE_TABLE = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], at: [1, 0, 0], spanU: 'z', spanV: 'y' },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], at: [-1, 0, 0], spanU: 'z', spanV: 'y' },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], at: [0, 1, 0], spanU: 'x', spanV: 'z' },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], at: [0, -1, 0], spanU: 'x', spanV: 'z' },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], at: [0, 0, 1], spanU: 'x', spanV: 'y' },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], at: [0, 0, -1], spanU: 'x', spanV: 'y' },
];
const UNDER_FACE = 3;
// Corner walk order keeps winding CCW seen from outside: u x v = n.
const CORNER_OFFSETS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
// Tiny normal-offset lifting each face off coincident geometry (shop bands, trim).
const SKIN = 0.01;

// Factory instead of a class: batches are plain accumulators, never inherited.
function makeBoxBatch() {
  const coords = [];
  const normals = [];
  const uvs = [];
  const tints = [];
  const triangles = [];
  let verts = 0;

  // Centre cx/cy/cz, full sizes sx/sy/sz, tint as a THREE.Color; uvTiles is a
  // number or an [horizontal, vertical] pair so facades tile windows with a
  // real aspect ratio.
  const add = (cx, cy, cz, sx, sy, sz, color, uvTiles = 6, underToo = false) => {
    const tileU = Array.isArray(uvTiles) ? uvTiles[0] : uvTiles;
    const tileV = Array.isArray(uvTiles) ? uvTiles[1] : uvTiles;
    const half = { x: sx / 2, y: sy / 2, z: sz / 2 };
    const span = { x: sx, y: sy, z: sz };

    for (let f = 0; f < FACE_TABLE.length; f++) {
      if (f === UNDER_FACE && !underToo) continue;
      const { n, u, v, at, spanU, spanV } = FACE_TABLE[f];
      const faceU = span[spanU];
      const faceV = span[spanV];
      const first = verts;
      for (const [su, sv] of CORNER_OFFSETS) {
        coords.push(
          cx + at[0] * half.x + u[0] * (faceU / 2) * su + v[0] * (faceV / 2) * sv + n[0] * SKIN,
          cy + at[1] * half.y + u[1] * (faceU / 2) * su + v[1] * (faceV / 2) * sv + n[1] * SKIN,
          cz + at[2] * half.z + u[2] * (faceU / 2) * su + v[2] * (faceV / 2) * sv + n[2] * SKIN
        );
        normals.push(n[0], n[1], n[2]);
        uvs.push((su * faceU) / tileU, (sv * faceV) / tileV);
        tints.push(color.r, color.g, color.b);
      }
      triangles.push(first, first + 1, first + 2, first, first + 2, first + 3);
      verts += 4;
    }
  };

  const build = () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(tints, 3));
    geo.setIndex(triangles);
    geo.computeBoundingSphere();
    return geo;
  };

  return { add, build, verts: () => verts };
}

// Tower body tints: muted city hues, jittered per building by lightness.
const TOWER_TINTS = [
  0x4b5a75, 0x6b6f86, 0x8a7f95, 0x3d4759, 0x9a8fa0, 0x5c6b82,
  0x7d6b78, 0x2f3746, 0x8e97a8, 0x6a5d6e,
];
// Neon accent hues shared by block pool lights and blade signs.
const NEON_HUES = [0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff];
const BLOOM_COLORS = [0xd94f6b, 0xe8c14f, 0xc95fd9, 0xe8e4ea];

// Building height curve: a base height, an edge-falloff range, and the rare
// downtown spike that punches a tower above the skyline.
const TOWER_MIN_H = 8;
const TOWER_FALLOFF_RANGE = 54;
const SPIKE_CHANCE = 0.12;
const SPIKE_BONUS = 30;

// ---------------------------------------------------------------------------
// City assembly
// ---------------------------------------------------------------------------

// Asphalt ground plane with a mild wet sheen; weather.js rides this material.
function layAsphalt(group) {
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2 + 80, HALF * 2 + 80),
    new THREE.MeshStandardMaterial({
      color: 0x1e2026,
      roughness: 0.72,
      metalness: 0.18,
      roughnessMap: paintAsphaltRoughness(),
    })
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  group.add(road);
  return road;
}

// One instanced raised slab per block covers sidewalk + lot footprint.
function makeSidewalkLayer() {
  const paving = paintPavement();
  paving.repeat.set(10, 10);
  return new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: paving, color: 0xb9bcc4, roughness: 0.92, metalness: 0.05 }),
    GRID_CELLS
  );
}

// Facade variants (brick / concrete / glass) plus their emissive night twin.
function makeFacadeMaterials(glowMap) {
  return [0, 1, 2].map((variant) => new THREE.MeshStandardMaterial({
    map: paintFacade(variant),
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.12,
    emissive: 0xffffff,
    emissiveMap: glowMap,
    emissiveIntensity: 0.0, // main.js drives this with the day/night clock
  }));
}

// Shopfront band materials; the diffuse and emissive maps are painted twice on
// purpose so each gets its own texture upload.
function makeShopMaterials() {
  return [0, 1, 2].map((variant) => new THREE.MeshStandardMaterial({
    map: paintShopfront(variant),
    emissive: 0xffffff,
    emissiveMap: paintShopfront(variant),
    emissiveIntensity: 0.0,
  }));
}

// One merged mesh per facade style so texture variants coexist cheaply.
function mergeBatches(group, batches, materials, { cast = true, receive = true } = {}) {
  batches.forEach((batch, variant) => {
    if (batch.verts() === 0) return;
    const mesh = new THREE.Mesh(batch.build(), materials[variant]);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    group.add(mesh);
  });
}

export function buildCity(scene, rng) {
  const group = new THREE.Group();
  scene.add(group);

  const road = layAsphalt(group);
  const walkBatch = makeSidewalkLayer();

  const glowMap = paintGlow();
  const buildingMats = makeFacadeMaterials(glowMap);
  const shopMats = makeShopMaterials();

  const towers = [makeBoxBatch(), makeBoxBatch(), makeBoxBatch()];
  const shops = [makeBoxBatch(), makeBoxBatch(), makeBoxBatch()];
  const trim = makeBoxBatch();
  const solids = [];       // AABB colliders {minX, maxX, minZ, maxZ, h}
  const lamps = [];
  const parkSpots = [];

  // Walk the grid row by row. b counts blocks in the same i-then-j order the
  // street grid is laid out in, and doubles as the sidewalk instance index.
  for (let b = 0; b < GRID_CELLS; b++) {
    const i = Math.floor(b / WORLD.blocks);
    const j = b % WORLD.blocks;
    const cx = -HALF + (i + 0.5) * WORLD.lotSize;
    const cz = -HALF + (j + 0.5) * WORLD.lotSize;

    walkBatch.setMatrixAt(
      b,
      new THREE.Matrix4().compose(
        new THREE.Vector3(cx, 0.09, cz),
        new THREE.Quaternion(),
        new THREE.Vector3(WORLD.lotSize - WORLD.roadWidth, 0.18, WORLD.lotSize - WORLD.roadWidth)
      )
    );

    if (rng() < 0.12) {
      plantPark(group, rng, cx, cz, CELL_INNER, solids, parkSpots);
      continue;
    }

    raiseBlockBuildings(rng, cx, cz, CELL_INNER, HALF, towers, shops, trim, solids);

    // One or two lamps per block, parked on street corners for pooled light.
    if (rng() < 0.85) {
      lamps.push({
        x: cx + (rng() < 0.5 ? -1 : 1) * LAMP_REACH,
        z: cz + (rng() < 0.5 ? -1 : 1) * LAMP_REACH,
      });
    }
    if (rng() < 0.6) {
      lamps.push({
        x: cx + (rng() < 0.5 ? -1 : 1) * LAMP_REACH,
        z: cz - (rng() < 0.5 ? -1 : 1) * LAMP_REACH,
      });
    }
  }
  walkBatch.instanceMatrix.needsUpdate = true;
  walkBatch.receiveShadow = true;
  group.add(walkBatch);

  mergeBatches(group, towers, buildingMats);
  mergeBatches(group, shops, shopMats);
  const trimMesh = new THREE.Mesh(trim.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }));
  trimMesh.castShadow = true;
  group.add(trimMesh);

  // Lamp posts: merged poles plus one instanced emissive bulb mesh (dimmed by day).
  const bulbMesh = mergeLampPosts(group, lamps, solids);

  scatterStreetProps(group, rng, CELL_INNER, CURB_EDGE, solids);
  const neonLights = addNeonPools(group);

  paintRoadMarkings(group);
  paintCrossings(group);

  dressRooflines(group, rng, solids);
  placeTrafficSignals(group, rng, INTERSECTIONS, solids);
  const signMeshes = hangBladeSigns(group, rng, solids);

  return {
    group,
    road,
    solids,
    lamps,
    bulbMesh,
    buildingMats,
    shopMats,
    neonLights,
    signMeshes,
    parkSpots,
    half: HALF,
    roadLines: buildRoadLines(),
  };
}

// Small park cell: grass slab, worn patches, flowerbeds, shade trees.
function plantPark(group, rng, cx, cz, cellInner, solids, parkSpots) {
  const grass = makeBoxBatch();
  const lawnGreen = new THREE.Color(0x2d4a33).offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.06);
  grass.add(cx, 0.2, cz, cellInner, 0.2, cellInner, lawnGreen, 8, true);
  for (let patch = 0; patch < 3; patch++) {
    grass.add(
      cx + (rng() - 0.5) * cellInner * 0.6, 0.21, cz + (rng() - 0.5) * cellInner * 0.6,
      6 + rng() * 8, 0.06, 5 + rng() * 6, new THREE.Color(0x223a28), 6
    );
  }
  for (let bed = 0; bed < 4; bed++) {
    const bedX = cx + (rng() - 0.5) * (cellInner - 10);
    const bedZ = cz + (rng() - 0.5) * (cellInner - 10);
    grass.add(bedX, 0.26, bedZ, 5 + rng() * 4, 0.16, 2.2 + rng() * 1.4, new THREE.Color(0x3a2c22), 4);
    for (let bloom = 0; bloom < 7; bloom++) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.16 + rng() * 0.08, 6, 5),
        new THREE.MeshStandardMaterial({ color: BLOOM_COLORS[Math.floor(rng() * BLOOM_COLORS.length)], roughness: 0.7 })
      );
      dot.position.set(bedX + (rng() - 0.5) * 5, 0.42, bedZ + (rng() - 0.5) * 2);
      group.add(dot);
    }
  }
  const lawn = new THREE.Mesh(grass.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 }));
  lawn.receiveShadow = true;
  group.add(lawn);

  const treeCount = Math.max(3, Math.floor(rng() * 5) + 3);
  for (let tree = 0; tree < treeCount; tree++) {
    const tx = cx + (rng() - 0.5) * (cellInner - 8);
    const tz = cz + (rng() - 0.5) * (cellInner - 8);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.36, 3.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 })
    );
    trunk.position.set(tx, 1.8, tz);
    group.add(trunk);
    const canopy = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.1 + rng() * 0.9, 0),
      new THREE.MeshStandardMaterial({ color: 0x2f6b3f, roughness: 0.95, flatShading: true })
    );
    canopy.position.set(tx, 4.2, tz);
    canopy.castShadow = true;
    group.add(canopy);
    solids.push({ minX: tx - 0.6, maxX: tx + 0.6, minZ: tz - 0.6, maxZ: tz + 0.6, h: 5 });
  }
  parkSpots.push({ x: cx, z: cz });
}

// How one block's lot splits into building footprints: a whole-lot tower, two
// side-by-side slabs, or three mixed lots.
function splitLot(cx, cz, cellInner, splits) {
  if (splits === 1) return [[cx, cz, cellInner * 0.86, cellInner * 0.86]];
  if (splits === 2) {
    const w = cellInner * 0.45;
    return [
      [cx - cellInner * 0.26, cz, w, cellInner * 0.9],
      [cx + cellInner * 0.26, cz, w, cellInner * 0.9],
    ];
  }
  const w = cellInner * 0.44;
  return [
    [cx - cellInner * 0.27, cz - cellInner * 0.27, w, w],
    [cx + cellInner * 0.27, cz - cellInner * 0.2, w, w * 0.95],
    [cx - cellInner * 0.1, cz + cellInner * 0.28, cellInner * 0.9, w * 0.9],
  ];
}

// 1-3 towers per block, dressed with parapet, setback tier, cornice band,
// entrance canopy and a glowing ground-floor shopfront.
function raiseBlockBuildings(rng, cx, cz, cellInner, half, towers, shops, trim, solids) {
  const firstRoll = rng();
  const splits = firstRoll < 0.45 ? 1 : (rng() < 0.6 ? 2 : 3);

  for (const [bx, bz, bw, bd] of splitLot(cx, cz, cellInner, splits)) {
    // Height falls off toward the map edge, with a rare downtown spike.
    const dist = Math.hypot(bx, bz) / half;
    const falloff = rng() * (1 - dist * 0.6) * TOWER_FALLOFF_RANGE;
    const spike = rng() < SPIKE_CHANCE ? SPIKE_BONUS : 0;
    const h = TOWER_MIN_H + falloff + spike;
    const col = new THREE.Color(TOWER_TINTS[Math.floor(rng() * TOWER_TINTS.length)]);
    col.offsetHSL(0, 0, (rng() - 0.5) * 0.08);
    const styleIdx = Math.floor(rng() * 3);

    towers[styleIdx].add(bx, h / 2 + 0.2, bz, bw, h, bd, col, [4.2, 4.8]);
    trim.add(bx, h + 0.6, bz, bw * 1.02, 0.8, bd * 1.02, new THREE.Color(0x22262f), 4);
    // Setback tier on taller buildings gives the skyline real steps.
    if (h > 24 && rng() < 0.7) {
      const upperH = h * (0.22 + rng() * 0.16);
      towers[styleIdx].add(bx, h + upperH / 2 + 0.9, bz, bw * 0.62, upperH, bd * 0.62, col, [4.2, 4.8]);
      trim.add(bx, h + upperH + 1.2, bz, bw * 0.64, 0.6, bd * 0.64, new THREE.Color(0x22262f), 4);
    }
    // Mid-facade cornice, street-facing entrance canopy, shopfront band.
    trim.add(bx, h * 0.55, bz, bw * 1.04, 0.5, bd * 1.04, new THREE.Color(0x1a1e26), 4);
    trim.add(bx, 3.3, bz + bd / 2 + 0.9, bw * 0.34, 0.22, 1.9, new THREE.Color(0x30353f), 4);
    shops[styleIdx].add(bx, 1.5, bz, bw * 1.01, 3.0, bd * 1.01, new THREE.Color(0xffffff), 4);
    solids.push({ minX: bx - bw / 2, maxX: bx + bw / 2, minZ: bz - bd / 2, maxZ: bz + bd / 2, h });
  }
}

// Merged dark poles plus an instanced bulb mesh main.js dims during the day.
function mergeLampPosts(group, lamps, solids) {
  const poleBatch = makeBoxBatch();
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffd79a, emissive: 0xffd79a, emissiveIntensity: 1.4 });
  const bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.33, 8, 6), bulbMat, lamps.length);
  const bulbMatrix = new THREE.Matrix4();
  const upright = new THREE.Quaternion();
  lamps.forEach((lamp, k) => {
    poleBatch.add(lamp.x, 3.1, lamp.z, 0.28, 6.2, 0.28, new THREE.Color(0x262b34), 2);
    bulbMatrix.compose(new THREE.Vector3(lamp.x, 6.3, lamp.z), upright, new THREE.Vector3(1, 1, 1));
    bulbMesh.setMatrixAt(k, bulbMatrix);
    solids.push({ minX: lamp.x - 0.4, maxX: lamp.x + 0.4, minZ: lamp.z - 0.4, maxZ: lamp.z + 0.4, h: 6 });
  });
  bulbMesh.instanceMatrix.needsUpdate = true;
  if (lamps.length) group.add(bulbMesh);
  group.add(new THREE.Mesh(poleBatch.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 })));
  return bulbMesh;
}

// Hydrants, trash bins and parked bikes scattered along the block edges.
function scatterStreetProps(group, rng, cellInner, curbEdge, solids) {
  const propBatch = makeBoxBatch();
  const bikeWheelGeo = new THREE.TorusGeometry(0.34, 0.06, 8, 14);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.9 });
  const bikeMat = new THREE.MeshStandardMaterial({ color: 0x3e6fa8, roughness: 0.5, metalness: 0.6 });

  for (let b = 0; b < GRID_CELLS; b++) {
    const i = Math.floor(b / WORLD.blocks);
    const j = b % WORLD.blocks;
    const cx = -HALF + (i + 0.5) * WORLD.lotSize;
    const cz = -HALF + (j + 0.5) * WORLD.lotSize;
    if (rng() < 0.45) {
      const hx = cx + (rng() - 0.5) * cellInner;
      const hz = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.6);
      propBatch.add(hx, 0.35, hz, 0.26, 0.5, 0.26, new THREE.Color(0xc23b2e), 2);
      propBatch.add(hx, 0.66, hz, 0.36, 0.14, 0.36, new THREE.Color(0xa33328), 2);
    }
    if (rng() < 0.5) {
      const binX = cx + (rng() - 0.5) * cellInner;
      const binZ = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.8);
      propBatch.add(binX, 0.55, binZ, 0.7, 1.0, 0.7, new THREE.Color(0x2e4436), 2);
      propBatch.add(binX, 1.1, binZ, 0.8, 0.1, 0.8, new THREE.Color(0x1e2e24), 2);
    }
    if (rng() < 0.3) {
      const bikeX = cx + (rng() - 0.5) * cellInner;
      const bikeZ = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.5);
      const bike = new THREE.Group();
      for (const side of [-1, 1]) {
        const wheel = new THREE.Mesh(bikeWheelGeo, tireMat);
        wheel.position.set(0, 0.34, side * 0.5);
        bike.add(wheel);
      }
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 1.0), bikeMat);
      frame.position.y = 0.55;
      bike.add(frame);
      bike.position.set(bikeX, 0.18, bikeZ);
      bike.rotation.y = rng() * Math.PI;
      bike.castShadow = true;
      group.add(bike);
    }
  }
  group.add(new THREE.Mesh(propBatch.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 })));
}

// One low-intensity PointLight per 2x2 block cluster, tinted per cluster and
// driven at night by main.js — bounded cost, streets still glow after dusk.
function addNeonPools(group) {
  const poolLights = [];
  for (let i = 0; i < WORLD.blocks; i += 2) {
    for (let j = 0; j < WORLD.blocks; j += 2) {
      const pool = new THREE.PointLight(NEON_HUES[(i + j) % 4], 0, 55, 2);
      pool.position.set(-HALF + (i + 1) * WORLD.lotSize, 9, -HALF + (j + 1) * WORLD.lotSize);
      group.add(pool);
      poolLights.push(pool);
    }
  }
  return poolLights;
}

// Dashed yellow centre lines along every street, both axes.
function paintRoadMarkings(group) {
  const marks = makeBoxBatch();
  const yellow = new THREE.Color(0xd8b451);
  for (let i = 0; i < INTERSECTIONS; i++) {
    const line = -HALF + i * WORLD.lotSize;
    for (let j = 0; j < WORLD.blocks; j++) {
      const mid = -HALF + j * WORLD.lotSize + WORLD.lotSize / 2;
      marks.add(line - 0.18, 0.02, mid, 0.36, 0.02, 4.5, yellow, 4);
      marks.add(mid, 0.02, line + 0.18, 4.5, 0.02, 0.36, yellow, 4);
    }
  }
  group.add(new THREE.Mesh(marks.build(), new THREE.MeshBasicMaterial({ vertexColors: true })));
}

// Crosswalk stripes across each approach of every intersection.
function paintCrossings(group) {
  const stripes = makeBoxBatch();
  const white = new THREE.Color(0xd9dde2);
  for (let i = 0; i < INTERSECTIONS; i++) {
    const line = -HALF + i * WORLD.lotSize;
    for (let j = 0; j < WORLD.blocks; j++) {
      const mid = -HALF + j * WORLD.lotSize + WORLD.lotSize / 2;
      for (let step = -3; step <= 3; step++) {
        stripes.add(line + step * 1.7, 0.021, mid + 7.4, 0.9, 0.015, 2.6, white, 4);
        stripes.add(line + step * 1.7, 0.021, mid - 7.4, 0.9, 0.015, 2.6, white, 4);
        stripes.add(mid + 7.4, 0.021, line + step * 1.7, 2.6, 0.015, 0.9, white, 4);
        stripes.add(mid - 7.4, 0.021, line + step * 1.7, 2.6, 0.015, 0.9, white, 4);
      }
    }
  }
  group.add(new THREE.Mesh(stripes.build(), new THREE.MeshBasicMaterial({ vertexColors: true })));
}

// AC units, water tanks and antennas on the taller rooftops.
function dressRooflines(group, rng, solids) {
  const roofBatch = makeBoxBatch();
  const roofDetail = new THREE.Color(0x3a3f4a);
  const antennaGeo = new THREE.CylinderGeometry(0.05, 0.08, 6, 5);
  const antennaMat = new THREE.MeshStandardMaterial({ color: 0x565b66, roughness: 0.6, metalness: 0.7 });

  for (const s of solids) {
    if (s.h < 16 || rng() > 0.7) continue;
    const midX = (s.minX + s.maxX) / 2;
    const midZ = (s.minZ + s.maxZ) / 2;
    const w = s.maxX - s.minX;
    const d = s.maxZ - s.minZ;
    if (rng() < 0.7) {
      roofBatch.add(midX + (rng() - 0.5) * w * 0.3, s.h + 0.55, midZ + (rng() - 0.5) * d * 0.3,
        2.2, 1.0, 1.6, roofDetail, 3);
    }
    if (rng() < 0.4) {
      roofBatch.add(midX + (rng() - 0.5) * w * 0.3, s.h + 1.1, midZ + (rng() - 0.5) * d * 0.3,
        1.4, 1.6, 1.4, roofDetail, 3);
    }
    if (s.h > 30 && rng() < 0.5) {
      const antenna = new THREE.Mesh(antennaGeo, antennaMat);
      antenna.position.set(midX, s.h + 3, midZ);
      group.add(antenna);
    }
  }
  const roofMesh = new THREE.Mesh(roofBatch.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  roofMesh.castShadow = true;
  group.add(roofMesh);
}

// Traffic signals at a third of intersections (green lamp lit, arcade style).
function placeTrafficSignals(group, rng, nb, solids) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x262a32, roughness: 0.7, metalness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x30ff50, emissive: 0x20ff40, emissiveIntensity: 2 });
  const headGeo = new THREE.BoxGeometry(0.5, 1.3, 0.4);
  for (let i = 0; i < nb; i += 3) {
    for (let j = 0; j < nb; j += 3) {
      if (rng() > 0.6) continue;
      const px = -HALF + i * WORLD.lotSize + 9;
      const pz = -HALF + j * WORLD.lotSize + 9;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 5.4, 8), poleMat);
      pole.position.set(px, 2.7, pz);
      group.add(pole);
      const head = new THREE.Mesh(headGeo, poleMat);
      head.position.set(px, 5.6, pz);
      group.add(head);
      const green = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), lampMat);
      green.position.set(px, 5.3, pz + 0.22);
      group.add(green);
      solids.push({ minX: px - 0.3, maxX: px + 0.3, minZ: pz - 0.3, maxZ: pz + 0.3, h: 6 });
    }
  }
}

// Vertical neon blade signs on a fraction of tower corners; main.js flickers
// them after dusk using userData.phase.
function hangBladeSigns(group, rng, solids) {
  const signGeo = new THREE.BoxGeometry(1.4, 7.5, 0.5);
  const signMeshes = [];
  for (const s of solids) {
    if (rng() > 0.22 || s.h < 14) continue;
    const mat = new THREE.MeshBasicMaterial({ color: NEON_HUES[Math.floor(rng() * NEON_HUES.length)] });
    const sign = new THREE.Mesh(signGeo, mat);
    const side = rng() < 0.5 ? 1 : -1;
    sign.position.set((s.minX + s.maxX) / 2 + side * (s.maxX - s.minX) / 2, s.h * 0.62, (s.minZ + s.maxZ) / 2);
    sign.rotation.y = rng() * Math.PI;
    sign.scale.y = Math.min(2.2, s.h / 14);
    group.add(sign);
    sign.userData.phase = signMeshes.length * 1.7;
    signMeshes.push(sign);
  }
  return signMeshes;
}

// ---------------------------------------------------------------------------
// Street graph
// ---------------------------------------------------------------------------

// Street centre lines used by traffic AI: one entry per grid line, both axes.
export function buildRoadLines() {
  const lines = [];
  for (let i = 0; i < INTERSECTIONS; i++) {
    const c = -HALF + i * WORLD.lotSize;
    lines.push({ axis: 'z', line: c });
    lines.push({ axis: 'x', line: c });
  }
  return lines;
}

// Snap a world position onto the nearest lane; used for spawning traffic and
// cops. Equidistant ties fall to the 'x' branch so spawning stays stable.
export function nearestLane(x, z) {
  const pitch = WORLD.lotSize;
  const distX = Math.abs(x - (-HALF + Math.round((x + HALF) / pitch) * pitch));
  const distZ = Math.abs(z - (-HALF + Math.round((z + HALF) / pitch) * pitch));
  const lx = -HALF + Math.round((x + HALF) / pitch) * pitch;
  const lz = -HALF + Math.round((z + HALF) / pitch) * pitch;
  if (distX < distZ) return { axis: 'z', line: lx, along: z };
  return { axis: 'x', line: lz, along: x };
}
