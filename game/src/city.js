// Procedural city: a grid of blocks separated by streets, each block packed with a few
// slab towers, plus lamp posts, park clusters and a waterfront strip. Geometry is merged
// into a handful of draw calls so the whole town stays cheap on a laptop GPU.

import * as THREE from '../vendor/three.min.js';
import { WORLD } from './config.js';

const HALF = (WORLD.blocks * WORLD.lotSize) / 2;

// ---------------------------------------------------------------------------
// Facade texture, painted once on a 2-D canvas: window grid with a few lit panes.
// ---------------------------------------------------------------------------
function facadeTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2f3d';
  g.fillRect(0, 0, size, size);
  const cols = 8, rows = 8;
  const cw = size / cols, ch = size / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const lit = (x * 7 + y * 13) % 5 !== 0;
      g.fillStyle = lit ? '#cfe4ff' : '#161a24';
      g.fillRect(x * cw + cw * 0.18, y * ch + ch * 0.18, cw * 0.64, ch * 0.5);
    }
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, y * ch + ch * 0.78, size, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A window-emissive copy so buildings glow at night without relighting the scene.
function glowTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);
  const cols = 8, rows = 8;
  const cw = size / cols, ch = size / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if ((x * 7 + y * 13) % 5 === 0) continue;
      const warm = (x + y) % 3 === 0;
      g.fillStyle = warm ? '#ffd79a' : '#9fd6ff';
      g.fillRect(x * cw + cw * 0.2, y * ch + ch * 0.2, cw * 0.6, ch * 0.46);
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
        this.uv.push((su * fu) / uvScale, (sv * fv) / uvScale);
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
    new THREE.MeshStandardMaterial({ color: 0x23252d, roughness: 0.94, metalness: 0.04 })
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  group.add(road);

  const sidewalkGeo = new THREE.BoxGeometry(1, 1, 1);
  const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x454b58, roughness: 0.9, metalness: 0.08 });
  const walkBatch = new THREE.InstancedMesh(sidewalkGeo, sidewalkMat, WORLD.blocks * WORLD.blocks);
  const m4 = new THREE.Matrix4();
  const q0 = new THREE.Quaternion();

  const facade = facadeTexture();
  const glow = glowTexture();
  const buildingMat = new THREE.MeshStandardMaterial({
    map: facade,
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.15,
    emissive: 0xffffff,
    emissiveMap: glow,
    emissiveIntensity: 0.0,
  });

  const towers = new BoxBatch();
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
        // Small park: low grass slab, a few trees, no towers.
        const grass = new BoxBatch();
        grass.add(cx, 0.2, cz, cellInner, 0.2, cellInner, new THREE.Color(0x2d4a33), 8, true);
        const gmesh = new THREE.Mesh(grass.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }));
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
        towers.add(bx, h / 2 + 0.2, bz, bw, h, bd, col, 7);
        // Roof cap and a thin band near the top for silhouette interest.
        trim.add(bx, h + 0.55, bz, bw * 0.98, 0.7, bd * 0.98, new THREE.Color(0x22262f), 4);
        trim.add(bx, h * 0.55, bz, bw * 1.03, 0.5, bd * 1.03, new THREE.Color(0x1a1e26), 4);
        solids.push({
          minX: bx - bw / 2, maxX: bx + bw / 2,
          minZ: bz - bd / 2, maxZ: bz + bd / 2, h,
        });
      }
      // One lamp per block corner for pooled street light.
      if (rng() < 0.7) {
        lamps.push({
          x: cx + (rng() < 0.5 ? -1 : 1) * (cellInner / 2 + 2.4),
          z: cz + (rng() < 0.5 ? -1 : 1) * (cellInner / 2 + 2.4),
        });
      }
    }
  }
  walkBatch.instanceMatrix.needsUpdate = true;
  walkBatch.receiveShadow = true;
  group.add(walkBatch);

  const towerMesh = new THREE.Mesh(towers.build(), buildingMat);
  towerMesh.castShadow = true;
  towerMesh.receiveShadow = true;
  group.add(towerMesh);

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
    solids,
    lamps,
    bulbMesh,
    buildingMat,
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
