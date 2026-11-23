// Vice Horizon city facade. The town generator used to live in this one file;
// it is now a small package under city/ — blocks.ts (grid, textures, box
// factory, towers/parks), props.ts (curbs, roofs, signals, road paint) and
// lighting.ts (lamps, neon signs, glow pools), assembled by city/index.ts in
// the load-bearing stage order.
//
// This file stays the import path for the rest of the game (traffic, peds,
// missions and the HUD all pull HALF from here) and re-exports exactly the
// public surface: HALF, buildCity, buildRoadLines, nearestLane. Nothing else
// leaks out of the package.

export * from './city/index.ts';
