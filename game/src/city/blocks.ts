// City blocks — the lot grid, the painted texture set, the axis-aligned box
// batch, and every build stage that fills a lot: ground asphalt, sidewalks,
// parks and towers, then the merged facade/shop/trim meshes.
//
// Split out of the old city.js so each stage lives beside its data; the stage
// order itself is owned by city/index.ts (buildCity), because stage order
// fixes both the group's child order and the seeded rng stream. Guards below
// skip rng draws on purpose, so every call site must keep its place.
//
// HALF is the world's half-extent, re-exported through city/index.ts and
// treated as immutable: traffic, pedestrians and missions import it instead of
// re-deriving bounds. Every canvas texture op is a pure function of integer
// hashes — never Math.random — so textures come out identical on every reload.

import * as THREE from '../../vendor/three.min.js';
import { WORLD } from '../config.js';

// ---------------------------------------------------------------------------
// Grid geometry
// ---------------------------------------------------------------------------

export const HALF = (WORLD.blocks * WORLD.lotSize) / 2;
export const CELLS = WORLD.blocks;        // lots per side
export const LANES = CELLS + 1;           // street centre lines, both edges included

// Metres of usable ground inside one lot once road and both sidewalks are gone.
export const LOT_BUILDABLE = WORLD.lotSize - WORLD.roadWidth - WORLD.sidewalk * 2;
// Distance from a lot centre to the curb face (half lot minus half road).
export const CURB_OFFSET = WORLD.lotSize / 2 - WORLD.roadWidth / 2;

export const lotCenter = (i) => -HALF + (i + 0.5) * WORLD.lotSize;
export const streetLine = (i) => -HALF + i * WORLD.lotSize;

// ---------------------------------------------------------------------------
// Painted textures
// ---------------------------------------------------------------------------

// Tower wall finishes: brick red, concrete gray, glass blue.
const WALL_FINISHES = [
  { wall: '#7d5040', trim: '#5e3d32', lit: '#f5d9a8', dark: '#191c24' },
  { wall: '#8b9099', trim: '#6f747d', lit: '#d6e6f5', dark: '#151920' },
  { wall: '#38506e', trim: '#283c56', lit: '#b8d8f0', dark: '#0f1622' },
];

// Window density per facade tile: 7 x 9 reads as windows at street level and
// still reads as windows when a tower tiles the texture storeys above.
const WINDOW_COLS = 7;
const WINDOW_ROWS = 9;
const TEXTURE_SIZE = 256;

// One sign hue per storefront bay, cycled by bay index + style.
const SIGN_HUES = ['#e05a8a', '#58a8d8', '#d8b451', '#58b878'];

// One pane's look is a pure function of its grid cell, so the wall texture and
// the emissive glow overlay agree pane-for-pane.
function paneRoll(x, y) {
  return (31 * x + 17 * y + 7) % 97;
}

// Pane rectangle inside a facade tile (fractions of the cell, kept odd so
// frames and mullions have room).
function paneRect(x, y, cw, ch) {
  return [x * cw + cw * 0.22, y * ch + ch * 0.26, cw * 0.56, ch * 0.46];
}

function sizedCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function repeatingTexture(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Wall texture for one tower finish: base coat, then the window grid with trim
// frames, occasional blinds and a mullion, and a slab line per storey.
function paintTowerSkin(finishIdx) {
  const finish = WALL_FINISHES[finishIdx % WALL_FINISHES.length];
  const [c, g] = sizedCanvas(TEXTURE_SIZE);
  const cw = TEXTURE_SIZE / WINDOW_COLS;
  const ch = TEXTURE_SIZE / WINDOW_ROWS;
  g.fillStyle = finish.wall;
  g.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < WINDOW_ROWS; y++) {
    for (let x = 0; x < WINDOW_COLS; x++) {
      const roll = paneRoll(x, y);
      const lit = roll % 5 < 2; // roughly two panes in five glow: scattered, never a lit wall
      const [wx, wy, ww, wh] = paneRect(x, y, cw, ch);
      g.fillStyle = finish.trim;
      g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
      g.fillStyle = lit ? finish.lit : finish.dark;
      g.fillRect(wx, wy, ww, wh);
      // A blind pulled partway down some windows breaks up the grid repeat.
      if (roll % 7 < 3) {
        g.fillStyle = lit ? 'rgba(60,50,40,0.55)' : 'rgba(0,0,0,0.5)';
        g.fillRect(wx, wy, ww, wh * (0.25 + (roll % 10) * 0.05));
      }
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(wx + ww / 2 - 1, wy, 2, wh);
    }
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(0, y * ch + ch * 0.9, TEXTURE_SIZE, Math.max(2, ch * 0.08));
  }
  const tex = repeatingTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Ground-floor band: dark glass with roller shutters on closed shops, warm
// interiors behind shelves on open ones, and one sign hue per bay.
function paintStorefrontSkin(styleIdx) {
  const [c, g] = sizedCanvas(TEXTURE_SIZE);
  g.fillStyle = '#101218';
  g.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const bayCount = 4;
  const bayWidth = TEXTURE_SIZE / bayCount;
  for (let i = 0; i < bayCount; i++) {
    const bx = i * bayWidth + 8;
    const bw = bayWidth - 16;
    const bayTone = i + styleIdx;
    if (bayTone % 3 === 0) {
      g.fillStyle = '#2a2d34';
      g.fillRect(bx, 34, bw, TEXTURE_SIZE - 62);
      for (let slat = 0; slat < 8; slat++) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(bx, 34 + slat * ((TEXTURE_SIZE - 62) / 8), bw, 3);
      }
    } else {
      g.fillStyle = bayTone % 2 ? '#e8b878' : '#9cc4e0';
      g.fillRect(bx, 34, bw, TEXTURE_SIZE - 62);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(bx, 34, bw * 0.4, TEXTURE_SIZE - 62);
      g.fillStyle = 'rgba(0,0,0,0.6)';
      for (let shelf = 0; shelf < 3; shelf++) g.fillRect(bx + 4, 80 + shelf * 42, bw - 8, 6);
    }
    const SIGN_HUES_LEN = SIGN_HUES.length;
    g.fillStyle = SIGN_HUES[bayTone % SIGN_HUES_LEN];
    g.fillRect(bx, 8, bw, 18);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(bx, 22, bw, 4);
  }
  const tex = repeatingTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Stateless integer hash — any texture can sample deterministic grit from it.
function grit(i) {
  const h = (i * 2654435761) >>> 0;
  return (h % 1000) / 1000;
}

// Sidewalk paving: concrete tone, hashed speckle grit, joint lines both ways.
function paintWalkSkin() {
  const size = 128;
  const [c, g] = sizedCanvas(size);
  g.fillStyle = '#8f939c';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 500; i++) {
    const tone = grit(i);
    const px = grit(i * 7 + 3);
    const pz = grit(i * 13 + 11);
    g.fillStyle = `rgba(${tone > 0.5 ? '255,255,255' : '0,0,0'},0.06)`;
    g.fillRect(px * size, pz * size, 2, 2);
  }
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * size;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  const tex = repeatingTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Emissive overlay so towers glow at night without relighting the scene. The
// lit subset deliberately differs from the facade's lit panes: not every window
// you can see has its lamp on.
function paintGlowSkin() {
  const [c, g] = sizedCanvas(TEXTURE_SIZE);
  const cw = TEXTURE_SIZE / WINDOW_COLS;
  const ch = TEXTURE_SIZE / WINDOW_ROWS;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < WINDOW_ROWS; y++) {
    for (let x = 0; x < WINDOW_COLS; x++) {
      if (paneRoll(x, y) % 4 === 0) continue;
      const warm = (x + y) % 3 === 0;
      g.fillStyle = warm ? '#ffd79a' : '#9fd6ff';
      g.fillRect(...paneRect(x, y, cw, ch));
    }
  }
  return repeatingTexture(c);
}

