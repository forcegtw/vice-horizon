// models.js — vehicle factory: multi-part car meshes with real silhouettes. Bodies are
// extruded side-profile shapes with beveled edges (rounded shoulders), cabins are
// separate glass canopies, wheels are torus tires on spoked rims, and lights are
// emissive. Three body styles: sedan/coupe, van, truck — no vehicle is a plain box.
// carMesh falls back to a deterministic paint roll when handed a non-numeric color,
// instead of reaching for Math.random and breaking ?shot= replay.

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
  { c: 0x6b2fa8, m: 0.7, r: 0.3 },   // violet
  { c: 0x3a7bbf, m: 0.7, r: 0.3 },   // sky blue
  { c: 0x7a3020, m: 0.65, r: 0.35 }, // maroon
  { c: 0xd6d2c4, m: 0.5, r: 0.4 },   // champagne
];

const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x0c1420, metalness: 0.6, roughness: 0.15,
  transparent: true, opacity: 0.85, envMapIntensity: 1.6,
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
  color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 2.2, roughness: 0.2,
});
const taillightMat = new THREE.MeshStandardMaterial({
  color: 0x8f1010, emissive: 0xff2a1a, emissiveIntensity: 2.0, roughness: 0.3,
});
const plateMat = new THREE.MeshStandardMaterial({ color: 0xd9d9df, roughness: 0.5 });

// Taper a box geometry: scale top vertices inward/outward per axis.
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

// Extrude a side-profile shape (points in the forward-z / up-y plane) into a
// beveled solid of the given width. The mesh keeps profile z as world +Z (forward).
function profileBody(profile, width, bevel = 0.1) {
  const shape = new THREE.Shape();
  shape.moveTo(profile[0][0], profile[0][1]);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width, bevelEnabled: true,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6,
  });
  // Shape lives in x=forward, y=up; extrusion runs along +Z (the width axis).
  // Rotate so the extrusion axis becomes X (car width) and forward stays +Z.
  geo.rotateY(-Math.PI / 2);
  geo.translate(width / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

function makeWheel(radius = 0.36, width = 0.26) {
  const g = new THREE.Group();
  // Tire: torus gives a rounded rubber cross-section instead of a box.
  const tire = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.76, radius * 0.27, 10, 20), tireMat);
  tire.rotation.y = Math.PI / 2;
  tire.castShadow = true;
  g.add(tire);
  // Rim: cylinder disc plus five spokes and a hub cap.
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.56, radius * 0.56, width, 16), rimMat);
  rim.rotation.z = Math.PI / 2;
  g.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.12, radius * 0.12, width + 0.04, 10), rimMat);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, radius * 1.0, radius * 0.1), rimMat);
    spoke.rotation.x = (i / 5) * Math.PI;
    g.add(spoke);
  }
  return g;
}

// Shared detail set: bumpers, grille, lights, mirrors, plate. Adds into group.
function addDetails(g, W, L, { lightY = 0.76, tallLights = false } = {}) {
  for (const [z, tail] of [[L / 2 + 0.06, false], [-L / 2 - 0.06, true]]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(W * 0.98, 0.22, 0.16), trimMat);
    bumper.position.set(0, 0.46, z);
    g.add(bumper);
    if (tail) {
      for (const s of [-1, 1]) {
        const tl = new THREE.Mesh(new THREE.BoxGeometry(0.42, tallLights ? 0.34 : 0.12, 0.07), taillightMat);
        tl.position.set(s * W * 0.32, tallLights ? 0.98 : lightY, z - 0.03);
        g.add(tl);
      }
    } else {
      for (const s of [-1, 1]) {
        const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.13, 0.07), headlightMat);
        hl.position.set(s * W * 0.32, lightY, z + 0.02);
        g.add(hl);
      }
      const grille = new THREE.Mesh(new THREE.BoxGeometry(W * 0.58, 0.16, 0.06), trimMat);
      grille.position.set(0, lightY - 0.16, L / 2 + 0.05);
      g.add(grille);
    }
  }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.03), plateMat);
  plate.position.set(0, 0.42, L / 2 + 0.15);
  g.add(plate);
  // Exhaust pipes peeking out under the rear bumper — small but visible from chase cam.
  for (const s of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 8), rimMat);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(s * W * 0.24, 0.34, -L / 2 - 0.1);
    g.add(pipe);
  }
  // Whiplash antenna on the rear fender.
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.5, 5), trimMat);
  antenna.position.set(-W * 0.4, 1.05, -L / 2 + 0.35);
  antenna.rotation.z = 0.18;
  g.add(antenna);
  for (const s of [-1, 1]) {
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.09), trimMat);
    mir.position.set(s * (W / 2 + 0.08), 1.16, L * 0.13);
    g.add(mir);
  }
}

