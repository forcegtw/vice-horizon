// city.js — the Vice Horizon street grid, grown from one seeded RNG.
//
// A blocks x blocks lattice of lots separated by streets. Each lot becomes
// either a pocket park or one-to-three towers with trim bands, setback tiers
// and ground-floor shopfronts; the curbs collect lamps, hydrants, bins and
// parked bikes; the roads take lane dashes, crosswalk stripes, traffic
// signals and neon blade signs; tall roofs collect AC units, water tanks and
// antennas.
//
// Performance model: everything static merges through BoxBatch (one draw
// call per material family) or an InstancedMesh (sidewalk slabs, lamp
// bulbs), so a laptop GPU holds the frame budget. HALF — half the grid
// extent — is exported because traffic, peds, missions and the radar all
// clamp against it instead of re-measuring bounds.
//
// Determinism: the layout, the facade styles, every prop and every neon sign
// is a function of the passed-in rng. Call order is load-bearing — the same
// seed must re-paint the identical city for ?shot= replays, so no helper
// here may add or drop an rng() call without auditing every downstream
// consumer.

import * as THREE from '../vendor/three.min.js';
import { WORLD } from './config.js';

// Half-extent of the street grid in metres, derived once, shared everywhere.
export const HALF = (WORLD.blocks * WORLD.lotSize) / 2;

// ---------------------------------------------------------------------------
// Deterministic pixel noise
// ---------------------------------------------------------------------------
// Stateless integer hash: any canvas painter can sample it, and because it
// never carries state, every boot (and every ?shot= replay) paints bit-for-
// bit identical grit into the textures.
function speck(i) {
  const h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return ((h ^ (h >>> 13)) % 1000) / 1000;
}

// Paint a square canvas, hand it back as a repeating sRGB texture.
function paintedTexture(size, painter, repeat) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  painter(cv.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.repeat.set(repeat[0], repeat[1]);
  return tex;
}

// ---------------------------------------------------------------------------
// Facade themes + the shared window lattice
// ---------------------------------------------------------------------------
// Wall/trim colours plus the lit-window and dark-pane tints. Adding a style
// is one more array row — no new code path.
const FACADES = Object.freeze([
  { wall: '#7d5040', trim: '#5e3d32', lit: '#f5d9a8', dark: '#191c24' }, // brick red
  { wall: '#8b9099', trim: '#6f747d', lit: '#d6e6f5', dark: '#151920' }, // concrete
  { wall: '#38506e', trim: '#283c56', lit: '#b8d8f0', dark: '#0f1622' }, // glass blue
]);
const SIGN_BANDS = ['#e05a8a', '#58a8d8', '#d8b451', '#58b878'];

// Window lattice shared by the albedo and emissive maps so night glow lands
// exactly on the painted panes: 6 x 10 per tile. Which panes are lit is a
// pure hash of pane coordinates — stable across reloads, varied across walls.
const PANES_X = 6;
const PANES_Y = 10;
const paneRoll = (x, y) => (x * 53 + y * 29 + 11) % 89;

// Albedo facade: themed wall, trim-framed windows (some lit, some dark, some
// half-blinded), a mullion per pane and a floor slab line per row.
function paintFacade(themeIdx) {
  const t = FACADES[themeIdx % FACADES.length];
  return paintedTexture(256, (g, s) => {
    g.fillStyle = t.wall;
    g.fillRect(0, 0, s, s);
    const cw = s / PANES_X;
    const ch = s / PANES_Y;
    for (let row = 0; row < PANES_Y; row++) {
      for (let col = 0; col < PANES_X; col++) {
        const roll = paneRoll(col, row);
        const lit = roll % 5 < 2; // ~40% lit — scattered light, not a wall of it
        const px = col * cw + cw * 0.2;
        const py = row * ch + ch * 0.24;
        const pw = cw * 0.6;
        const ph = ch * 0.48;
        g.fillStyle = t.trim;
        g.fillRect(px - 2, py - 2, pw + 4, ph + 4);
        g.fillStyle = lit ? t.lit : t.dark;
        g.fillRect(px, py, pw, ph);
        // A half-drawn blind on some panes breaks the lattice repetition.
        if (roll % 7 < 3) {
          g.fillStyle = lit ? 'rgba(60,50,40,0.55)' : 'rgba(0,0,0,0.5)';
          g.fillRect(px, py, pw, ph * (0.25 + (roll % 10) * 0.05));
        }
        // One vertical mullion per pane keeps the glass from reading flat.
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.fillRect(px + pw / 2 - 1, py, 2, ph);
      }
      // Slab line gives the facade a readable storey rhythm.
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(0, row * ch + ch * 0.9, s, Math.max(2, ch * 0.08));
    }
  });
}