// Cheap roughness noise so light pools break up on the asphalt. Same hash as
// the paving, so a ?shot= replay pools light identically on every boot.
function paintAsphaltRoughness() {
  const size = 128;
  const [c, g] = sizedCanvas(size);
  g.fillStyle = '#c0c0c0';
  g.fillRect(0, 0, size, size);
  for (let n = 0; n < 900; n++) {
    const v = 120 + Math.floor(grit(n * 3 + 1) * 130);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(grit(n * 5 + 2) * size, grit(n * 11 + 4) * size, 3, 3);
  }
  const tex = repeatingTexture(c);
  tex.repeat.set(24, 24);
  return tex;
}

// ---------------------------------------------------------------------------
// Box factory. Accumulates axis-aligned boxes with per-face UV scaling so
// textures tile at world scale, then bakes one BufferGeometry per batch.
// ---------------------------------------------------------------------------

// [normal, u axis, v axis] per face, ordered +x, -x, +y, -y, +z, -z. Face
// origins and spans derive from the box dims at add() time.
const FACE_AXES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
// Which of (sx, sy, sz) spans each face's u and v.
const FACE_SPANS = [
  ['z', 'y'], ['z', 'y'], ['x', 'z'], ['x', 'z'], ['x', 'y'], ['x', 'y'],
];
// Each face origin: which half-extent (signed) sits on which axis.
const FACE_OFFSETS = [
  ['x', 1], ['x', -1], ['y', 1], ['y', -1], ['z', 1], ['z', -1],
];

// Z-fighting dodge: every face is pushed this far along its normal.
const FACE_BULGE = 0.01;

export function createBoxBatch() {
  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const idx = [];
  const batch = {
    quads: 0,
    // tiling is a number or [horizontal, vertical] — [4.2, 4.8] makes the
    // facade grid read as real windows instead of stretched squares.
    // floorToo keeps the downward face (parks want it, towers don't).
    add(cx, cy, cz, sx, sy, sz, color, tiling = 6, floorToo = false) {
      const uvs = Array.isArray(tiling) ? tiling[0] : tiling;
      const uvv = Array.isArray(tiling) ? tiling[1] : tiling;
      const half = { x: sx / 2, y: sy / 2, z: sz / 2 };
      const span = { x: sx, y: sy, z: sz };
      for (let f = 0; f < FACE_AXES.length; f++) {
        if (!floorToo && f === 3) continue;
        const [n, u, v] = FACE_AXES[f];
        const [fuName, fvName] = FACE_SPANS[f];
        const fu = span[fuName];
        const fv = span[fvName];
        const [offAxis, offSign] = FACE_OFFSETS[f];
        const off = [0, 0, 0];
        off[offAxis === 'x' ? 0 : offAxis === 'y' ? 1 : 2] = half[offAxis] * offSign;
        const base = pos.length / 3;
        for (let k = 0; k < 4; k++) {
          const su = k === 1 || k === 2 ? 1 : -1;
          const sv = k >= 2 ? 1 : -1;
          const px = cx + off[0] + u[0] * (fu / 2) * su + v[0] * (fv / 2) * sv + n[0] * FACE_BULGE;
          const py = cy + off[1] + u[1] * (fu / 2) * su + v[1] * (fv / 2) * sv + n[1] * FACE_BULGE;
          const pz = cz + off[2] + u[2] * (fu / 2) * su + v[2] * (fv / 2) * sv + n[2] * FACE_BULGE;
          pos.push(px, py, pz);
          nrm.push(n[0], n[1], n[2]);
          uv.push((su * fu) / uvs, (sv * fv) / uvv);
          col.push(color.r, color.g, color.b);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        batch.quads++;
      }
    },
    build() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      return geo;
    },
  };
  return batch;
}

// ---------------------------------------------------------------------------
// Tints. Vertex colors multiply the facade texture.
// ---------------------------------------------------------------------------

const TOWER_TINTS = [
  0x4b5a75, 0x6b6f86, 0x8a7f95, 0x3d4759, 0x9a8fa0, 0x5c6b82,
  0x7d6b78, 0x2f3746, 0x8e97a8, 0x6a5d6e,
];