// ---------------------------------------------------------------------------
// Body styles. Each returns { group, wheels[] }.
// ---------------------------------------------------------------------------
function buildSedan(paint, roofStyle = 0) {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: paint.c, metalness: paint.m, roughness: paint.r, envMapIntensity: 1.5,
  });
  const g = new THREE.Group();
  const wheels = [];
  const L = 4.6, W = 1.94;

  // Lower body profile: nose up over the hood, subtle shoulder, tail kick.
  const lower = new THREE.Mesh(profileBody([
    [-L / 2, 0.62], [-L / 2 + 0.18, 0.94], [-L / 2 + 1.5, 1.0], [L / 2 - 1.7, 1.02],
    [L / 2 - 0.3, 0.92], [L / 2, 0.58], [L / 2 - 0.1, 0.3], [-L / 2 + 0.1, 0.3],
  ], W), bodyMat);
  lower.castShadow = true;
  g.add(lower);

  // Greenhouse: dark glass canopy plus a thin painted roof panel.
  const cabinProfile = roofStyle === 1
    ? [[-1.35, 0.98], [-0.85, 1.44], [0.5, 1.46], [1.05, 1.0]]   // coupe: fastback
    : [[-1.5, 0.98], [-1.05, 1.42], [0.7, 1.44], [1.2, 1.0]];    // sedan: notchback
  const canopy = new THREE.Mesh(profileBody(cabinProfile, W * 0.78, 0.04), glassMat);
  g.add(canopy);
  const roofTop = roofStyle === 1 ? 1.46 : 1.44;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.66, 0.06, 1.35), bodyMat);
  roof.position.set(0, roofTop, roofStyle === 1 ? -0.15 : -0.18);
  roof.castShadow = true;
  g.add(roof);

  addDetails(g, W, L);

  // Wheel centres sit just outside the body flank (half-width 0.97) so the tire
  // ring is visible from the side instead of being buried in the shell.
  const wx = W / 2 + 0.02;
  for (const [x, z] of [[-wx, 1.46], [wx, 1.46], [-wx, -1.46], [wx, -1.46]]) {
    const w = makeWheel(0.36, 0.28);
    w.position.set(x, 0.36, z);
    g.add(w);
    wheels.push(w);
  }
  return { group: g, wheels };
}

function buildVan(paint) {
  const bodyMat = new THREE.MeshStandardMaterial({
    color: paint.c, metalness: paint.m * 0.7, roughness: paint.r + 0.15, envMapIntensity: 1.1,
  });
  const g = new THREE.Group();
  const wheels = [];
  const L = 5.2, W = 2.06;

  // One-piece van body: tall box with a sloped nose blended in.
  const box = new THREE.Mesh(profileBody([
    [-L / 2, 1.9], [-L / 2 + 0.15, 2.0], [L / 2 - 1.3, 2.0], [L / 2 - 0.9, 1.3],
    [L / 2 + 0.15, 0.95], [L / 2 + 0.3, 0.42], [L / 2 + 0.15, 0.3], [-L / 2 + 0.1, 0.3],
  ], W), bodyMat);
  box.castShadow = true;
  g.add(box);

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.62, 0.08), glassMat);
  windshield.position.set(0, 1.52, L / 2 - 0.72);
  windshield.rotation.x = -0.22;
  g.add(windshield);
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.44, L * 0.24), glassMat);
    side.position.set(s * W * 0.47, 1.5, L * 0.06);
    g.add(side);
  }
  addDetails(g, W, L, { lightY: 0.78, tallLights: true });

  const vwx = W / 2 + 0.02;
  for (const [x, z] of [[-vwx, 1.72], [vwx, 1.72], [-vwx, -1.62], [vwx, -1.62]]) {
    const w = makeWheel(0.4, 0.3);
    w.position.set(x, 0.4, z);
    g.add(w);
    wheels.push(w);
  }
  return { group: g, wheels };
}

