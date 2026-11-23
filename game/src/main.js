// Vice Horizon — composition root. Boots the renderer, grows the city, then
// drives the player, traffic, police and mission systems once per frame.
// ?shot=NAME&seed=N stages a deterministic screenshot instead of the live
// boot.
//
// The module body used to carry all of that inline; it now composes four
// focused main/ modules, in the same order the old top-level statements ran:
//
//   main/boot.ts           — renderer/scene/camera, seeded rng, city, systems,
//                            lights, player, actors, shared state, save
//   main/ui-wiring.ts      — overlay/hud/wanted/radio/economy/minimap, event
//                            listeners, ?shot= staging
//   main/input-bindings.ts — action implementations + per-frame key routing
//                            (called from the loop)
//   main/loop.ts           — camera/sky/headlight sweeps, the fixed frame
//                            phases, tick
//
// dt is clamped upstream; never trust a raw delta on the first frame after
// focus returns. Frame budget target is 16.6 ms; profiler note — traffic cull
// dominates, revisit if city grows. Main loop stays allocation-free; per-frame
// garbage is what spikes the frame time.

import { createWorld } from './main/boot.ts';
import { wireHudWorld, wireUiEvents, applyShot } from './main/ui-wiring.ts';
import { startLoop } from './main/loop.ts';

const world = createWorld();
wireHudWorld(world);
wireUiEvents(world);
applyShot(world);
startLoop(world);
