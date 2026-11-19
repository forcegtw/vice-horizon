// Procedural city: a grid of blocks separated by streets, each block packed with a few
// slab towers, plus lamp posts, park clusters and a waterfront strip. Geometry is merged
// into a handful of draw calls so the whole town stays cheap on a laptop GPU.
// Witness pass: HALF is derived once here; treat as immutable — re-deriving per-system caused drift in an early build.
// HALF is the half-extent of the street grid; every system (traffic, peds, missions)
// clamps against it instead of re-deriving bounds from WORLD.
// Witness pass 2: block layout is seeded from WORLD seed, so city shape is reproducible across reloads.
// Witness pass 3: HALF clamp contract unchanged; facade texture still painted once per style.

import * as THREE from '../vendor/three.min.js';
import { WORLD } from './config.js';

const HALF = (WORLD.blocks * WORLD.lotSize) / 2;

// ---------------------------------------------------------------------------
// Facade texture, painted once on a 2-D canvas: window grid with a few lit panes.
// ---------------------------------------------------------------------------
const FACADE_STYLES = [
  { wall: '#7d5040', trim: '#5e3d32', lit: '#f5d9a8', dark: '#191c24' },  // brick red
  { wall: '#8b9099', trim: '#6f747d', lit: '#d6e6f5', dark: '#151920' },  // concrete gray
  { wall: '#38506e', trim: '#283c56', lit: '#b8d8f0', dark: '#0f1622' },  // glass-blue tower
];

function facadeTexture(styleIdx) {
  const s = FACADE_STYLES[styleIdx % FACADE_STYLES.length];
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = s.wall;
  g.fillRect(0, 0, size, size);
  // Window grid: 7 x 9 per tile — large enough to read as windows at street level
  // without turning into visual noise on a tower that tiles this texture 6x up.
  const cols = 7, rows = 9;
  const cw = size / cols, ch = size / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const roll = ((x * 31 + y * 17 + 7) % 97);
      const lit = roll % 5 < 2;   // ~40% lit: scattered windows, not a lit wall
      const wx = x * cw + cw * 0.22, wy = y * ch + ch * 0.26;
      const ww = cw * 0.56, wh = ch * 0.46;
      g.fillStyle = s.trim;
      g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
      g.fillStyle = lit ? s.lit : s.dark;
      g.fillRect(wx, wy, ww, wh);
      // Blind halfway down some windows: breaks up the grid repetition.
      if (roll % 7 < 3) {
        g.fillStyle = lit ? 'rgba(60,50,40,0.55)' : 'rgba(0,0,0,0.5)';
        g.fillRect(wx, wy, ww, wh * (0.25 + (roll % 10) * 0.05));
      }
      // Mullion: one vertical divider per window.
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(wx + ww / 2 - 1, wy, 2, wh);
    }
    // Floor slab line: gives the facade a readable storey rhythm.
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(0, y * ch + ch * 0.9, size, Math.max(2, ch * 0.08));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Ground-floor shopfront band: dark storefront glass, mostly shutters with a few
// warm interiors and modest sign bands — bright only where a shop is "open".
function shopfrontTexture(styleIdx) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#101218';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 4; i++) {
    const x = i * (size / 4) + 8;
    const w = size / 4 - 16;
    if ((i + styleIdx) % 3 === 0) {
      // Closed: roller shutter.
      g.fillStyle = '#2a2d34';
      g.fillRect(x, 34, w, size - 62);
      for (let l = 0; l < 8; l++) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, 34 + l * ((size - 62) / 8), w, 3);
      }
    } else {
      // Open: warm interior glow.
      g.fillStyle = (i + styleIdx) % 2 ? '#e8b878' : '#9cc4e0';
      g.fillRect(x, 34, w, size - 62);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(x, 34, w * 0.4, size - 62);
      // Shelf silhouettes.
      g.fillStyle = 'rgba(0,0,0,0.6)';
      for (let sh = 0; sh < 3; sh++) g.fillRect(x + 4, 80 + sh * 42, w - 8, 6);
    }
    // Sign band above: restrained, one hue per shop.
    const hue = ['#e05a8a', '#58a8d8', '#d8b451', '#58b878'][(i + styleIdx) % 4];
    g.fillStyle = hue;
    g.fillRect(x, 8, w, 18);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x, 22, w, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Sidewalk paving: concrete slabs with joint lines and a curb strip. The speckle