const ROOF_LIP_TINT = 0x22262f;    // parapet
const BELT_TINT = 0x1a1e26;        // mid-facade cornice band
const CANOPY_TINT = 0x30353f;      // entrance canopy
const TRUNK_TINT = 0x4a3a2c;
const LEAF_TINT = 0x2f6b3f;

const BLOOM_TINTS = [0xd94f6b, 0xe8c14f, 0xc95fd9, 0xe8e4ea];

// ---------------------------------------------------------------------------
// Lot carving and cell contents
// ---------------------------------------------------------------------------

// Ways to fill one lot: a single wide footprint, a pair of slabs, or a
// three-way split with a long slab across the back.
function carveLots(cx, cz, span, way) {
  if (way === 1) {
    return [[cx, cz, span * 0.86, span * 0.86]];
  }
  if (way === 2) {
    const w = span * 0.45;
    return [
      [cx - span * 0.26, cz, w, span * 0.9],
      [cx + span * 0.26, cz, w, span * 0.9],
    ];
  }
  const w = span * 0.44;
  return [
    [cx - span * 0.27, cz - span * 0.27, w, w],
    [cx + span * 0.27, cz - span * 0.2, w, w * 0.95],
    [cx - span * 0.1, cz + span * 0.28, span * 0.9, w * 0.9],
  ];
}

// A small park: lawn slab with worn patches, flowerbeds with individual blooms,
// and trees that become solids so cars cannot drive through the trunks.
function plantPark(site, cx, cz, span) {
  const { rng, group, solids, parkSpots } = site;
  const lawn = createBoxBatch();
  const hueDrift = (rng() - 0.5) * 0.04;
  const toneDrift = (rng() - 0.5) * 0.06;
  const lawnTint = new THREE.Color(0x2d4a33).offsetHSL(hueDrift, 0, toneDrift);
  lawn.add(cx, 0.2, cz, span, 0.2, span, lawnTint, 8, true);
  for (let patch = 0; patch < 3; patch++) {
    const px = cx + (rng() - 0.5) * span * 0.6;
    const pz = cz + (rng() - 0.5) * span * 0.6;
    const pw = 6 + rng() * 8;
    const pd = 5 + rng() * 6;
    lawn.add(px, 0.21, pz, pw, 0.06, pd, new THREE.Color(0x223a28), 6);
  }
  for (let bed = 0; bed < 4; bed++) {
    const bx = cx + (rng() - 0.5) * (span - 10);
    const bz = cz + (rng() - 0.5) * (span - 10);
    const bw = 5 + rng() * 4;
    const bd = 2.2 + rng() * 1.4;
    lawn.add(bx, 0.26, bz, bw, 0.16, bd, new THREE.Color(0x3a2c22), 4);
    for (let bloom = 0; bloom < 7; bloom++) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.16 + rng() * 0.08, 6, 5),
        new THREE.MeshStandardMaterial({ color: BLOOM_TINTS[Math.floor(rng() * BLOOM_TINTS.length)], roughness: 0.7 }),
      );
      const dx = bx + (rng() - 0.5) * 5;
      const dz = bz + (rng() - 0.5) * 2;
      dot.position.set(dx, 0.42, dz);
      group.add(dot);
    }
  }
  const lawnMesh = new THREE.Mesh(
    lawn.build(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 }),
  );
  lawnMesh.receiveShadow = true;
  group.add(lawnMesh);
  const treeCount = Math.max(3, Math.floor(rng() * 5) + 3);
  for (let t = 0; t < treeCount; t++) {
    const tx = cx + (rng() - 0.5) * (span - 8);
    const tz = cz + (rng() - 0.5) * (span - 8);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.36, 3.2, 6),
      new THREE.MeshStandardMaterial({ color: TRUNK_TINT, roughness: 0.95 }),
    );
    trunk.position.set(tx, 1.8, tz);
    group.add(trunk);
    const crown = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.1 + rng() * 0.9, 0),
      new THREE.MeshStandardMaterial({ color: LEAF_TINT, roughness: 0.95, flatShading: true }),
    );
    crown.position.set(tx, 4.2, tz);
    crown.castShadow = true;
    group.add(crown);
    solids.push({ minX: tx - 0.6, maxX: tx + 0.6, minZ: tz - 0.6, maxZ: tz + 0.6, h: 5 });
  }
  parkSpots.push({ x: cx, z: cz });
}

