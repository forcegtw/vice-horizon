// city.js — procedural Vice City: a grid of blocks separated by streets, each block
// packed with slab towers (or a park), plus lamp posts, storefronts, street props,
// road paint and rooftop clutter. All static geometry is merged into a handful of
// draw calls via BoxBatch so the whole town stays cheap on a laptop GPU.
// HALF is the half-extent of the street grid, derived once here and exported:
// every other system (traffic, peds, missions, minimap) clamps against it instead
// of re-deriving bounds. Block layout is drawn from the caller's seeded rng, so
// the city shape is reproducible for a given seed across reloads.

import * as THREE from '../vendor/three.min.js';
import { WORLD } from './config.js';

const HALF = (WORLD.blocks * WORLD.lotSize) / 2;

// ---------------------------------------------------------------------------
// Canvas textures, painted once at boot. The speckle() integer hash replaces
// Math.random so grit patterns are identical across reloads for a given seed.
// ---------------------------------------------------------------------------
function speckle(i) {
  const h = (i * 2654435761) >>> 0;
  return (h % 1000) / 1000;
}

// Facade wall styles: [brick red, concrete gray, glass-blue tower].
const FACADE_STYLES = [
  { wall: '#7d5040', trim: '#5e3d32', lit: '#f5d9a8', dark: '#191c24' },
  { wall: '#8b9099', trim: '#6f747d', lit: '#d6e6f5', dark: '#151920' },
  { wall: '#38506e', trim: '#283c56', lit: '#b8d8f0', dark: '#0f1622' },
];

// Window grid density: 7 x 9 per tile reads as windows at street level without
// turning into noise when a tower repeats this texture up its full height.
const FACADE_COLS = 7;
const FACADE_ROWS = 9;