// Ground-floor shopfront band: dark glass, roller shutters or warm interiors,
// one restrained sign band per shop.
function paintShopfront(themeIdx) {
  return paintedTexture(256, (g, s) => {
    g.fillStyle = '#101218';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 4; i++) {
      const bx = i * (s / 4) + 8;
      const bw = s / 4 - 16;
      if ((i + themeIdx) % 3 === 0) {
        // Shuttered unit: corrugated roll-down door.
        g.fillStyle = '#2a2d34';
        g.fillRect(bx, 34, bw, s - 62);
        for (let l = 0; l < 8; l++) {
          g.fillStyle = 'rgba(0,0,0,0.35)';
          g.fillRect(bx, 34 + l * ((s - 62) / 8), bw, 3);
        }
      } else {
        // Open unit: warm or cool interior, left-edge shadow, three shelves.
        g.fillStyle = (i + themeIdx) % 2 ? '#e8b878' : '#9cc4e0';
        g.fillRect(bx, 34, bw, s - 62);
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(bx, 34, bw * 0.4, s - 62);
        g.fillStyle = 'rgba(0,0,0,0.6)';
        for (let sh = 0; sh < 3; sh++) g.fillRect(bx + 4, 80 + sh * 42, bw - 8, 6);
      }
      // Sign band over the door.
      g.fillStyle = SIGN_BANDS[(i + themeIdx) % SIGN_BANDS.length];
      g.fillRect(bx, 8, bw, 18);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(bx, 22, bw, 4);
    }
  });
}

// Sidewalk paving: concrete base, deterministic grit speckle, slab joints.
function paintSidewalk() {
  return paintedTexture(128, (g, s) => {
    g.fillStyle = '#8f939c';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 500; i++) {
      const tone = speck(i) > 0.5 ? '255,255,255' : '0,0,0';
      g.fillStyle = `rgba(${tone},0.06)`;
      g.fillRect(speck(i * 7 + 3) * s, speck(i * 13 + 11) * s, 2, 2);
    }
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      const p = (i / 4) * s;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke();
    }
  });
}

// Emissive twin of the facade: black wall, warm/cool panes on the same
// lattice, so window glow appears exactly where the albedo windows sit.
function paintGlow() {
  return paintedTexture(256, (g, s) => {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, s, s);
    const cw = s / PANES_X;
    const ch = s / PANES_Y;
    for (let row = 0; row < PANES_Y; row++) {
      for (let col = 0; col < PANES_X; col++) {
        if (paneRoll(col, row) % 4 === 0) continue;
        g.fillStyle = (col + row) % 3 === 0 ? '#ffd79a' : '#9fd6ff';
        g.fillRect(col * cw + cw * 0.2, row * ch + ch * 0.24, cw * 0.6, ch * 0.48);
      }
    }
  });
}

// Asphalt roughness noise — headlight pools break up on the road instead of
// reading as perfect mirror sheen. Same deterministic hash as the pavement
// grit, so replays get the identical light-pool pattern every boot.
function paintAsphaltRough() {
  return paintedTexture(128, (g, s) => {
    g.fillStyle = '#c0c0c0';
    g.fillRect(0, 0, s, s);
    for (let n = 0; n < 900; n++) {
      const v = 120 + Math.floor(speck(n * 3 + 1) * 130);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(speck(n * 5 + 2) * s, speck(n * 11 + 4) * s, 3, 3);
    }
  }, [24, 24]);
}