// One tower: tinted facade, parapet lip, optional setback tier, cornice band,
// entrance canopy over the +z door, and the ground-floor shopfront wrap.
function raiseTower(site, towers, shops, bx, bz, bw, bd) {
  const { rng, solids } = site;
  const coreness = Math.hypot(bx, bz) / HALF;
  // Downtown cores rise tall, the rim stays low; a rare jackpot adds 30 m so
  // the skyline keeps a couple of landmarks.
  const rise = rng() * (1 - coreness * 0.6) * 54;
  const landmark = rng() < 0.12;
  const h = 8 + rise + (landmark ? 30 : 0);
  const tint = new THREE.Color(TOWER_TINTS[Math.floor(rng() * TOWER_TINTS.length)]);
  tint.offsetHSL(0, 0, (rng() - 0.5) * 0.08);
  const finish = Math.floor(rng() * 3);
  towers[finish].add(bx, h / 2 + 0.2, bz, bw, h, bd, tint, [4.2, 4.8]);
  site.trim.add(bx, h + 0.6, bz, bw * 1.02, 0.8, bd * 1.02, new THREE.Color(ROOF_LIP_TINT), 4);
  // A slimmer upper tier on tall buildings gives the skyline real steps.
  if (h > 24 && rng() < 0.7) {
    const upperH = h * (0.22 + rng() * 0.16);
    towers[finish].add(bx, h + upperH / 2 + 0.9, bz, bw * 0.62, upperH, bd * 0.62, tint, [4.2, 4.8]);
    site.trim.add(bx, h + upperH + 1.2, bz, bw * 0.64, 0.6, bd * 0.64, new THREE.Color(ROOF_LIP_TINT), 4);
  }
  site.trim.add(bx, h * 0.55, bz, bw * 1.04, 0.5, bd * 1.04, new THREE.Color(BELT_TINT), 4);
  site.trim.add(bx, 3.3, bz + bd / 2 + 0.9, bw * 0.34, 0.22, 1.9, new THREE.Color(CANOPY_TINT), 4);
  shops[finish].add(bx, 1.5, bz, bw * 1.01, 3.0, bd * 1.01, new THREE.Color(0xffffff), 4);
  solids.push({ minX: bx - bw / 2, maxX: bx + bw / 2, minZ: bz - bd / 2, maxZ: bz + bd / 2, h });
}

// ---------------------------------------------------------------------------
// Build stages. index.ts runs these in a fixed order; none may be rearranged
// because each consumes the shared rng stream in place.
// ---------------------------------------------------------------------------

// Asphalt ground plane with a mild wet sheen; the hashed roughness map breaks
// up light pools so streets never read as one flat mirror.
export function paveGround(site) {
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2 + 80, HALF * 2 + 80),
    new THREE.MeshStandardMaterial({
      color: 0x1e2026, roughness: 0.72, metalness: 0.18,
      roughnessMap: paintAsphaltRoughness(),
    }),
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  site.group.add(road);
  site.road = road;
}

// One raised sidewalk slab per lot, instanced. The batch is returned unfinalized:
// blocks are stamped in, then the mesh joins the group after the block pass.
export function laySidewalks(site) {
  const walkTex = paintWalkSkin();
  walkTex.repeat.set(10, 10);
  const walkBatch = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: walkTex, color: 0xb9bcc4, roughness: 0.92, metalness: 0.05 }),
    CELLS * CELLS,
  );
  const m4 = new THREE.Matrix4();
  const still = new THREE.Quaternion();
  const walkSpan = WORLD.lotSize - WORLD.roadWidth;
  site.walkPose = (i, j) => {
    m4.compose(
      new THREE.Vector3(lotCenter(i), 0.09, lotCenter(j)),
      still,
      new THREE.Vector3(walkSpan, 0.18, walkSpan),
    );
    return m4;
  };
  return walkBatch;
}