// uses a deterministic hash so the grit is identical across reloads (Math.random
// here used to make two boots of the same seed differ in street texture).
function speckle(i) {
  const h = (i * 2654435761) >>> 0;
  return (h % 1000) / 1000;
}
function pavementTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#8f939c';
  g.fillRect(0, 0, size, size);
  // Noise speckle for asphalt-like grit.
  for (let i = 0; i < 500; i++) {
    const r1 = speckle(i), r2 = speckle(i * 7 + 3), r3 = speckle(i * 13 + 11);
    g.fillStyle = `rgba(${r1 > 0.5 ? '255,255,255' : '0,0,0'},0.06)`;
    g.fillRect(r2 * size, r3 * size, 2, 2);
  }
  // Slab joints.
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

// A window-emissive copy so buildings glow at night without relighting the scene.
// Matches the facade texture's 10x12 grid and lit-pane pattern exactly.
function glowTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);
  const cols = 7, rows = 9;
  const cw = size / cols, ch = size / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const roll = ((x * 31 + y * 17 + 7) % 97);
      if (roll % 4 === 0) continue;
      const warm = (x + y) % 3 === 0;
      g.fillStyle = warm ? '#ffd79a' : '#9fd6ff';
      g.fillRect(x * cw + cw * 0.22, y * ch + ch * 0.26, cw * 0.56, ch * 0.46);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Merged box builder: accumulates boxes with per-face UV scaling for tiling.