// ---------------------------------------------------------------------------
// BoxBatch — merged static boxes in one BufferGeometry
// ---------------------------------------------------------------------------
// Accumulates axis-aligned boxes with per-face UV scaling (a [u, v] pair lets
// window tiles keep a real-world aspect) and vertex colours. The underside is
// skipped unless asked for — nothing in this game looks up from beneath a slab.
class BoxBatch {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.verts = 0;
  }

  // uvScale: number (both axes) or [u, v]. bottomToo: emit the -Y face too.
  box(cx, cy, cz, sx, sy, sz, color, uvScale = 6, bottomToo = false) {
    const uTiles = Array.isArray(uvScale) ? uvScale[0] : uvScale;
    const vTiles = Array.isArray(uvScale) ? uvScale[1] : uvScale;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    // Face table: outward normal, in-plane u/v axes, centre offset, u/v extents.
    const faces = [
      { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], at: [hx, 0, 0], eu: sz, ev: sy },
      { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], at: [-hx, 0, 0], eu: sz, ev: sy },
      { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], at: [0, hy, 0], eu: sx, ev: sz },
      { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], at: [0, -hy, 0], eu: sx, ev: sz, skip: !bottomToo },
      { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], at: [0, 0, hz], eu: sx, ev: sy },
      { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], at: [0, 0, -hz], eu: sx, ev: sy },
    ];
    for (const f of faces) {
      if (f.skip) continue;
      const base = this.verts;
      // Corner walk: (-u,-v), (+u,-v), (+u,+v), (-u,+v) around the face.
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        this.pos.push(
          cx + f.at[0] + f.u[0] * f.eu * 0.5 * su + f.v[0] * f.ev * 0.5 * sv + f.n[0] * 0.01,
          cy + f.at[1] + f.u[1] * f.eu * 0.5 * su + f.v[1] * f.ev * 0.5 * sv + f.n[1] * 0.01,
          cz + f.at[2] + f.u[2] * f.eu * 0.5 * su + f.v[2] * f.ev * 0.5 * sv + f.n[2] * 0.01,
        );
        this.nrm.push(f.n[0], f.n[1], f.n[2]);
        this.uv.push((su * f.eu) / uTiles, (sv * f.ev) / vTiles);
        this.col.push(color.r, color.g, color.b);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      this.verts += 4;
    }
  }

  finish() {
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

// Flattened batch mesh: unlit marking/striping geometry.
function flatMesh(batch) {
  return new THREE.Mesh(batch.finish(), new THREE.MeshBasicMaterial({ vertexColors: true }));
}

// Building body colours — muted urban set, jittered per tower at placement.
const TOWER_TONES = Object.freeze([
  0x4b5a75, 0x6b6f86, 0x8a7f95, 0x3d4759, 0x9a8fa0, 0x5c6b82,
  0x7d6b78, 0x2f3746, 0x8e97a8, 0x6a5d6e,
]);
const NEON_COLORS = [0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff];
const BLOOM_COLORS = [0xd94f6b, 0xe8c14f, 0xc95fd9, 0xe8e4ea];

// Skyline shaping: fraction of tall towers that get an upper setback tier,
// and the height a tower must clear before the setback branch considers it.
const SETBACK_CHANCE = 0.7;
const SETBACK_MIN_HEIGHT = 24;
const PARK_CHANCE = 0.12;

// Tower window UV tiling — keeps facade panes near real-world size on both
// wall axes.
const WALL_UV = [4.2, 4.8];

// ---------------------------------------------------------------------------
// buildCity — the orchestrator
// ---------------------------------------------------------------------------
export function buildCity(scene, rng) {
  const group = new THREE.Group();
  scene.add(group);

  const cellInner = WORLD.lotSize - WORLD.roadWidth - WORLD.sidewalk * 2;
  const curbEdge = WORLD.lotSize / 2 - WORLD.roadWidth / 2;
  const solids = [];    // AABB colliders {minX, maxX, minZ, maxZ, h}
  const lamps = [];
  const parkSpots = [];
  const m4 = new THREE.Matrix4();
  const q0 = new THREE.Quaternion();
  const vec = (x, y, z) => new THREE.Vector3(x, y, z);

  // Ground: one big asphalt plane carrying a mild wet sheen. weather.js
  // retunes this material between dry and soaked, so it stays exposed.
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2 + 80, HALF * 2 + 80),
    new THREE.MeshStandardMaterial({
      color: 0x1e2026,
      roughness: 0.72,
      metalness: 0.18,
      roughnessMap: paintAsphaltRough(),
    }),
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  group.add(road);

  // Sidewalk slabs: a single InstancedMesh covering every block footprint.
  const pavementTex = paintSidewalk();
  pavementTex.repeat.set(10, 10);
  const walkSlabs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: pavementTex, color: 0xb9bcc4, roughness: 0.92, metalness: 0.05 }),
    WORLD.blocks * WORLD.blocks,
  );

  // Material families for the merged batches: three facade themes for towers,
  // three matching shopfront themes, plus a shared trim batch.
  const glowTex = paintGlow();
  const buildingMats = [0, 1, 2].map((k) => new THREE.MeshStandardMaterial({
    map: paintFacade(k),
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.12,
    emissive: 0xffffff,
    emissiveMap: glowTex,
    emissiveIntensity: 0.0,
  }));
  const shopMats = [0, 1, 2].map((k) => {
    const tex = paintShopfront(k);
    return new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.0 });
  });
  const towerBatches = [new BoxBatch(), new BoxBatch(), new BoxBatch()];
  const shopBatches = [new BoxBatch(), new BoxBatch(), new BoxBatch()];
  const trimBatch = new BoxBatch();

  let slab = 0;
  for (let i = 0; i < WORLD.blocks; i++) {
    for (let j = 0; j < WORLD.blocks; j++) {
      const cx = -HALF + (i + 0.5) * WORLD.lotSize;
      const cz = -HALF + (j + 0.5) * WORLD.lotSize;
      const style = rng();

      // Raised sidewalk slab over the whole block footprint.
      m4.compose(
        vec(cx, 0.09, cz),
        q0,
        vec(WORLD.lotSize - WORLD.roadWidth, 0.18, WORLD.lotSize - WORLD.roadWidth),
      );
      walkSlabs.setMatrixAt(slab++, m4);

      if (style < PARK_CHANCE) {
        buildParkCell(group, cx, cz, cellInner, rng, solids, parkSpots);
        continue;
      }
      fillTowerLot(towerBatches, shopBatches, trimBatch, solids, cx, cz, cellInner, HALF, rng);
      plantLamps(lamps, cx, cz, cellInner, rng);
    }
  }
  walkSlabs.instanceMatrix.needsUpdate = true;
  walkSlabs.receiveShadow = true;
  group.add(walkSlabs);

  // One merged tower mesh per facade theme so style variants coexist cheaply.
  towerBatches.forEach((batch, s) => {
    if (!batch.verts) return;
    const mesh = new THREE.Mesh(batch.finish(), buildingMats[s]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  shopBatches.forEach((batch, s) => {
    if (!batch.verts) return;
    const mesh = new THREE.Mesh(batch.finish(), shopMats[s]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  const trimMesh = new THREE.Mesh(
    trimBatch.finish(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }),
  );
  trimMesh.castShadow = true;
  group.add(trimMesh);

  // Lamp posts: merged dark columns plus instanced emissive bulbs; each post
  // is a thin collider so cars clip poles instead of ghosting through them.
  const postBatch = new BoxBatch();
  const bulbMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.33, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd79a, emissive: 0xffd79a, emissiveIntensity: 1.4 }),
    Math.max(1, lamps.length),
  );
  lamps.forEach((l, k) => {
    postBatch.box(l.x, 3.1, l.z, 0.28, 6.2, 0.28, new THREE.Color(0x262b34), 2);
    m4.compose(vec(l.x, 6.3, l.z), q0, vec(1, 1, 1));
    bulbMesh.setMatrixAt(k, m4);
    solids.push({ minX: l.x - 0.4, maxX: l.x + 0.4, minZ: l.z - 0.4, maxZ: l.z + 0.4, h: 6 });
  });
  bulbMesh.instanceMatrix.needsUpdate = true;
  bulbMesh.count = lamps.length;
  if (lamps.length) group.add(bulbMesh);
  group.add(new THREE.Mesh(
    postBatch.finish(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }),
  ));

  dressSidewalks(group, cellInner, curbEdge, rng);
  const neonLights = poolNeonLights(group);

  // Road markings and crosswalk stripes: unlit flat geometry just above asphalt.
  const laneCount = WORLD.blocks + 1;
  group.add(flatMesh(paintLaneDashes(laneCount)));
  group.add(flatMesh(paintCrosswalks(laneCount)));

  clutterRooftops(group, solids, rng);
  installTrafficLights(group, laneCount, rng, solids);
  const signMeshes = mountNeonSigns(group, solids, rng);

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

// ---------------------------------------------------------------------------
// Cell builders
// ---------------------------------------------------------------------------

// Park cell: grass slab with worn patches, flowerbeds with blooms, trees.
// Every tree trunk is a slim collider so vehicles bounce off greenery.
function buildParkCell(group, cx, cz, cellInner, rng, solids, parkSpots) {
  const grass = new BoxBatch();
  const baseGreen = new THREE.Color(0x2d4a33)
    .offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.06);
  grass.box(cx, 0.2, cz, cellInner, 0.2, cellInner, baseGreen, 8, true);
  for (let p = 0; p < 3; p++) {
    grass.box(
      cx + (rng() - 0.5) * cellInner * 0.6, 0.21, cz + (rng() - 0.5) * cellInner * 0.6,
      6 + rng() * 8, 0.06, 5 + rng() * 6, new THREE.Color(0x223a28), 6,
    );
  }
  for (let bed = 0; bed < 4; bed++) {
    const bx = cx + (rng() - 0.5) * (cellInner - 10);
    const bz = cz + (rng() - 0.5) * (cellInner - 10);
    grass.box(bx, 0.26, bz, 5 + rng() * 4, 0.16, 2.2 + rng() * 1.4, new THREE.Color(0x3a2c22), 4);
    for (let f = 0; f < 7; f++) {
      const bloom = new THREE.Mesh(
        new THREE.SphereGeometry(0.16 + rng() * 0.08, 6, 5),
        new THREE.MeshStandardMaterial({
          color: BLOOM_COLORS[Math.floor(rng() * BLOOM_COLORS.length)], roughness: 0.7,
        }),
      );
      bloom.position.set(bx + (rng() - 0.5) * 5, 0.42, bz + (rng() - 0.5) * 2);
      group.add(bloom);
    }
  }
  const lawn = new THREE.Mesh(
    grass.finish(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 }),
  );
  lawn.receiveShadow = true;
  group.add(lawn);

  const treeCount = Math.max(3, Math.floor(rng() * 5) + 3);
  for (let t = 0; t < treeCount; t++) {
    const tx = cx + (rng() - 0.5) * (cellInner - 8);
    const tz = cz + (rng() - 0.5) * (cellInner - 8);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.36, 3.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 }),
    );
    trunk.position.set(tx, 1.8, tz);
    group.add(trunk);
    const canopy = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.1 + rng() * 0.9, 0),
      new THREE.MeshStandardMaterial({ color: 0x2f6b3f, roughness: 0.95, flatShading: true }),
    );
    canopy.position.set(tx, 4.2, tz);
    canopy.castShadow = true;
    group.add(canopy);
    solids.push({ minX: tx - 0.6, maxX: tx + 0.6, minZ: tz - 0.6, maxZ: tz + 0.6, h: 5 });
  }
  parkSpots.push({ x: cx, z: cz });
}

