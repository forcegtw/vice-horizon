// City lighting stages: lamp posts with instanced emissive bulbs, neon blade
// signs on tower corners, and the shared neon ambience pools. main.js drives
// all three with the day cycle (bulb color, neon intensity, sign flicker), so
// these stages only place geometry and hand back the handles the loop needs.
//
// Stages consume the seeded rng in place — hangSigns' spend check runs before
// the height test on purpose (short solids pay the draw even though they skip).

import * as THREE from '../../vendor/three.min.js';
import { CELLS, streetLine, createBoxBatch } from './blocks.ts';

const POLE_TINT = 0x262b34;        // lamp posts

// Neon palettes: signs draw from five hues (signMeshes carry the phase for the
// loop's flicker), ambience pools cycle four. Order is cosmetic but stable.
const NEON_HUES = [0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff];
const NEON_TINTS = [0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d];

// Dark merged posts plus an instanced emissive bulb per lamp; main.js dims and
// brightens the bulbs with the day cycle. Pooled night light comes from these
// bulbs plus the block neon.
export function standLamps(site) {
  const postBatch = createBoxBatch();
  const bulbs = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.33, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd79a, emissive: 0xffd79a, emissiveIntensity: 1.4 }),
    site.lamps.length,
  );
  const m4 = new THREE.Matrix4();
  const still = new THREE.Quaternion();
  for (const [k, spot] of site.lamps.entries()) {
    postBatch.add(spot.x, 3.1, spot.z, 0.28, 6.2, 0.28, new THREE.Color(POLE_TINT), 2);
    m4.compose(new THREE.Vector3(spot.x, 6.3, spot.z), still, new THREE.Vector3(1, 1, 1));
    bulbs.setMatrixAt(k, m4);
    site.solids.push({ minX: spot.x - 0.4, maxX: spot.x + 0.4, minZ: spot.z - 0.4, maxZ: spot.z + 0.4, h: 6 });
  }
  bulbs.instanceMatrix.needsUpdate = true;
  if (site.lamps.length) site.group.add(bulbs);
  site.group.add(new THREE.Mesh(
    postBatch.build(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }),
  ));
  site.bulbMesh = bulbs;
}

// Neon blade signs on a fraction of tower corners.
export function hangSigns(site) {
  const { rng, group, solids, signMeshes } = site;
  const bladeGeo = new THREE.BoxGeometry(1.4, 7.5, 0.5);
  for (const s of solids) {
    if (rng() > 0.22 || s.h < 14) continue;
    const hue = new THREE.Color(NEON_HUES[Math.floor(rng() * NEON_HUES.length)]);
    const blade = new THREE.Mesh(bladeGeo, new THREE.MeshBasicMaterial({ color: hue }));
    const side = rng() < 0.5 ? 1 : -1;
    blade.position.set(
      (s.minX + s.maxX) / 2 + side * (s.maxX - s.minX) / 2,
      s.h * 0.62,
      (s.minZ + s.maxZ) / 2,
    );
    blade.rotation.y = rng() * Math.PI;
    blade.scale.y = Math.min(2.2, s.h / 14);
    group.add(blade);
    signMeshes.push(blade);
  }
  // Staggered flicker phases so the signs never blink in unison.
  for (const [k, blade] of signMeshes.entries()) blade.userData.phase = k * 1.7;
}

// Shared neon ambience: one low-intensity PointLight per 2x2 block group,
// intensity driven by main.js at night, keeping street lighting cost bounded.
export function spreadGlow(site) {
  for (let i = 0; i < CELLS; i += 2) {
    for (let j = 0; j < CELLS; j += 2) {
      const pool = new THREE.PointLight(NEON_TINTS[(i + j) % 4], 0, 55, 2);
      pool.position.set(streetLine(i + 1), 9, streetLine(j + 1));
      site.group.add(pool);
      site.neonLights.push(pool);
    }
  }
}