function facadeTexture(styleIdx) {
  const s = FACADE_STYLES[styleIdx % FACADE_STYLES.length];
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = s.wall;
  g.fillRect(0, 0, size, size);
  const cw = size / FACADE_COLS, ch = size / FACADE_ROWS;
  for (let y = 0; y < FACADE_ROWS; y++) {
    for (let x = 0; x < FACADE_COLS; x++) {
      const roll = ((x * 31 + y * 17 + 7) % 97);
      const lit = roll % 5 < 2; // ~40% lit panes: scattered light, not a lit wall
      const wx = x * cw + cw * 0.22, wy = y * ch + ch * 0.26;
      const ww = cw * 0.56, wh = ch * 0.46;
      g.fillStyle = s.trim;
      g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
      g.fillStyle = lit ? s.lit : s.dark;
      g.fillRect(wx, wy, ww, wh);
      // Half-drawn blinds on some windows break up the grid repetition.
      if (roll % 7 < 3) {
        g.fillStyle = lit ? 'rgba(60,50,40,0.55)' : 'rgba(0,0,0,0.5)';
        g.fillRect(wx, wy, ww, wh * (0.25 + (roll % 10) * 0.05));
      }
      // One vertical mullion per window.
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(wx + ww / 2 - 1, wy, 2, wh);
    }
    // Floor slab line gives the facade a readable storey rhythm.
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(0, y * ch + ch * 0.9, size, Math.max(2, ch * 0.08));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Ground-floor shopfront band: dark glass, mostly shutters, a few warm interiors,
// one restrained sign band per shop — bright only where a shop is "open".
function shopfrontTexture(styleIdx) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#101218';
  g.fillRect(0, 0, size, size);
  const SIGN_HUES = ['#e05a8a', '#58a8d8', '#d8b451', '#58b878'];
  for (let i = 0; i < 4; i++) {
    const x = i * (size / 4) + 8;
    const w = size / 4 - 16;
    if ((i + styleIdx) % 3 === 0) {
      // Closed: roller shutter with louver lines.
      g.fillStyle = '#2a2d34';
      g.fillRect(x, 34, w, size - 62);
      for (let l = 0; l < 8; l++) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, 34 + l * ((size - 62) / 8), w, 3);
      }
    } else {
      // Open: warm (or cool) interior glow with shelf silhouettes.
      g.fillStyle = (i + styleIdx) % 2 ? '#e8b878' : '#9cc4e0';
      g.fillRect(x, 34, w, size - 62);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(x, 34, w * 0.4, size - 62);
      g.fillStyle = 'rgba(0,0,0,0.6)';
      for (let sh = 0; sh < 3; sh++) g.fillRect(x + 4, 80 + sh * 42, w - 8, 6);
    }
    // Sign band above the door, one hue per shop.
    g.fillStyle = SIGN_HUES[(i + styleIdx) % SIGN_HUES.length];
    g.fillRect(x, 8, w, 18);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x, 22, w, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Sidewalk paving: concrete slabs with joint lines and noise grit.
function pavementTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#8f939c';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 500; i++) {
    const bright = speckle(i) > 0.5;
    const r2 = speckle(i * 7 + 3), r3 = speckle(i * 13 + 11);
    g.fillStyle = `rgba(${bright ? '255,255,255' : '0,0,0'},0.06)`;
    g.fillRect(r2 * size, r3 * size, 2, 2);
  }
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * size;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Emissive twin of the facade grid: buildings glow at night without extra lights.
// Must match facadeTexture's grid and pane rects, or lit panes and glow panes drift.
function glowTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);
  const cw = size / FACADE_COLS, ch = size / FACADE_ROWS;
  for (let y = 0; y < FACADE_ROWS; y++) {
    for (let x = 0; x < FACADE_COLS; x++) {
      const roll = ((x * 31 + y * 17 + 7) % 97);
      if (roll % 4 === 0) continue;
      g.fillStyle = (x + y) % 3 === 0 ? '#ffd79a' : '#9fd6ff';
      g.fillRect(x * cw + cw * 0.22, y * ch + ch * 0.26, cw * 0.56, ch * 0.46);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Deterministic asphalt roughness so light pools on the wet road are identical
// between ?shot= replays of the same seed.
function asphaltRoughnessTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#c0c0c0';
  g.fillRect(0, 0, s, s);
  for (let n = 0; n < 900; n++) {
    const v = 120 + Math.floor(speckle(n * 3 + 1) * 130);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(speckle(n * 5 + 2) * s, speckle(n * 11 + 4) * s, 3, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  return t;
}

// ---------------------------------------------------------------------------
// BoxBatch: accumulates axis-aligned boxes into one BufferGeometry, with per-face
// UV scaling (tiling) and optional per-vertex tinting via the color attribute.
// The bottom face is skipped by default — nothing looks at building undersides.
// ---------------------------------------------------------------------------
const BOX_FACES = [
  // normal, u axis, v axis, face origin offset, face width (u), face height (v)
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], off: [1, 0, 0], uw: 'z', vh: 'y' },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], off: [-1, 0, 0], uw: 'z', vh: 'y' },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], off: [0, 1, 0], uw: 'x', vh: 'z' },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], off: [0, -1, 0], uw: 'x', vh: 'z' },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], off: [0, 0, 1], uw: 'x', vh: 'y' },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], off: [0, 0, -1], uw: 'x', vh: 'y' },
];
const BOTTOM_FACE = 3;
// Corner walk order (su, sv) keeps winding CCW seen from outside: u x v = n.
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
// Tiny normal-offset lifts each face off coincident geometry (shop bands, trim).
const FACE_EPSILON = 0.01;