// Tower lot: 1-3 buildings per block. Height falls off toward the map edge
// with the occasional downtown spike; each tower gets a trim cap, optional
// setback tier, mid-facade cornice, entrance canopy and a shopfront band.
function fillTowerLot(towerBatches, shopBatches, trimBatch, solids, cx, cz, cellInner, half, rng) {
  const splits = rng() < 0.45 ? 1 : rng() < 0.6 ? 2 : 3;
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
    const dist = Math.hypot(bx, bz) / half;
    const h = 8 + rng() * (1 - dist * 0.6) * 54 + (rng() < 0.12 ? 30 : 0);
    const col = new THREE.Color(TOWER_TONES[Math.floor(rng() * TOWER_TONES.length)])
      .offsetHSL(0, 0, (rng() - 0.5) * 0.08);
    const styleIdx = Math.floor(rng() * 3);
    towerBatches[styleIdx].box(bx, h / 2 + 0.2, bz, bw, h, bd, col, WALL_UV);
    trimBatch.box(bx, h + 0.6, bz, bw * 1.02, 0.8, bd * 1.02, new THREE.Color(0x22262f), 4);
    // Setback tier on taller masses steps the skyline.
    if (h > SETBACK_MIN_HEIGHT && rng() < SETBACK_CHANCE) {
      const upperH = h * (0.22 + rng() * 0.16);
      towerBatches[styleIdx].box(bx, h + upperH / 2 + 0.9, bz, bw * 0.62, upperH, bd * 0.62, col, WALL_UV);
      trimBatch.box(bx, h + upperH + 1.2, bz, bw * 0.64, 0.6, bd * 0.64, new THREE.Color(0x22262f), 4);
    }
    // Mid-facade cornice plus the street-facing entrance canopy.
    trimBatch.box(bx, h * 0.55, bz, bw * 1.04, 0.5, bd * 1.04, new THREE.Color(0x1a1e26), 4);
    trimBatch.box(bx, 3.3, bz + bd / 2 + 0.9, bw * 0.34, 0.22, 1.9, new THREE.Color(0x30353f), 4);
    // Ground-floor shopfront band, a hair proud of the wall so it catches light.
    shopBatches[styleIdx].box(bx, 1.5, bz, bw * 1.01, 3.0, bd * 1.01, new THREE.Color(0xffffff), 4);
    solids.push({ minX: bx - bw / 2, maxX: bx + bw / 2, minZ: bz - bd / 2, maxZ: bz + bd / 2, h });
  }
}