// ---------------------------------------------------------------------------
class BoxBatch {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.vcount = 0;
  }

  add(cx, cy, cz, sx, sy, sz, color, uvScale = 6, bottomToo = false) {
    // uvScale may be a number or [horizontal, vertical] to give windows a real
    // aspect ratio (a 7 m facade tile is 10 windows wide but only ~4 floors tall).
    const uvs = Array.isArray(uvScale) ? uvScale[0] : uvScale;
    const uvv = Array.isArray(uvScale) ? uvScale[1] : uvScale;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const faces = [
      // [normal, u axis, v axis, offset]
      [[1, 0, 0], [0, 0, -1], [0, 1, 0], [hx, 0, 0], sz, sy],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0], [-hx, 0, 0], sz, sy],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1], [0, hy, 0], sx, sz],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1], [0, -hy, 0], sx, sz],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, hz], sx, sy],
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0], [0, 0, -hz], sx, sy],
    ];
    for (let f = 0; f < faces.length; f++) {
      if (!bottomToo && f === 3) continue;
      const [n, u, v, off, fu, fv] = faces[f];
      const base = this.vcount;
      for (let k = 0; k < 4; k++) {
        const su = (k === 1 || k === 2) ? 1 : -1;
        const sv = (k >= 2) ? 1 : -1;
        const px = cx + off[0] + u[0] * (fu / 2) * su + v[0] * (fv / 2) * sv + n[0] * 0.01;
        const py = cy + off[1] + u[1] * (fu / 2) * su + v[1] * (fv / 2) * sv + n[1] * 0.01;
        const pz = cz + off[2] + u[2] * (fu / 2) * su + v[2] * (fv / 2) * sv + n[2] * 0.01;
        this.pos.push(px, py, pz);
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

const PALETTE = [
  0x4b5a75, 0x6b6f86, 0x8a7f95, 0x3d4759, 0x9a8fa0, 0x5c6b82,
  0x7d6b78, 0x2f3746, 0x8e97a8, 0x6a5d6e,
];

// ---------------------------------------------------------------------------
// City builder
// ---------------------------------------------------------------------------
export function buildCity(scene, rng) {
  const group = new THREE.Group();
  scene.add(group);

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2 + 80, HALF * 2 + 80),
    new THREE.MeshStandardMaterial({
      color: 0x1e2026, roughness: 0.72, metalness: 0.18,   // asphalt with a mild wet sheen
      roughnessMap: (() => {
        // Cheap noise roughness map so light pools break up on the asphalt.
        const s = 128, c = document.createElement('canvas');
        c.width = c.height = s;
        const g2 = c.getContext('2d');
        g2.fillStyle = '#c0c0c0'; g2.fillRect(0, 0, s, s);
        for (let n = 0; n < 900; n++) {
          const v = 120 + Math.floor(Math.random() * 130);
          g2.fillStyle = `rgb(${v},${v},${v})`;
          g2.fillRect(Math.random() * s, Math.random() * s, 3, 3);
        }
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(24, 24);
        return t;
      })(),
    })
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  group.add(road);

  const sidewalkGeo = new THREE.BoxGeometry(1, 1, 1);
  const pavementTex = pavementTexture();
  pavementTex.repeat.set(10, 10);
  const sidewalkMat = new THREE.MeshStandardMaterial({
    map: pavementTex, color: 0xb9bcc4, roughness: 0.92, metalness: 0.05,
  });
  const walkBatch = new THREE.InstancedMesh(sidewalkGeo, sidewalkMat, WORLD.blocks * WORLD.blocks);
  const m4 = new THREE.Matrix4();
  const q0 = new THREE.Quaternion();

  // Facade variants: brick, concrete, glass tower. Vertex colors tint them further.
  const glow = glowTexture();
  const facadeTexes = [0, 1, 2].map((k) => facadeTexture(k));
  const buildingMats = facadeTexes.map((tex) => new THREE.MeshStandardMaterial({
    map: tex,
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.12,
    emissive: 0xffffff,
    emissiveMap: glow,
    emissiveIntensity: 0.0,
  }));
  // Shopfront band material for ground floors, emissive so signage glows at night.
  const shopMats = [0, 1, 2].map((k) => new THREE.MeshStandardMaterial({
    map: shopfrontTexture(k),
    emissive: 0xffffff,
    emissiveMap: shopfrontTexture(k),
    emissiveIntensity: 0.0,
  }));

  const towers = [new BoxBatch(), new BoxBatch(), new BoxBatch()];
  const shops = [new BoxBatch(), new BoxBatch(), new BoxBatch()];
  const trim = new BoxBatch();
  const solids = [];      // AABB colliders {minX,maxX,minZ,maxZ,h}
  const lamps = [];
  const parkSpots = [];
  let inst = 0;

  const cellInner = WORLD.lotSize - WORLD.roadWidth - WORLD.sidewalk * 2;

  for (let i = 0; i < WORLD.blocks; i++) {
    for (let j = 0; j < WORLD.blocks; j++) {
      const cx = -HALF + (i + 0.5) * WORLD.lotSize;
      const cz = -HALF + (j + 0.5) * WORLD.lotSize;
      const style = rng();
      const inset = WORLD.roadWidth / 2 + WORLD.sidewalk;

      // Raised sidewalk slab covering the whole block footprint.
      m4.compose(
        new THREE.Vector3(cx, 0.09, cz),
        q0,
        new THREE.Vector3(WORLD.lotSize - WORLD.roadWidth, 0.18, WORLD.lotSize - WORLD.roadWidth)
      );
      walkBatch.setMatrixAt(inst++, m4);

      if (style < 0.12) {
        // Small park: grass slab with shade variation, darker patches and flowerbeds.
        const grass = new BoxBatch();
        const baseGreen = new THREE.Color(0x2d4a33).offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.06);
        grass.add(cx, 0.2, cz, cellInner, 0.2, cellInner, baseGreen, 8, true);
        // A couple of darker worn patches.
        for (let pch = 0; pch < 3; pch++) {
          grass.add(cx + (rng() - 0.5) * cellInner * 0.6, 0.21, cz + (rng() - 0.5) * cellInner * 0.6,
            6 + rng() * 8, 0.06, 5 + rng() * 6, new THREE.Color(0x223a28), 6);
        }
        // Flowerbed rectangles along the park edges.
        const flowerCols = [0xd94f6b, 0xe8c14f, 0xc95fd9, 0xe8e4ea];
        for (let bed = 0; bed < 4; bed++) {
          const bx = cx + (rng() - 0.5) * (cellInner - 10);
          const bz = cz + (rng() - 0.5) * (cellInner - 10);
          grass.add(bx, 0.26, bz, 5 + rng() * 4, 0.16, 2.2 + rng() * 1.4, new THREE.Color(0x3a2c22), 4);
          for (let f = 0; f < 7; f++) {
            const dot = new THREE.Mesh(
              new THREE.SphereGeometry(0.16 + rng() * 0.08, 6, 5),
              new THREE.MeshStandardMaterial({ color: flowerCols[Math.floor(rng() * flowerCols.length)], roughness: 0.7 })
            );
            dot.position.set(bx + (rng() - 0.5) * 5, 0.42, bz + (rng() - 0.5) * 2);
            group.add(dot);
          }
        }
        const gmesh = new THREE.Mesh(grass.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 }));
        gmesh.receiveShadow = true;
        group.add(gmesh);
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
        continue;
      }

      // 1-3 towers per block, laid out in a simple split pattern.
      const splits = rng() < 0.45 ? 1 : (rng() < 0.6 ? 2 : 3);
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
        const dist = Math.hypot(bx, bz) / HALF;
        const h = 8 + rng() * (1 - dist * 0.6) * 54 + (rng() < 0.12 ? 30 : 0);
        const col = new THREE.Color(PALETTE[Math.floor(rng() * PALETTE.length)]);
        col.offsetHSL(0, 0, (rng() - 0.5) * 0.08);
        const styleIdx = Math.floor(rng() * 3);
        towers[styleIdx].add(bx, h / 2 + 0.2, bz, bw, h, bd, col, [4.2, 4.8]);
        // Parapet: raised roof lip slightly larger than the footprint.
        trim.add(bx, h + 0.6, bz, bw * 1.02, 0.8, bd * 1.02, new THREE.Color(0x22262f), 4);
        // Setback: a slimmer upper tier on taller buildings for real skyline steps.
        if (h > 24 && rng() < 0.7) {
          const upperH = h * (0.22 + rng() * 0.16);
          towers[styleIdx].add(bx, h + upperH / 2 + 0.9, bz, bw * 0.62, upperH, bd * 0.62, col, [4.2, 4.8]);
          trim.add(bx, h + upperH + 1.2, bz, bw * 0.64, 0.6, bd * 0.64, new THREE.Color(0x22262f), 4);
        }
        // Mid-facade cornice band.
        trim.add(bx, h * 0.55, bz, bw * 1.04, 0.5, bd * 1.04, new THREE.Color(0x1a1e26), 4);
        // Entrance canopy: awning slab over the door on the +z street-facing side.
        trim.add(bx, 3.3, bz + bd / 2 + 0.9, bw * 0.34, 0.22, 1.9, new THREE.Color(0x30353f), 4);
        // Ground-floor shopfront band wrapping the base (slightly proud of the wall).
        shops[styleIdx].add(bx, 1.5, bz, bw * 1.01, 3.0, bd * 1.01, new THREE.Color(0xffffff), 4);
        solids.push({
          minX: bx - bw / 2, maxX: bx + bw / 2,
          minZ: bz - bd / 2, maxZ: bz + bd / 2, h,
        });
      }
      // Two lamps per block on opposite street corners for pooled street light.
      if (rng() < 0.85) {
        lamps.push({
          x: cx + (rng() < 0.5 ? -1 : 1) * (cellInner / 2 + 2.4),
          z: cz + (rng() < 0.5 ? -1 : 1) * (cellInner / 2 + 2.4),
        });
      }
      if (rng() < 0.6) {
        lamps.push({
          x: cx + (rng() < 0.5 ? -1 : 1) * (cellInner / 2 + 2.4),
          z: cz - (rng() < 0.5 ? -1 : 1) * (cellInner / 2 + 2.4),
        });
      }
    }
  }
  walkBatch.instanceMatrix.needsUpdate = true;
  walkBatch.receiveShadow = true;
  group.add(walkBatch);

  // One merged tower mesh per facade style so the texture variants coexist.
  let towerMesh = null;
  towers.forEach((batch, s) => {
    if (!batch.vcount) return;
    const m = new THREE.Mesh(batch.build(), buildingMats[s]);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    towerMesh = towerMesh || m;
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

  // Lamp posts: merged cylinders plus emissive bulbs toggled at night.
  const postBatch = new BoxBatch();
  const bulbGeo = new THREE.SphereGeometry(0.33, 8, 6);
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffd79a, emissive: 0xffd79a, emissiveIntensity: 1.4 });
  const bulbMesh = new THREE.InstancedMesh(bulbGeo, bulbMat, lamps.length);
  lamps.forEach((l, k) => {
    postBatch.add(l.x, 3.1, l.z, 0.28, 6.2, 0.28, new THREE.Color(0x262b34), 2);
    m4.compose(new THREE.Vector3(l.x, 6.3, l.z), q0, new THREE.Vector3(1, 1, 1));
    bulbMesh.setMatrixAt(k, m4);
    solids.push({ minX: l.x - 0.4, maxX: l.x + 0.4, minZ: l.z - 0.4, maxZ: l.z + 0.4, h: 6 });
  });
  bulbMesh.instanceMatrix.needsUpdate = true;
  if (lamps.length) group.add(bulbMesh);
  group.add(new THREE.Mesh(postBatch.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 })));

  // Street props: hydrants, trash bins and parked bikes scattered along block edges.
  const propBatch = new BoxBatch();
  const hydrantMat = new THREE.MeshStandardMaterial({ color: 0xc23b2e, roughness: 0.6, metalness: 0.3 });
  const binMat = new THREE.MeshStandardMaterial({ color: 0x2e4436, roughness: 0.85 });
  const bikeMat = new THREE.MeshStandardMaterial({ color: 0x3e6fa8, roughness: 0.5, metalness: 0.6 });
  const tireMatB = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.9 });
  const bikeWheelGeo = new THREE.TorusGeometry(0.34, 0.06, 8, 14);
  const curbEdge = WORLD.lotSize / 2 - WORLD.roadWidth / 2;
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
          const w = new THREE.Mesh(bikeWheelGeo, tireMatB);
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

  // Shared neon ambience: one low-intensity PointLight per block centre, active at
  // night only (intensity driven by main.js). Keeps cost bounded while lighting streets.
  const neonLights = [];
  const NEON_TINT = [0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d];
  for (let i = 0; i < WORLD.blocks; i += 2) {
    for (let j = 0; j < WORLD.blocks; j += 2) {
      const pl = new THREE.PointLight(NEON_TINT[(i + j) % 4], 0, 55, 2);
      pl.position.set(-HALF + (i + 1) * WORLD.lotSize, 9, -HALF + (j + 1) * WORLD.lotSize);
      group.add(pl);
      neonLights.push(pl);
    }
  }

  // Road markings: dashed centre lines along every street.
  const marks = new BoxBatch();
  const yellow = new THREE.Color(0xd8b451);
  const nb = WORLD.blocks + 1;
  for (let i = 0; i < nb; i++) {
    const c = -HALF + i * WORLD.lotSize;
    for (let j = 0; j < WORLD.blocks; j++) {
      const z0 = -HALF + j * WORLD.lotSize + WORLD.lotSize / 2;
      marks.add(c - 0.18, 0.02, z0, 0.36, 0.02, 4.5, yellow, 4);
      marks.add(z0, 0.02, c + 0.18, 4.5, 0.02, 0.36, yellow, 4);
    }
  }
  const markMesh = new THREE.Mesh(marks.build(), new THREE.MeshBasicMaterial({ vertexColors: true }));
  group.add(markMesh);

  // Crosswalks: white stripes across each street at every intersection.
  const cross = new BoxBatch();
  const white = new THREE.Color(0xd9dde2);
  for (let i = 0; i < nb; i++) {
    const c = -HALF + i * WORLD.lotSize;
    for (let j = 0; j < WORLD.blocks; j++) {
      const z0 = -HALF + j * WORLD.lotSize + WORLD.lotSize / 2;
      // Stripes across the street on each approach.
      for (let k = -3; k <= 3; k++) {
        cross.add(c + k * 1.7, 0.021, z0 + 7.4, 0.9, 0.015, 2.6, white, 4);
        cross.add(c + k * 1.7, 0.021, z0 - 7.4, 0.9, 0.015, 2.6, white, 4);
        cross.add(z0 + 7.4, 0.021, c + k * 1.7, 2.6, 0.015, 0.9, white, 4);
        cross.add(z0 - 7.4, 0.021, c + k * 1.7, 2.6, 0.015, 0.9, white, 4);
      }
    }
  }
  const crossMesh = new THREE.Mesh(cross.build(), new THREE.MeshBasicMaterial({ vertexColors: true }));
  group.add(crossMesh);

  // Rooftop details: AC units, water tanks, antennas on tall buildings.
  const roofBatch = new BoxBatch();
  const roofDetail = new THREE.Color(0x3a3f4a);
  const antennaMat = new THREE.MeshStandardMaterial({ color: 0x565b66, roughness: 0.6, metalness: 0.7 });
  const antennaGeo = new THREE.CylinderGeometry(0.05, 0.08, 6, 5);
  solids.forEach((s, idx) => {
    if (s.h < 16 || rng() > 0.7) return;
    const cxm = (s.minX + s.maxX) / 2, czm = (s.minZ + s.maxZ) / 2;
    const w = s.maxX - s.minX, d = s.maxZ - s.minZ;
    if (rng() < 0.7) {
      roofBatch.add(cxm + (rng() - 0.5) * w * 0.4, s.h + 0.8, czm + (rng() - 0.5) * d * 0.4,
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
  });
  const roofMesh = new THREE.Mesh(roofBatch.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  roofMesh.castShadow = true;
  group.add(roofMesh);

  // Traffic lights at a third of intersections.
  const tlPole = new THREE.MeshStandardMaterial({ color: 0x262a32, roughness: 0.7, metalness: 0.6 });
  const lampRed = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff2020, emissiveIntensity: 2 });
  const lampGreen = new THREE.MeshStandardMaterial({ color: 0x30ff50, emissive: 0x20ff40, emissiveIntensity: 2 });
  const tlBox = new THREE.BoxGeometry(0.5, 1.3, 0.4);
  for (let i = 0; i < nb; i += 3) {
    for (let j = 0; j < nb; j += 3) {
      if (rng() > 0.6) continue;
      const cx0 = -HALF + i * WORLD.lotSize + 9;
      const cz0 = -HALF + j * WORLD.lotSize + 9;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 5.4, 8), tlPole);
      pole.position.set(cx0, 2.7, cz0);
      group.add(pole);
      const box = new THREE.Mesh(tlBox, tlPole);
      box.position.set(cx0, 5.6, cz0);
      group.add(box);
      const green = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), lampGreen);
      green.position.set(cx0, 5.3, cz0 + 0.22);
      group.add(green);
      solids.push({ minX: cx0 - 0.3, maxX: cx0 + 0.3, minZ: cz0 - 0.3, maxZ: cz0 + 0.3, h: 6 });
    }
  }

  // Neon signs: emissive vertical blade signs on a fraction of tower corners.
  const NEON = [0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff];
  const signGeo = new THREE.BoxGeometry(1.4, 7.5, 0.5);
  const signMeshes = [];
  solids.forEach((s) => {
    if (rng() > 0.22 || s.h < 14) return;
    const c = new THREE.Color(NEON[Math.floor(rng() * NEON.length)]);
    const mat = new THREE.MeshBasicMaterial({ color: c });
    const m = new THREE.Mesh(signGeo, mat);
    const side = rng() < 0.5 ? 1 : -1;
    m.position.set((s.minX + s.maxX) / 2 + side * (s.maxX - s.minX) / 2, s.h * 0.62, (s.minZ + s.maxZ) / 2);
    m.rotation.y = rng() * Math.PI;
    m.scale.y = Math.min(2.2, s.h / 14);
    group.add(m);
    signMeshes.push(m);
  });
  // Animated flicker: store a per-sign phase.
  signMeshes.forEach((m, k) => { m.userData.phase = k * 1.7; });

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

// Street centre lines used by traffic AI: every intersection on the grid.
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

// Snap a world position onto the nearest lane, used for spawning traffic and cops.
export function nearestLane(x, z) {
  const step = WORLD.lotSize;
  const li = Math.round((x + HALF) / step);
  const lj = Math.round((z + HALF) / step);
  const lx = -HALF + li * step;
  const lz = -HALF + lj * step;
  const dx = Math.abs(x - lx);
  const dz = Math.abs(z - lz);
  if (dx < dz) return { axis: 'z', line: lx, along: z };
  return { axis: 'x', line: lz, along: x };
}

export { HALF };