class BoxBatch {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.vcount = 0;
  }

  // cx/cy/cz centre, sx/sy/sz full sizes, uvScale a number or [horizontal, vertical]
  // pair so facades can tile windows with a real aspect ratio.
  add(cx, cy, cz, sx, sy, sz, color, uvScale = 6, bottomToo = false) {
    const uvs = Array.isArray(uvScale) ? uvScale[0] : uvScale;
    const uvv = Array.isArray(uvScale) ? uvScale[1] : uvScale;
    const half = { x: sx / 2, y: sy / 2, z: sz / 2 };
    const faceSpan = { x: sx, y: sy, z: sz };

    for (let f = 0; f < BOX_FACES.length; f++) {
      if (f === BOTTOM_FACE && !bottomToo) continue;
      const { n, u, v, off, uw, vh } = BOX_FACES[f];
      const fu = faceSpan[uw], fv = faceSpan[vh];
      const base = this.vcount;
      for (const [su, sv] of CORNERS) {
        this.pos.push(
          cx + off[0] * half.x + u[0] * (fu / 2) * su + v[0] * (fv / 2) * sv + n[0] * FACE_EPSILON,
          cy + off[1] * half.y + u[1] * (fu / 2) * su + v[1] * (fv / 2) * sv + n[1] * FACE_EPSILON,
          cz + off[2] * half.z + u[2] * (fu / 2) * su + v[2] * (fv / 2) * sv + n[2] * FACE_EPSILON
        );
        this.nrm.push(n[0], n[1], n[2]);
        this.uv.push((su * fu) / uvs, (sv * fv) / uvv);
        this.col.push(color.r, color.g, color.b);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      this.vcount += 4;
    }
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

// Tower body tints: muted city hues, jittered per building by lightness.
const PALETTE = [
  0x4b5a75, 0x6b6f86, 0x8a7f95, 0x3d4759, 0x9a8fa0, 0x5c6b82,
  0x7d6b78, 0x2f3746, 0x8e97a8, 0x6a5d6e,
];
// Neon accent colours shared by block pool lights and blade signs.
const NEON_TINTS = [0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff];
const FLOWER_COLORS = [0xd94f6b, 0xe8c14f, 0xc95fd9, 0xe8e4ea];

// ---------------------------------------------------------------------------
// City builder
// ---------------------------------------------------------------------------
export function buildCity(scene, rng) {
  const group = new THREE.Group();
  scene.add(group);

  // Asphalt ground plane with a mild wet sheen; weather.js rides this material.
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2 + 80, HALF * 2 + 80),
    new THREE.MeshStandardMaterial({
      color: 0x1e2026,
      roughness: 0.72,
      metalness: 0.18,
      roughnessMap: asphaltRoughnessTexture(),
    })
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  group.add(road);

  // One instanced raised slab per block covers sidewalk + lot footprint.
  const pavementTex = pavementTexture();
  pavementTex.repeat.set(10, 10);
  const walkBatch = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: pavementTex, color: 0xb9bcc4, roughness: 0.92, metalness: 0.05 }),
    WORLD.blocks * WORLD.blocks
  );
  const m4 = new THREE.Matrix4();
  const q0 = new THREE.Quaternion();

  // Facade variants (brick / concrete / glass) plus their emissive night twin.
  const glow = glowTexture();
  const buildingMats = [0, 1, 2].map((k) => new THREE.MeshStandardMaterial({
    map: facadeTexture(k),
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.12,
    emissive: 0xffffff,
    emissiveMap: glow,
    emissiveIntensity: 0.0, // main.js drives this with the day/night clock
  }));
  const shopMats = [0, 1, 2].map((k) => new THREE.MeshStandardMaterial({
    map: shopfrontTexture(k),
    emissive: 0xffffff,
    emissiveMap: shopfrontTexture(k),
    emissiveIntensity: 0.0,
  }));

  const towers = [new BoxBatch(), new BoxBatch(), new BoxBatch()];
  const shops = [new BoxBatch(), new BoxBatch(), new BoxBatch()];
  const trim = new BoxBatch();
  const solids = [];       // AABB colliders {minX, maxX, minZ, maxZ, h}
  const lamps = [];
  const parkSpots = [];
  let walkInst = 0;

  const cellInner = WORLD.lotSize - WORLD.roadWidth - WORLD.sidewalk * 2;
  const lampReach = cellInner / 2 + 2.4;
  const curbEdge = WORLD.lotSize / 2 - WORLD.roadWidth / 2;

  for (let i = 0; i < WORLD.blocks; i++) {
    for (let j = 0; j < WORLD.blocks; j++) {
      const cx = -HALF + (i + 0.5) * WORLD.lotSize;
      const cz = -HALF + (j + 0.5) * WORLD.lotSize;

      m4.compose(
        new THREE.Vector3(cx, 0.09, cz),
        q0,
        new THREE.Vector3(WORLD.lotSize - WORLD.roadWidth, 0.18, WORLD.lotSize - WORLD.roadWidth)
      );
      walkBatch.setMatrixAt(walkInst++, m4);

      if (rng() < 0.12) {
        buildPark(group, rng, cx, cz, cellInner, solids, parkSpots);
        continue;
      }

      buildBlockTowers(rng, cx, cz, cellInner, HALF, towers, shops, trim, solids);

      // One or two lamps per block, parked on street corners for pooled light.
      if (rng() < 0.85) {
        lamps.push({
          x: cx + (rng() < 0.5 ? -1 : 1) * lampReach,
          z: cz + (rng() < 0.5 ? -1 : 1) * lampReach,
        });
      }
      if (rng() < 0.6) {
        lamps.push({
          x: cx + (rng() < 0.5 ? -1 : 1) * lampReach,
          z: cz - (rng() < 0.5 ? -1 : 1) * lampReach,
        });
      }
    }
  }
  walkBatch.instanceMatrix.needsUpdate = true;
  walkBatch.receiveShadow = true;
  group.add(walkBatch);

  // One merged mesh per facade style so texture variants coexist cheaply.
  towers.forEach((batch, s) => {
    if (!batch.vcount) return;
    const m = new THREE.Mesh(batch.build(), buildingMats[s]);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  });
  shops.forEach((batch, s) => {
    if (!batch.vcount) return;
    const m = new THREE.Mesh(batch.build(), shopMats[s]);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  });
  const trimMesh = new THREE.Mesh(trim.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }));
  trimMesh.castShadow = true;
  group.add(trimMesh);

  // Lamp posts: merged poles plus one instanced emissive bulb mesh (dimmed by day).
  const bulbMesh = buildLampPosts(group, lamps, m4, q0, solids);

  buildStreetProps(group, rng, cellInner, curbEdge, solids);
  const neonLights = buildNeonPools(group);

  // Road paint: dashed centre lines along every street, both axes.
  const marks = new BoxBatch();
  const yellow = new THREE.Color(0xd8b451);
  const nb = WORLD.blocks + 1;
  for (let i = 0; i < nb; i++) {
    const c = -HALF + i * WORLD.lotSize;
    for (let j = 0; j < WORLD.blocks; j++) {
      const mid = -HALF + j * WORLD.lotSize + WORLD.lotSize / 2;
      marks.add(c - 0.18, 0.02, mid, 0.36, 0.02, 4.5, yellow, 4);
      marks.add(mid, 0.02, c + 0.18, 4.5, 0.02, 0.36, yellow, 4);
    }
  }
  group.add(new THREE.Mesh(marks.build(), new THREE.MeshBasicMaterial({ vertexColors: true })));

  // Crosswalk stripes across each approach of every intersection.
  const cross = new BoxBatch();
  const white = new THREE.Color(0xd9dde2);
  for (let i = 0; i < nb; i++) {
    const c = -HALF + i * WORLD.lotSize;
    for (let j = 0; j < WORLD.blocks; j++) {
      const mid = -HALF + j * WORLD.lotSize + WORLD.lotSize / 2;
      for (let k = -3; k <= 3; k++) {
        cross.add(c + k * 1.7, 0.021, mid + 7.4, 0.9, 0.015, 2.6, white, 4);
        cross.add(c + k * 1.7, 0.021, mid - 7.4, 0.9, 0.015, 2.6, white, 4);
        cross.add(mid + 7.4, 0.021, c + k * 1.7, 2.6, 0.015, 0.9, white, 4);
        cross.add(mid - 7.4, 0.021, c + k * 1.7, 2.6, 0.015, 0.9, white, 4);
      }
    }
  }
  group.add(new THREE.Mesh(cross.build(), new THREE.MeshBasicMaterial({ vertexColors: true })));

  buildRoofDetails(group, rng, solids);
  buildTrafficLights(group, rng, nb, solids);
  const signMeshes = buildNeonSigns(group, rng, solids);

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
function buildPark(group, rng, cx, cz, cellInner, solids, parkSpots) {
  const grass = new BoxBatch();
  const baseGreen = new THREE.Color(0x2d4a33).offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.06);
  grass.add(cx, 0.2, cz, cellInner, 0.2, cellInner, baseGreen, 8, true);
  for (let p = 0; p < 3; p++) {
    grass.add(
      cx + (rng() - 0.5) * cellInner * 0.6, 0.21, cz + (rng() - 0.5) * cellInner * 0.6,
      6 + rng() * 8, 0.06, 5 + rng() * 6, new THREE.Color(0x223a28), 6
    );
  }
  for (let bed = 0; bed < 4; bed++) {
    const bx = cx + (rng() - 0.5) * (cellInner - 10);
    const bz = cz + (rng() - 0.5) * (cellInner - 10);
    grass.add(bx, 0.26, bz, 5 + rng() * 4, 0.16, 2.2 + rng() * 1.4, new THREE.Color(0x3a2c22), 4);
    for (let f = 0; f < 7; f++) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.16 + rng() * 0.08, 6, 5),
        new THREE.MeshStandardMaterial({ color: FLOWER_COLORS[Math.floor(rng() * FLOWER_COLORS.length)], roughness: 0.7 })
      );
      dot.position.set(bx + (rng() - 0.5) * 5, 0.42, bz + (rng() - 0.5) * 2);
      group.add(dot);
    }
  }
  const grassMesh = new THREE.Mesh(grass.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 }));
  grassMesh.receiveShadow = true;
  group.add(grassMesh);

  const trees = Math.max(3, Math.floor(rng() * 5) + 3);
  for (let t = 0; t < trees; t++) {
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

// 1-3 towers per block in a simple split pattern, dressed with parapet, setback
// tier, cornice band, entrance canopy and a glowing ground-floor shopfront.
function buildBlockTowers(rng, cx, cz, cellInner, half, towers, shops, trim, solids) {
  const first = rng();
  const splits = first < 0.45 ? 1 : (rng() < 0.6 ? 2 : 3);
  const lots = [];
  if (splits === 1) {
    lots.push([cx, cz, cellInner * 0.86, cellInner * 0.86]);
  } else if (splits === 2) {
    const w = cellInner * 0.45;
    lots.push([cx - cellInner * 0.26, cz, w, cellInner * 0.9]);
    lots.push([cx + cellInner * 0.26, cz, w, cellInner * 0.9]);
  } else {
    const w = cellInner * 0.44;
    lots.push([cx - cellInner * 0.27, cz - cellInner * 0.27, w, w]);
    lots.push([cx + cellInner * 0.27, cz - cellInner * 0.2, w, w * 0.95]);
    lots.push([cx - cellInner * 0.1, cz + cellInner * 0.28, cellInner * 0.9, w * 0.9]);
  }

  for (const [bx, bz, bw, bd] of lots) {
    // Height falls off toward the map edge, with a rare downtown spike.
    const dist = Math.hypot(bx, bz) / half;
    const h = 8 + rng() * (1 - dist * 0.6) * 54 + (rng() < 0.12 ? 30 : 0);
    const col = new THREE.Color(PALETTE[Math.floor(rng() * PALETTE.length)]);
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
function buildLampPosts(group, lamps, m4, q0, solids) {
  const postBatch = new BoxBatch();
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffd79a, emissive: 0xffd79a, emissiveIntensity: 1.4 });
  const bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.33, 8, 6), bulbMat, lamps.length);
  lamps.forEach((l, k) => {
    postBatch.add(l.x, 3.1, l.z, 0.28, 6.2, 0.28, new THREE.Color(0x262b34), 2);
    m4.compose(new THREE.Vector3(l.x, 6.3, l.z), q0, new THREE.Vector3(1, 1, 1));
    bulbMesh.setMatrixAt(k, m4);
    solids.push({ minX: l.x - 0.4, maxX: l.x + 0.4, minZ: l.z - 0.4, maxZ: l.z + 0.4, h: 6 });
  });
  bulbMesh.instanceMatrix.needsUpdate = true;
  if (lamps.length) group.add(bulbMesh);
  group.add(new THREE.Mesh(postBatch.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 })));
  return bulbMesh;
}