// Lamp posts on block corners: usually one, often two, pooled across the lot.
function plantLamps(lamps, cx, cz, cellInner, rng) {
  const corner = cellInner / 2 + 2.4;
  if (rng() < 0.85) {
    lamps.push({
      x: cx + (rng() < 0.5 ? -1 : 1) * corner,
      z: cz + (rng() < 0.5 ? -1 : 1) * corner,
    });
  }
  if (rng() < 0.6) {
    lamps.push({
      x: cx + (rng() < 0.5 ? -1 : 1) * corner,
      z: cz - (rng() < 0.5 ? -1 : 1) * corner,
    });
  }
}

// Curb dressing: hydrants, bins, parked bikes. Random per lot, merged batches
// where possible; bikes are the only multi-mesh props.
function dressSidewalks(group, cellInner, curbEdge, rng) {
  const propBatch = new BoxBatch();
  const wheelGeo = new THREE.TorusGeometry(0.34, 0.06, 8, 14);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3e6fa8, roughness: 0.5, metalness: 0.6 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.9 });

  for (let i = 0; i < WORLD.blocks; i++) {
    for (let j = 0; j < WORLD.blocks; j++) {
      const cx = -HALF + (i + 0.5) * WORLD.lotSize;
      const cz = -HALF + (j + 0.5) * WORLD.lotSize;
      // Hydrant: body + cap.
      if (rng() < 0.45) {
        const px = cx + (rng() - 0.5) * cellInner;
        const pz = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.6);
        propBatch.box(px, 0.35, pz, 0.26, 0.5, 0.26, new THREE.Color(0xc23b2e), 2);
        propBatch.box(px, 0.66, pz, 0.36, 0.14, 0.36, new THREE.Color(0xa33328), 2);
      }
      // Litter bin: body + lid.
      if (rng() < 0.5) {
        const px = cx + (rng() - 0.5) * cellInner;
        const pz = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.8);
        propBatch.box(px, 0.55, pz, 0.7, 1.0, 0.7, new THREE.Color(0x2e4436), 2);
        propBatch.box(px, 1.1, pz, 0.8, 0.1, 0.8, new THREE.Color(0x1e2e24), 2);
      }
      // Parked bike: torus wheels + a frame bar, randomly rotated.
      if (rng() < 0.3) {
        const px = cx + (rng() - 0.5) * cellInner;
        const pz = cz + (rng() < 0.5 ? -1 : 1) * (curbEdge - 0.5);
        const bike = new THREE.Group();
        for (const s of [-1, 1]) {
          const wheel = new THREE.Mesh(wheelGeo, tireMat);
          wheel.position.set(0, 0.34, s * 0.5);
          bike.add(wheel);
        }
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 1.0), frameMat);
        bar.position.y = 0.55;
        bike.add(bar);
        bike.position.set(px, 0.18, pz);
        bike.rotation.y = rng() * Math.PI;
        bike.castShadow = true;
        group.add(bike);
      }
    }
  }
  group.add(new THREE.Mesh(
    propBatch.finish(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 }),
  ));
}

