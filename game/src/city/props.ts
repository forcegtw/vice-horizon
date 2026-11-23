// Street-dressing stages for the city build: the small props that make blocks
// feel inhabited (hydrants, bins, parked bikes), rooftop hardware, traffic
// signals, and the road paint (dashed centre lines plus crosswalk stripes).
//
// Every stage receives the shared site bag and consumes the seeded rng in
// place — the guards that skip draws are load-bearing, so call sites keep
// their position in the stream. Geometry merges through the shared box batch
// from blocks.ts, so the whole dressing layer still draws in a handful of calls.

import * as THREE from '../../vendor/three.min.js';
import { WORLD } from '../config.js';
import { CELLS, LANES, LOT_BUILDABLE, CURB_OFFSET, lotCenter, streetLine, createBoxBatch } from './blocks.ts';

// Curb prop tints as shared instances — batch.add only reads r/g/b.
const HYDRANT_BODY = new THREE.Color(0xc23b2e);
const HYDRANT_CAP = new THREE.Color(0xa33328);
const BIN_BODY = new THREE.Color(0x2e4436);
const BIN_LID = new THREE.Color(0x1e2e24);

// Curb furniture: hydrants, trash bins, parked bikes. Each roll spends its own
// draws (guard, position along the block, side of the street).
export function dressCurbs(site) {
  const { rng, group } = site;
  const curbBatch = createBoxBatch();
  const bikeWheelGeo = new THREE.TorusGeometry(0.34, 0.06, 8, 14);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3e6fa8, roughness: 0.5, metalness: 0.6 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.9 });
  for (let i = 0; i < CELLS; i++) {
    for (let j = 0; j < CELLS; j++) {
      const cx = lotCenter(i);
      const cz = lotCenter(j);
      if (rng() < 0.45) {
        const px = cx + (rng() - 0.5) * LOT_BUILDABLE;
        const pz = cz + (rng() < 0.5 ? -1 : 1) * (CURB_OFFSET - 0.6);
        curbBatch.add(px, 0.35, pz, 0.26, 0.5, 0.26, HYDRANT_BODY, 2);
        curbBatch.add(px, 0.66, pz, 0.36, 0.14, 0.36, HYDRANT_CAP, 2);
      }
      if (rng() < 0.5) {
        const px = cx + (rng() - 0.5) * LOT_BUILDABLE;
        const pz = cz + (rng() < 0.5 ? -1 : 1) * (CURB_OFFSET - 0.8);
        curbBatch.add(px, 0.55, pz, 0.7, 1.0, 0.7, BIN_BODY, 2);
        curbBatch.add(px, 1.1, pz, 0.8, 0.1, 0.8, BIN_LID, 2);
      }
      if (rng() < 0.3) {
        const bike = new THREE.Group();
        for (const side of [-1, 1]) {
          const wheel = new THREE.Mesh(bikeWheelGeo, tireMat);
          wheel.position.set(0, 0.34, side * 0.5);
          bike.add(wheel);
        }
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 1.0), frameMat);
        frame.position.y = 0.55;
        bike.add(frame);
        const px = cx + (rng() - 0.5) * LOT_BUILDABLE;
        bike.position.set(px, 0.18, cz);
        bike.rotation.y = rng() * Math.PI;
        bike.castShadow = true;
        group.add(bike);
      }
    }
  }
  group.add(new THREE.Mesh(
    curbBatch.build(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 }),
  ));
}