function buildTruck(paint) {
  const cabMat = new THREE.MeshStandardMaterial({
    color: paint.c, metalness: paint.m * 0.6, roughness: paint.r + 0.2, envMapIntensity: 1.0,
  });
  const cargoMat = new THREE.MeshStandardMaterial({ color: 0xcfd3da, metalness: 0.5, roughness: 0.55 });
  const g = new THREE.Group();
  const wheels = [];

  // Beveled cab profile with a real windshield rake.
  const cab = new THREE.Mesh(profileBody([
    [1.15, 1.85], [2.15, 1.5], [2.75, 0.9], [2.8, 0.42], [2.65, 0.3], [1.1, 0.3],
  ], 2.16), cabMat);
  cab.castShadow = true;
  g.add(cab);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.6, 0.08), glassMat);
  windshield.position.set(0, 1.5, 2.3);
  windshield.rotation.x = -0.3;
  g.add(windshield);

  // Beveled cargo box.
  const cargoGeo = new THREE.ExtrudeGeometry((() => {
    const s = new THREE.Shape();
    s.moveTo(-2.7, 0.5); s.lineTo(-2.7, 2.5); s.lineTo(0.6, 2.5); s.lineTo(0.6, 0.5);
    s.closePath();
    return s;
  })(), { depth: 2.3, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 2 });
  cargoGeo.rotateY(-Math.PI / 2);
  cargoGeo.translate(-1.15, 0, 0);
  const cargo = new THREE.Mesh(cargoGeo, cargoMat);
  cargo.castShadow = true;
  g.add(cargo);

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 5.2), trimMat);
  chassis.position.y = 0.48;
  g.add(chassis);
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.07), headlightMat);
    hl.position.set(s * 0.8, 0.62, 2.82);
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.07), taillightMat);
    tl.position.set(s * 0.85, 0.95, -2.76);
    g.add(tl);
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.22, 0.16), trimMat);
    bumper.position.set(0, 0.44, 2.86);
    g.add(bumper);
  }
  const twx = 1.1;
  for (const [x, z] of [[-twx, 2.0], [twx, 2.0], [-twx, -1.2], [twx, -1.2], [-twx, -2.0], [twx, -2.0]]) {
    const w = makeWheel(0.44, 0.34);
    w.position.set(x, 0.44, z);
    g.add(w);
    wheels.push(w);
  }
  return { group: g, wheels };
}

// ---------------------------------------------------------------------------
export function carMesh(color, styleHint) {
  // Numeric colors index PAINTS directly; anything else rolls deterministically
  // off the paint table length so replayed frames never drift.
  const idx = typeof color === 'number' && Number.isFinite(color)
    ? Math.abs(Math.floor(color)) % PAINTS.length
    : Math.floor(PAINTS.length * 0.618) % PAINTS.length;
  const pick = PAINTS[idx];
  const roll = typeof styleHint === 'string' ? styleHint
    : (idx * 7 + 3) % 10 < 6 ? 'sedan' : (idx * 7 + 3) % 10 < 8 ? 'van' : 'truck';
  const built = roll === 'van' ? buildVan(pick) : roll === 'truck' ? buildTruck(pick)
    : buildSedan(pick, idx % 2); // alternate sedan / coupe roofs
  const g = built.group;
  g.userData.wheels = built.wheels;
  g.userData.style = roll;
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