// Block-cluster neon wash: one dim PointLight per 2x2 block group, intensity
// driven by main.js after dusk. Bounded light count keeps shading costs flat.
function poolNeonLights(group) {
  const pool = [];
  for (let i = 0; i < WORLD.blocks; i += 2) {
    for (let j = 0; j < WORLD.blocks; j += 2) {
      const pl = new THREE.PointLight(NEON_COLORS[(i + j) % NEON_COLORS.length], 0, 55, 2);
      pl.position.set(-HALF + (i + 1) * WORLD.lotSize, 9, -HALF + (j + 1) * WORLD.lotSize);
      group.add(pl);
      pool.push(pl);
    }
  }
  return pool;
}

// Dashed yellow centre lines along every street, both axes.
function paintLaneDashes(laneCount) {
  const dashes = new BoxBatch();
  const yellow = new THREE.Color(0xd8b451);
  for (let i = 0; i < laneCount; i++) {
    const c = gridLine(i);
    for (let j = 0; j < WORLD.blocks; j++) {
      const mid = -HALF + j * WORLD.lotSize + WORLD.lotSize / 2;
      dashes.box(c - 0.18, 0.02, mid, 0.36, 0.02, 4.5, yellow, 4);
      dashes.box(mid, 0.02, c + 0.18, 4.5, 0.02, 0.36, yellow, 4);
    }
  }
  return dashes;
}