// Hydrants, trash bins and parked bikes scattered along the block edges.
function buildStreetProps(group, rng, cellInner, curbEdge, solids) {
  const propBatch = new BoxBatch();
  const bikeWheelGeo = new THREE.TorusGeometry(0.34, 0.06, 8, 14);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.9 });
  const bikeMat = new THREE.MeshStandardMaterial({ color: 0x3e6fa8, roughness: 0.5, metalness: 0.6 });

  for (let i = 0; i < WORLD.blocks; i++) {
    for (let j = 0; j < WORLD.blocks; j++) {
      const cx = -HALF + (i + 0.5) * WORLD.lotSize;
      const cz = -HALF + (j + 0.5) * WORLD.lotSize;
      if (rng() < 0.45) {
        const px = cx + (rng() - 0.5) * cellInner;
        const pz = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.6);
        propBatch.add(px, 0.35, pz, 0.26, 0.5, 0.26, new THREE.Color(0xc23b2e), 2);
        propBatch.add(px, 0.66, pz, 0.36, 0.14, 0.36, new THREE.Color(0xa33328), 2);
      }
      if (rng() < 0.5) {
        const px = cx + (rng() - 0.5) * cellInner;
        const pz = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.8);
        propBatch.add(px, 0.55, pz, 0.7, 1.0, 0.7, new THREE.Color(0x2e4436), 2);
        propBatch.add(px, 1.1, pz, 0.8, 0.1, 0.8, new THREE.Color(0x1e2e24), 2);
      }
      if (rng() < 0.3) {
        const px = cx + (rng() - 0.5) * cellInner;
        const pz = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.5);
        const bike = new THREE.Group();
        for (const s of [-1, 1]) {
          const w = new THREE.Mesh(bikeWheelGeo, tireMat);
          w.position.set(0, 0.34, s * 0.5);
          bike.add(w);
        }
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 1.0), bikeMat);
        frame.position.y = 0.55;
        bike.add(frame);
        bike.position.set(px, 0.18, pz);
        bike.rotation.y = rng() * Math.PI;
        bike.castShadow = true;
        group.add(bike);
      }
    }
  }
  group.add(new THREE.Mesh(propBatch.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 })));
}

