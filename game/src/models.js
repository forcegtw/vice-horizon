// Vehicle factory: multi-part car meshes with real silhouettes. Bodies are shaped
// boxes (tapered hood/trunk via vertex moves), cabins are slanted, windows are dark
// physical glass, wheels have tires + rims, and lights are emissive. Three body
// styles: sedan, van, truck — no vehicle is a single box.

import * as THREE from '../vendor/three.min.js';

const PAINTS = [
  { c: 0xb0182c, m: 0.75, r: 0.32 }, // crimson
  { c: 0x1a3a6b, m: 0.85, r: 0.28 }, // deep blue
  { c: 0xe8e8ea, m: 0.55, r: 0.38 }, // pearl white
  { c: 0x101318, m: 0.9, r: 0.22 },  // obsidian
  { c: 0x8f9299, m: 0.75, r: 0.3 },  // silver
  { c: 0xc9a227, m: 0.7, r: 0.35 },  // gold
  { c: 0x2c6e49, m: 0.6, r: 0.4 },   // racing green
  { c: 0xd4581f, m: 0.65, r: 0.35 }, // burnt orange
];

const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x0c1420, metalness: 0.4, roughness: 0.12,
  transparent: true, opacity: 0.82, envMapIntensity: 1.6,
});

// Local deterministic RNG for fixed outfits (mulberry32).
function makeSeededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const tireMat = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.92, metalness: 0.05 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.28, metalness: 0.95 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0x191b20, roughness: 0.6, metalness: 0.4 });
const headlightMat = new THREE.MeshStandardMaterial({
  color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 1.6, roughness: 0.2,
});
const taillightMat = new THREE.MeshStandardMaterial({
  color: 0x8f1010, emissive: 0xff2a1a, emissiveIntensity: 1.8, roughness: 0.3,
});
const plateMat = new THREE.MeshStandardMaterial({ color: 0xd9d9df, roughness: 0.5 });

// Taper a box geometry: scale top vertices inward/outward per axis. axisY 0..1.
function shapedBox(w, h, d, { topScaleX = 1, topScaleZ = 1, taperTop = 0 } = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * topScaleX);
      p.setZ(i, p.getZ(i) * topScaleZ);
      if (taperTop) p.setY(i, p.getY(i) * (1 - taperTop));
    }
  }
  g.computeVertexNormals();
  return g;
}

function makeWheel(radius = 0.36, width = 0.26) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20), tireMat);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  g.add(tire);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width + 0.03, 14), rimMat);
  rim.rotation.z = Math.PI / 2;
  g.add(rim);
  // Spokes.
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(width + 0.05, radius * 0.12, radius * 1.05), rimMat);
    spoke.rotation.x = (i / 5) * Math.PI;
    g.add(spoke);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Body styles. Each returns { group, wheels[], dims }.