// Crosswalk geometry: stripe pitch across the road, the half-width of the
// crossing band measured from the intersection centre, and the stripe box.
const CROSSWALK_PITCH = 1.7;
const CROSSWALK_HALF_WIDTH = 7.4;
const STRIPE_LENGTH = 2.6;
const STRIPE_WIDTH = 0.9;

// White stripes across each street approach at every intersection.
function paintCrosswalks(laneCount) {
  const stripes = new BoxBatch();
  const white = new THREE.Color(0xd9dde2);
  for (let i = 0; i < laneCount; i++) {
    const c = gridLine(i);
    for (let j = 0; j < WORLD.blocks; j++) {
      const mid = -HALF + j * WORLD.lotSize + WORLD.lotSize / 2;
      for (let k = -3; k <= 3; k++) {
        stripes.box(c + k * CROSSWALK_PITCH, 0.021, mid + CROSSWALK_HALF_WIDTH, STRIPE_WIDTH, 0.015, STRIPE_LENGTH, white, 4);
        stripes.box(c + k * CROSSWALK_PITCH, 0.021, mid - CROSSWALK_HALF_WIDTH, STRIPE_WIDTH, 0.015, STRIPE_LENGTH, white, 4);
        stripes.box(mid + CROSSWALK_HALF_WIDTH, 0.021, c + k * CROSSWALK_PITCH, STRIPE_LENGTH, 0.015, STRIPE_WIDTH, white, 4);
        stripes.box(mid - CROSSWALK_HALF_WIDTH, 0.021, c + k * CROSSWALK_PITCH, STRIPE_LENGTH, 0.015, STRIPE_WIDTH, white, 4);
      }
    }
  }
  return stripes;
}