// One low-intensity PointLight per 2x2 block cluster, tinted per cluster and
// driven at night by main.js — bounded cost, streets still glow after dusk.
function buildNeonPools(group) {
  const lights = [];
  for (let i = 0; i < WORLD.blocks; i += 2) {
    for (let j = 0; j < WORLD.blocks; j += 2) {
      const pl = new THREE.PointLight(NEON_TINTS[(i + j) % 4], 0, 55, 2);
      pl.position.set(-HALF + (i + 1) * WORLD.lotSize, 9, -HALF + (j + 1) * WORLD.lotSize);
      group.add(pl);
      lights.push(pl);
    }
  }
  return lights;
}

// AC units, water tanks and antennas on the taller rooftops.
function buildRoofDetails(group, rng, solids) {
  const roofBatch = new BoxBatch();
  const roofDetail = new THREE.Color(0x3a3f4a);
  const antennaGeo = new THREE.CylinderGeometry(0.05, 0.08, 6, 5);
  const antennaMat = new THREE.MeshStandardMaterial({ color: 0x565b66, roughness: 0.6, metalness: 0.7 });

  for (const s of solids) {
    if (s.h < 16 || rng() > 0.7) continue;
    const cxm = (s.minX + s.maxX) / 2, czm = (s.minZ + s.maxZ) / 2;
    const w = s.maxX - s.minX, d = s.maxZ - s.minZ;
    if (rng() < 0.7) {
      roofBatch.add(cxm + (rng() - 0.5) * w * 0.3, s.h + 0.55, czm + (rng() - 0.5) * d * 0.3,
        2.2, 1.0, 1.6, roofDetail, 3);
    }
    if (rng() < 0.4) {
      roofBatch.add(cxm + (rng() - 0.5) * w * 0.3, s.h + 1.1, czm + (rng() - 0.5) * d * 0.3,
        1.4, 1.6, 1.4, roofDetail, 3);
    }
    if (s.h > 30 && rng() < 0.5) {
      const ant = new THREE.Mesh(antennaGeo, antennaMat);
      ant.position.set(cxm, s.h + 3, czm);
      group.add(ant);
    }
  }
  const roofMesh = new THREE.Mesh(roofBatch.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  roofMesh.castShadow = true;
  group.add(roofMesh);
}

// Traffic signals at a third of intersections (green lamp lit, arcade style).
function buildTrafficLights(group, rng, nb, solids) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x262a32, roughness: 0.7, metalness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x30ff50, emissive: 0x20ff40, emissiveIntensity: 2 });
  const headGeo = new THREE.BoxGeometry(0.5, 1.3, 0.4);
  for (let i = 0; i < nb; i += 3) {
    for (let j = 0; j < nb; j += 3) {
      if (rng() > 0.6) continue;
      const cx0 = -HALF + i * WORLD.lotSize + 9;
      const cz0 = -HALF + j * WORLD.lotSize + 9;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 5.4, 8), poleMat);
      pole.position.set(cx0, 2.7, cz0);
      group.add(pole);
      const head = new THREE.Mesh(headGeo, poleMat);
      head.position.set(cx0, 5.6, cz0);
      group.add(head);
      const green = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), lampMat);
      green.position.set(cx0, 5.3, cz0 + 0.22);
      group.add(green);
      solids.push({ minX: cx0 - 0.3, maxX: cx0 + 0.3, minZ: cz0 - 0.3, maxZ: cz0 + 0.3, h: 6 });
    }
  }
}