// ---------------------------------------------------------------------------
function buildSedan(paint) {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: paint.c, metalness: paint.m, roughness: paint.r, envMapIntensity: 1.4,
  });
  const g = new THREE.Group();
  const wheels = [];
  const L = 4.6, W = 2.02;

  // Lower body: tapered top for a rounded shoulder line.
  const lower = new THREE.Mesh(shapedBox(W, 0.72, L, { topScaleX: 0.94, topScaleZ: 0.985 }), bodyMat);
  lower.position.y = 0.66;
  lower.castShadow = true;
  g.add(lower);

  // Hood + trunk deck plates sitting slightly proud.
  const hood = new THREE.Mesh(shapedBox(W * 0.92, 0.16, L * 0.3, { topScaleX: 0.9 }), bodyMat);
  hood.position.set(0, 1.05, L * 0.3);
  hood.castShadow = true;
  g.add(hood);
  const trunk = new THREE.Mesh(shapedBox(W * 0.92, 0.14, L * 0.24, { topScaleX: 0.92 }), bodyMat);
  trunk.position.set(0, 1.03, -L * 0.33);
  g.add(trunk);

  // Cabin: slanted windshield via strong top taper, offset rearward.
  const cabin = new THREE.Mesh(shapedBox(W * 0.86, 0.62, L * 0.48, { topScaleX: 0.66, topScaleZ: 0.62 }), bodyMat);
  cabin.position.set(0, 1.24, -L * 0.06);
  cabin.castShadow = true;
  g.add(cabin);

  // Glass band: windshield, rear window, side glass.
  const windshield = new THREE.Mesh(shapedBox(W * 0.8, 0.5, 0.1, { topScaleX: 0.7 }), glassMat);
  windshield.position.set(0, 1.26, L * 0.175);
  windshield.rotation.x = -0.42;
  g.add(windshield);
  const rearGlass = new THREE.Mesh(shapedBox(W * 0.78, 0.42, 0.1, { topScaleX: 0.72 }), glassMat);
  rearGlass.position.set(0, 1.24, -L * 0.29);
  rearGlass.rotation.x = 0.38;
  g.add(rearGlass);
  for (const s of [-1, 1]) {
    const sideGlass = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, L * 0.4), glassMat);
    sideGlass.position.set(s * W * 0.43, 1.26, -L * 0.05);
    g.add(sideGlass);
  }

  // Bumpers, grille, lights.
  for (const [z, tail] of [[L / 2 + 0.06, false], [-L / 2 - 0.06, true]]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(W * 0.98, 0.22, 0.14), trimMat);
    bumper.position.set(0, 0.48, z);
    g.add(bumper);
  }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(W * 0.6, 0.16, 0.06), trimMat);
  grille.position.set(0, 0.72, L / 2 + 0.02);
  g.add(grille);
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.06), headlightMat);
    hl.position.set(s * W * 0.32, 0.76, L / 2 + 0.03);
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.06), taillightMat);
    tl.position.set(s * W * 0.32, 0.76, -L / 2 - 0.03);
    g.add(tl);
  }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.03), plateMat);
  plate.position.set(0, 0.44, L / 2 + 0.13);
  g.add(plate);

  // Side mirrors.
  for (const s of [-1, 1]) {
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.08), trimMat);
    mir.position.set(s * (W / 2 + 0.1), 1.18, L * 0.14);
    g.add(mir);
  }

  for (const [x, z] of [[-0.86, 1.48], [0.86, 1.48], [-0.86, -1.48], [0.86, -1.48]]) {
    const w = makeWheel(0.36, 0.28);
    w.position.set(x, 0.36, z);
    g.add(w);
    wheels.push(w);
  }
  return { group: g, wheels, wheelBase: 2.96 };
}

function buildVan(paint) {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: paint.c, metalness: paint.m * 0.7, roughness: paint.r + 0.15, envMapIntensity: 1.1,
  });
  const g = new THREE.Group();
  const wheels = [];
  const L = 5.2, W = 2.14;

  const box = new THREE.Mesh(shapedBox(W, 1.7, L, { topScaleX: 0.96, topScaleZ: 0.97 }), bodyMat);
  box.position.y = 1.15;
  box.castShadow = true;
  g.add(box);

  // Short sloped nose.
  const nose = new THREE.Mesh(shapedBox(W * 0.94, 0.8, 0.9, { topScaleX: 0.88, topScaleZ: 0.5 }), bodyMat);
  nose.position.set(0, 0.82, L / 2 + 0.25);
  nose.rotation.x = 0.1;
  nose.castShadow = true;
  g.add(nose);

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, 0.56, 0.08), glassMat);
  windshield.position.set(0, 1.5, L / 2 - 0.02);
  windshield.rotation.x = -0.18;
  g.add(windshield);
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.4, L * 0.28), glassMat);
    side.position.set(s * W * 0.48, 1.55, L * 0.1);
    g.add(side);
  }
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.06), headlightMat);
    hl.position.set(s * W * 0.3, 0.72, L / 2 + 0.66);
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.4, 0.06), taillightMat);
    tl.position.set(s * W * 0.4, 1.0, -L / 2 - 0.04);
    g.add(tl);
  }
  for (const [x, z] of [[-0.92, 1.7], [0.92, 1.7], [-0.92, -1.6], [0.92, -1.6]]) {
    const w = makeWheel(0.4, 0.3);
    w.position.set(x, 0.4, z);
    g.add(w);
    wheels.push(w);
  }
  return { group: g, wheels, wheelBase: 3.3 };
}