// Rooftop clutter on towers tall enough to see: AC units, water tanks,
// antennas. Solid roofs only — park cells and short shops stay clean.
function clutterRooftops(group, solids, rng) {
  const roofBatch = new BoxBatch();
  const metal = new THREE.Color(0x3a3f4a);
  const antennaGeo = new THREE.CylinderGeometry(0.05, 0.08, 6, 5);
  const antennaMat = new THREE.MeshStandardMaterial({ color: 0x565b66, roughness: 0.6, metalness: 0.7 });
  for (const s of solids) {
    if (s.h < 16 || rng() > 0.7) continue;
    const cx = (s.minX + s.maxX) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    const w = s.maxX - s.minX;
    const d = s.maxZ - s.minZ;
    if (rng() < 0.7) {
      roofBatch.box(
        cx + (rng() - 0.5) * w * 0.4, s.h + 0.8, cz + (rng() - 0.5) * d * 0.4,
        2.2, 1.0, 1.6, metal, 3,
      );
    }
    if (rng() < 0.4) {
      roofBatch.box(
        cx + (rng() - 0.5) * w * 0.3, s.h + 1.1, cz + (rng() - 0.5) * d * 0.3,
        1.4, 1.6, 1.4, metal, 3,
      );
    }
    if (s.h > 30 && rng() < 0.5) {
      const ant = new THREE.Mesh(antennaGeo, antennaMat);
      ant.position.set(cx, s.h + 3, cz);
      group.add(ant);
    }
  }
  const roofMesh = new THREE.Mesh(
    roofBatch.finish(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
  );
  roofMesh.castShadow = true;
  group.add(roofMesh);
}

// Traffic signals at a third of intersections: pole, head, green lamp; the
// pole base is a slim collider. Red lamps are omitted — traffic AI ignores
// signals, so only the green discs render.
function installTrafficLights(group, laneCount, rng, solids) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x262a32, roughness: 0.7, metalness: 0.6 });
  const greenMat = new THREE.MeshStandardMaterial({ color: 0x30ff50, emissive: 0x20ff40, emissiveIntensity: 2 });
  const headGeo = new THREE.BoxGeometry(0.5, 1.3, 0.4);
  for (let i = 0; i < laneCount; i += 3) {
    for (let j = 0; j < laneCount; j += 3) {
      if (rng() > 0.6) continue;
      const cx = -HALF + i * WORLD.lotSize + 9;
      const cz = -HALF + j * WORLD.lotSize + 9;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 5.4, 8), poleMat);
      pole.position.set(cx, 2.7, cz);
      group.add(pole);
      const head = new THREE.Mesh(headGeo, poleMat);
      head.position.set(cx, 5.6, cz);
      group.add(head);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), greenMat);
      lamp.position.set(cx, 5.3, cz + 0.22);
      group.add(lamp);
      solids.push({ minX: cx - 0.3, maxX: cx + 0.3, minZ: cz - 0.3, maxZ: cz + 0.3, h: 6 });
    }
  }
}

// Neon blade signs on a fraction of tower corners. Flicker phase is derived
// from the solid index, and the colour list matches main.js's dusk cycle so
// signs and their cast light agree.
function mountNeonSigns(group, solids, rng) {
  const bladeGeo = new THREE.BoxGeometry(1.4, 7.5, 0.5);
  const mounted = [];
  solids.forEach((s, k) => {
    if (rng() > 0.22 || s.h < 14) return;
    const mat = new THREE.MeshBasicMaterial({ color: NEON_COLORS[Math.floor(rng() * NEON_COLORS.length)] });
    const blade = new THREE.Mesh(bladeGeo, mat);
    const side = rng() < 0.5 ? 1 : -1;
    blade.position.set(
      (s.minX + s.maxX) / 2 + side * (s.maxX - s.minX) / 2,
      s.h * 0.62,
      (s.minZ + s.maxZ) / 2,
    );
    blade.rotation.y = rng() * Math.PI;
    blade.scale.y = Math.min(2.2, s.h / 14);
    blade.userData.phase = k * 1.7;
    group.add(blade);
    mounted.push(blade);
  });
  return mounted;
}

// ---------------------------------------------------------------------------
// Street network helpers
// ---------------------------------------------------------------------------

// World coordinate of street centre line i — streets run at every lot
// boundary, from -HALF up to +HALF.
const gridLine = (i) => -HALF + i * WORLD.lotSize;

// Street centre lines for traffic AI: every grid line, both axes, 'z' entry
// before 'x' at each index.
export function buildRoadLines() {
  const lines = [];
  for (let i = 0; i < WORLD.blocks + 1; i++) {
    const c = gridLine(i);
    lines.push({ axis: 'z', line: c });
    lines.push({ axis: 'x', line: c });
  }
  return lines;
}

// Snap a world position to the nearest lane — used for spawning traffic,
// cops and mission objectives on drivable ground. Ties break toward the 'z'
// axis so spawn choices stay stable when both axes are equidistant.
export function nearestLane(x, z) {
  const step = WORLD.lotSize;
  const ix = Math.round((x + HALF) / step);
  const iz = Math.round((z + HALF) / step);
  const nearX = gridLine(ix);
  const nearZ = gridLine(iz);
  if (Math.abs(x - nearX) < Math.abs(z - nearZ)) {
    return { axis: 'z', line: nearX, along: z };
  }
  return { axis: 'x', line: nearZ, along: x };
}