// Rooftop clutter: AC units, water tanks, antennas on tall roofs. The guard
// reads height first, so short solids never spend a draw.
export function clutterRoofs(site) {
  const { rng, group, solids } = site;
  const roofBatch = createBoxBatch();
  const hardwareTint = new THREE.Color(0x3a3f4a);
  const antennaMat = new THREE.MeshStandardMaterial({ color: 0x565b66, roughness: 0.6, metalness: 0.7 });
  const antennaGeo = new THREE.CylinderGeometry(0.05, 0.08, 6, 5);
  for (const s of solids) {
    if (s.h < 16 || rng() > 0.7) continue;
    const mx = (s.minX + s.maxX) / 2;
    const mz = (s.minZ + s.maxZ) / 2;
    const w = s.maxX - s.minX;
    const d = s.maxZ - s.minZ;
    if (rng() < 0.7) {
      const ax = mx + (rng() - 0.5) * w * 0.4;
      const az = mz + (rng() - 0.5) * d * 0.4;
      roofBatch.add(ax, s.h + 0.8, az, 2.2, 1.0, 1.6, hardwareTint, 3);
    }
    if (rng() < 0.4) {
      const tx = mx + (rng() - 0.5) * w * 0.3;
      const tz = mz + (rng() - 0.5) * d * 0.3;
      roofBatch.add(tx, s.h + 1.1, tz, 1.4, 1.6, 1.4, hardwareTint, 3);
    }
    if (s.h > 30 && rng() < 0.5) {
      const mast = new THREE.Mesh(antennaGeo, antennaMat);
      mast.position.set(mx, s.h + 3, mz);
      group.add(mast);
    }
  }
  const roofMesh = new THREE.Mesh(
    roofBatch.build(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
  );
  roofMesh.castShadow = true;
  group.add(roofMesh);
}

// Traffic lights at a third of intersections: pole, head box, green lamp.
export function plantSignals(site) {
  const { rng, group, solids } = site;
  const metal = new THREE.MeshStandardMaterial({ color: 0x262a32, roughness: 0.7, metalness: 0.6 });
  const goLamp = new THREE.MeshStandardMaterial({ color: 0x30ff50, emissive: 0x20ff40, emissiveIntensity: 2 });
  const headGeo = new THREE.BoxGeometry(0.5, 1.3, 0.4);
  for (let i = 0; i < LANES; i += 3) {
    for (let j = 0; j < LANES; j += 3) {
      if (rng() > 0.6) continue;
      const px = streetLine(i) + 9;
      const pz = streetLine(j) + 9;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 5.4, 8), metal);
      pole.position.set(px, 2.7, pz);
      group.add(pole);
      const head = new THREE.Mesh(headGeo, metal);
      head.position.set(px, 5.6, pz);
      group.add(head);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), goLamp);
      lamp.position.set(px, 5.3, pz + 0.22);
      group.add(lamp);
      solids.push({ minX: px - 0.3, maxX: px + 0.3, minZ: pz - 0.3, maxZ: pz + 0.3, h: 6 });
    }
  }
}

// Road paint: dashed centre lines on every street, then crosswalk stripes on
// every approach of every intersection.
export function stripeStreets(site) {
  const dashes = createBoxBatch();
  const laneTint = new THREE.Color(0xd8b451);
  for (let i = 0; i < LANES; i++) {
    const c = streetLine(i);
    for (let j = 0; j < CELLS; j++) {
      const z0 = streetLine(j) + WORLD.lotSize / 2;
      dashes.add(c - 0.18, 0.02, z0, 0.36, 0.02, 4.5, laneTint, 4);
      dashes.add(z0, 0.02, c + 0.18, 4.5, 0.02, 0.36, laneTint, 4);
    }
  }
  site.group.add(new THREE.Mesh(dashes.build(), new THREE.MeshBasicMaterial({ vertexColors: true })));

  const stripes = createBoxBatch();
  const walkTint = new THREE.Color(0xd9dde2);
  for (let i = 0; i < LANES; i++) {
    const c = streetLine(i);
    for (let j = 0; j < CELLS; j++) {
      const z0 = streetLine(j) + WORLD.lotSize / 2;
      for (let k = -3; k <= 3; k++) {
        stripes.add(c + k * 1.7, 0.021, z0 + 7.4, 0.9, 0.015, 2.6, walkTint, 4);
        stripes.add(c + k * 1.7, 0.021, z0 - 7.4, 0.9, 0.015, 2.6, walkTint, 4);
        stripes.add(z0 + 7.4, 0.021, c + k * 1.7, 2.6, 0.015, 0.9, walkTint, 4);
        stripes.add(z0 - 7.4, 0.021, c + k * 1.7, 2.6, 0.015, 0.9, walkTint, 4);
      }
    }
  }
  site.group.add(new THREE.Mesh(stripes.build(), new THREE.MeshBasicMaterial({ vertexColors: true })));
}
