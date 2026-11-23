// City assembly. This module owns the build-stage order for the Vice Horizon
// town: ground, sidewalks, materials, block carve, batch close, then the
// dressing and lighting passes. The order is load-bearing twice over — it
// fixes the scene group's child order AND the seeded rng stream — so stages
// may not be rearranged.
//
// The public surface of the city lives here and is re-exported by ../city.js:
// HALF (immutable world half-extent), buildCity, buildRoadLines, nearestLane.

import * as THREE from '../../vendor/three.min.js';
import { WORLD } from '../config.js';
import {
  HALF, LANES, lotCenter, streetLine,
  paveGround, laySidewalks, dressMaterials, openBatches, carveBlocks, closeBatches,
} from './blocks.ts';
import { dressCurbs, clutterRoofs, plantSignals, stripeStreets } from './props.ts';
import { standLamps, hangSigns, spreadGlow } from './lighting.ts';

export { HALF };

// One build pass over the whole town. Everything is laid out from the seeded
// rng handed in, so ?seed=N rebuilds an identical city.
export function buildCity(scene, rng) {
  const group = new THREE.Group();
  scene.add(group);
  const site = {
    rng, group,
    solids: [],       // AABB colliders {minX, maxX, minZ, maxZ, h}
    lamps: [],
    parkSpots: [],
    signMeshes: [],
    neonLights: [],
    trim: null,
  };

  paveGround(site);
  const walkBatch = laySidewalks(site);
  const skins = dressMaterials();
  const batches = openBatches();
  site.trim = batches.trim;
  carveBlocks(site, walkBatch, batches);
  closeBatches(site, batches, skins);
  standLamps(site);
  dressCurbs(site);
  clutterRoofs(site);
  plantSignals(site);
  hangSigns(site);
  spreadGlow(site);
  stripeStreets(site);

  return {
    group,
    road: site.road,
    solids: site.solids,
    lamps: site.lamps,
    bulbMesh: site.bulbMesh,
    buildingMats: skins.buildingMats,
    shopMats: skins.shopMats,
    neonLights: site.neonLights,
    signMeshes: site.signMeshes,
    parkSpots: site.parkSpots,
    half: HALF,
    roadLines: buildRoadLines(),
  };
}

// Street centre lines used by traffic AI: every intersection on the grid.
export function buildRoadLines() {
  const lines = [];
  for (let i = 0; i < LANES; i++) {
    const c = streetLine(i);
    lines.push({ axis: 'z', line: c });
    lines.push({ axis: 'x', line: c });
  }
  return lines;
}

// Snap a world position onto the nearest lane — used for spawning traffic and
// cops. Ties lean toward the 'x' axis so spawns stay stable when a point sits
// exactly between two streets.
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