// Vertical neon blade signs on a fraction of tower corners; main.js flickers them
// after dusk using userData.phase.
function buildNeonSigns(group, rng, solids) {
  const signGeo = new THREE.BoxGeometry(1.4, 7.5, 0.5);
  const signMeshes = [];
  for (const s of solids) {
    if (rng() > 0.22 || s.h < 14) continue;
    const mat = new THREE.MeshBasicMaterial({ color: NEON_TINTS[Math.floor(rng() * NEON_TINTS.length)] });
    const m = new THREE.Mesh(signGeo, mat);
    const side = rng() < 0.5 ? 1 : -1;
    m.position.set((s.minX + s.maxX) / 2 + side * (s.maxX - s.minX) / 2, s.h * 0.62, (s.minZ + s.maxZ) / 2);
    m.rotation.y = rng() * Math.PI;
    m.scale.y = Math.min(2.2, s.h / 14);
    group.add(m);
    m.userData.phase = signMeshes.length * 1.7;
    signMeshes.push(m);
  }
  return signMeshes;
}

// ---------------------------------------------------------------------------
// Street graph helpers
// ---------------------------------------------------------------------------

// Street centre lines used by traffic AI: one entry per grid line, both axes.
export function buildRoadLines() {
  const out = [];
  const nb = WORLD.blocks + 1;
  for (let i = 0; i < nb; i++) {
    const c = -HALF + i * WORLD.lotSize;
    out.push({ axis: 'z', line: c });
    out.push({ axis: 'x', line: c });
  }
  return out;
}

// Snap a world position onto the nearest lane; used for spawning traffic and cops.
// Equidistant ties resolve to the 'z' axis so spawning stays stable.
export function nearestLane(x, z) {
  const step = WORLD.lotSize;
  const li = Math.round((x + HALF) / step);
  const lj = Math.round((z + HALF) / step);
  const lx = -HALF + li * step;
  const lz = -HALF + lj * step;
  if (Math.abs(x - lx) < Math.abs(z - lz)) return { axis: 'z', line: lx, along: z };
  return { axis: 'x', line: lz, along: x };
}

export { HALF };