// Facade variants (brick / concrete / glass) with their glow overlays, plus the
// ground-floor shopfront materials. Canvas ops happen in this order by design.
export function dressMaterials() {
  const glowTex = paintGlowSkin();
  const buildingMats = [0, 1, 2].map((k) => new THREE.MeshStandardMaterial({
    map: paintTowerSkin(k),
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.12,
    emissive: 0xffffff,
    emissiveMap: glowTex,
    emissiveIntensity: 0.0,
  }));
  const shopMats = [0, 1, 2].map((k) => new THREE.MeshStandardMaterial({
    map: paintStorefrontSkin(k),
    emissive: 0xffffff,
    emissiveMap: paintStorefrontSkin(k),
    emissiveIntensity: 0.0,
  }));
  return { buildingMats, shopMats };
}

export function openBatches() {
  return {
    towers: [createBoxBatch(), createBoxBatch(), createBoxBatch()],
    shops: [createBoxBatch(), createBoxBatch(), createBoxBatch()],
    trim: createBoxBatch(),
  };
}

// The block pass: sidewalks, parks or towers, lamp spots. Lamp rng draws stay
// inside the cell loop — one or two per block on opposite street corners.
export function carveBlocks(site, walkBatch, batches) {
  const { rng, lamps, group } = site;
  let inst = 0;
  for (let i = 0; i < CELLS; i++) {
    for (let j = 0; j < CELLS; j++) {
      const cx = lotCenter(i);
      const cz = lotCenter(j);
      const roll = rng();
      walkBatch.setMatrixAt(inst++, site.walkPose(i, j));
      if (roll < 0.12) {
        plantPark(site, cx, cz, LOT_BUILDABLE);
        continue;
      }
      const way = rng() < 0.45 ? 1 : rng() < 0.6 ? 2 : 3;
      for (const [bx, bz, bw, bd] of carveLots(cx, cz, LOT_BUILDABLE, way)) {
        raiseTower(site, batches.towers, batches.shops, bx, bz, bw, bd);
      }
      if (rng() < 0.85) {
        const xs = rng() < 0.5 ? -1 : 1;
        const zs = rng() < 0.5 ? -1 : 1;
        lamps.push({ x: cx + xs * (LOT_BUILDABLE / 2 + 2.4), z: cz + zs * (LOT_BUILDABLE / 2 + 2.4) });
      }
      if (rng() < 0.6) {
        const xs = rng() < 0.5 ? -1 : 1;
        const zs = rng() < 0.5 ? -1 : 1;
        lamps.push({ x: cx + xs * (LOT_BUILDABLE / 2 + 2.4), z: cz - zs * (LOT_BUILDABLE / 2 + 2.4) });
      }
    }
  }
  walkBatch.instanceMatrix.needsUpdate = true;
  walkBatch.receiveShadow = true;
  group.add(walkBatch);
}

// One merged tower/shop mesh per facade finish, then the shared trim mesh.
export function closeBatches(site, batches, skins) {
  batches.towers.forEach((batch, s) => {
    if (!batch.quads) return;
    const m = new THREE.Mesh(batch.build(), skins.buildingMats[s]);
    m.castShadow = true;
    m.receiveShadow = true;
    site.group.add(m);
  });
  batches.shops.forEach((batch, s) => {
    if (!batch.quads) return;
    const m = new THREE.Mesh(batch.build(), skins.shopMats[s]);
    m.castShadow = true;
    m.receiveShadow = true;
    site.group.add(m);
  });
  const trimMesh = new THREE.Mesh(
    batches.trim.build(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }),
  );
  trimMesh.castShadow = true;
  site.group.add(trimMesh);
}