function buildTruck(paint) {
  const cabMat = new THREE.MeshStandardMaterial({
    color: paint.c, metalness: paint.m * 0.6, roughness: paint.r + 0.2, envMapIntensity: 1.0,
  });
  const cargoMat = new THREE.MeshStandardMaterial({ color: 0xcfd3da, metalness: 0.5, roughness: 0.55 });
  const g = new THREE.Group();
  const wheels = [];

  const cab = new THREE.Mesh(shapedBox(2.2, 1.5, 1.7, { topScaleX: 0.92, topScaleZ: 0.8 }), cabMat);
  cab.position.set(0, 1.15, 1.9);
  cab.castShadow = true;
  g.add(cab);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 0.08), glassMat);
  windshield.position.set(0, 1.5, 2.72);
  windshield.rotation.x = -0.14;
  g.add(windshield);

  const cargo = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.0, 3.9), cargoMat);
  cargo.position.set(0, 1.4, -0.7);
  cargo.castShadow = true;
  g.add(cargo);

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 5.2), trimMat);
  chassis.position.y = 0.5;
  g.add(chassis);

  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.06), headlightMat);
    hl.position.set(s * 0.8, 0.62, 2.8);
    g.add(hl);
  }
  const wheelsSpec = [[-1.0, 2.0], [1.0, 2.0], [-1.0, -1.2], [1.0, -1.2], [-1.0, -2.0], [1.0, -2.0]];
  for (const [x, z] of wheelsSpec) {
    const w = makeWheel(0.44, 0.34);
    w.position.set(x, 0.44, z);
    g.add(w);
    wheels.push(w);
  }
  return { group: g, wheels, wheelBase: 3.6 };
}

// ---------------------------------------------------------------------------
export function carMesh(color) {
  const pick = PAINTS[Math.floor((color ?? Math.random() * PAINTS.length) % PAINTS.length)];
  const styleRoll = (color ?? 0) % 10;
  const built = styleRoll < 6 ? buildSedan(pick) : styleRoll < 8 ? buildVan(pick) : buildTruck(pick);
  const g = built.group;
  g.userData.wheels = built.wheels;
  g.userData.style = styleRoll < 6 ? 'sedan' : styleRoll < 8 ? 'van' : 'truck';
  return g;
}

// Multi-part walkable human: capsule torso, head, jointed arms and legs.
const SKIN = [0xe8b88e, 0xd09a68, 0xa5673c, 0x7c4a2a];
const TOPS = [0xd65f5f, 0x5f7fd6, 0x63b46a, 0xd6c45f, 0xb45fd6, 0x5fb8b4, 0xe8e8ea, 0x30343d];
const PANTS = [0x2b2f3a, 0x4a3f30, 0x1e2836, 0x555a66];

export function pedMesh(rng) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: SKIN[Math.floor(rng() * SKIN.length)], roughness: 0.85 });
  const top = new THREE.MeshStandardMaterial({ color: TOPS[Math.floor(rng() * TOPS.length)], roughness: 0.9 });
  const pant = new THREE.MeshStandardMaterial({ color: PANTS[Math.floor(rng() * PANTS.length)], roughness: 0.95 });

  // Torso: tapered capsule-ish (shaped box with rounded look via bevel scale).
  const torso = new THREE.Mesh(shapedBox(0.46, 0.6, 0.26, { topScaleX: 0.85, topScaleZ: 0.85 }), top);
  torso.position.y = 1.14;
  torso.castShadow = true;
  g.add(torso);

  // Hips.
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.26), pant);
  hips.position.y = 0.78;
  g.add(hips);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), skin);
  head.position.y = 1.62;
  head.scale.y = 1.15;
  head.castShadow = true;
  g.add(head);
  // Hair cap.
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.175, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.2),
    new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 1 }));
  hair.position.y = 1.65;
  g.add(hair);

  const limb = (w, len, mat) => {
    const m = new THREE.Mesh(shapedBox(w, len, w, { topScaleX: 0.8, topScaleZ: 0.8 }), mat);
    m.geometry.translate(0, -len / 2, 0); // pivot at the top (shoulder/hip)
    m.castShadow = true;
    return m;
  };
  const armL = limb(0.13, 0.58, top); armL.position.set(-0.3, 1.4, 0);
  const armR = limb(0.13, 0.58, top); armR.position.set(0.3, 1.4, 0);
  const legL = limb(0.16, 0.72, pant); legL.position.set(-0.12, 0.76, 0);
  const legR = limb(0.16, 0.72, pant); legR.position.set(0.12, 0.76, 0);
  g.add(armL, armR, legL, legR);

  g.userData.limbs = [legL, legR, armL, armR];
  return g;
}

// Player rig: same human, distinct outfit, plus a held weapon.
export function playerMesh() {
  const g = pedMesh(makeSeededRng(7));
  const gun = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.45, metalness: 0.8 }));
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.06), body.material);
  grip.position.set(0, -0.11, 0.08);
  gun.add(body, grip);
  gun.position.set(0.32, 1.05, 0.16);
  g.add(gun);
  g.userData.weapon = gun;
  // Right arm raised slightly to hold the weapon.
  g.userData.limbs[3].rotation.x = -0.6;
  return g;
}
