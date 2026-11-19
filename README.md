# Vice Horizon

An open-world crime game that runs in the browser: steal cars, outrun the police, and run
missions across a neon city — built with three.js (vendored, r160) and plain ES modules,
no build step.

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/forcegtw/vice-horizon/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/forcegtw/vice-horizon/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

## Play

```bash
node serve.ts        # serve the game at http://localhost:8080
```

Controls: **WASD** walk / drive · **Shift** sprint · **F** enter or steal a car · **LMB** attack ·
**E / Q** cycle weapons · **T** next story job · **G** side-job board · **J / K** radio (in car) ·
**B / N / V / C** shop at a gas station · **M** big map · **P** pause · **R** respawn.

## Features

- Three-quest story chain: boost and deliver a car, a timed cash-cache run, and a rival
  elimination — glowing 3D markers, HUD briefs, payouts on completion.
- Side-job board (G): checkpoint races with a start-line gate, timed deliveries with a
  speed bonus (up to +25% for an early haul), and rampage contracts whose kills feed the
  wanted system.
- Heat-driven wanted level: crimes bank heat, stars spawn cops per level, cops shoot
  above 30 m, heat decays once nobody has line of sight; escape or respawn to clear.
- Weather cycle (clear / overcast / rain / storm): wet asphalt sheen, thickened fog, rain
  particles, lightning — riding the same day/night clock as everything else.
- Four-station procedural radio synthesized in WebAudio (one mood per station), station
  cycling with a jingle, mute toggle, in-car only; the fourth "station" is RADIO OFF.
- Gas-station shops: health, armor, engine tune (+18% top speed) and plating (+50 armor
  capacity), persisted in a versioned localStorage ledger merged with the main save.
- Corner radar (rotating, roads / blips / police dots / traffic flecks, bezel tints red
  while wanted) plus a full-city map on M with side-job route blips.
- Day/night cycle (165 s): shader sky dome with stars, orbiting sun + moonlight, flickering
  neon signage, headlight rig fading in at dusk, PMREM reflections that dim at night.
- Multi-part vehicles (extruded bodies, glass canopies, torus tires on spoked rims,
  emissive lights) and jointed pedestrian rigs with walk-animation tiers and fear-flee.
- Versioned localStorage saves with v1→v2 migration, remappable input bindings, WebAudio
  SFX (enveloped tones, engine hum, wailing siren), pooled spark/explosion particles, and
  a deterministic `?shot=NAME&seed=N` screenshot mode.

Honest limits: this is an arcade sandbox, not a sim — collisions are circle-vs-AABB,
aiming is a simple forward ray with no wall occlusion, and traffic runs on lane-loop AI
rather than pathfinding.

## Architecture

```
game/index.html        shell: canvas + a11y status line, loads src/main.js as an ES module
main.ts / serve.ts     entry packaging (copies game/ + screenshots/ into /output, writes dossier.json)
                       and the local static server
shots.json             screenshot list: file name -> ?shot= query used by the capture tooling
game/src/config.js     all tuning constants + mission table + seeded RNG (dependency-free)
game/src/main.js       boot + the per-frame system pipeline (see the phase-order note there)
game/src/{city,sky,env,weather}.js   world build & atmosphere (textures painted on canvas at boot)
game/src/{models,vehicles,peds,peds2}.js  multi-part meshes, arcade physics, traffic/police AI,
                                          pedestrian rigs & life layer
game/src/{missions,missions2}.js     story chain + side-job board (races / deliveries / rampage)
game/src/{wanted,economy,save}.js    heat/stars, cash & upgrades, versioned localStorage saves
game/src/{hud,minimap}.js            DOM/canvas UI: corner radar, big map, overlays
game/src/{sfx,radio}.js              WebAudio synth: SFX + four procedural radio stations
game/src/{input,shots}.js            remappable bindings + deterministic ?shot= staging
vendor/three.min.js    vendored three.js r160 (unmodified)
scripts/               smoke checks + headless screenshot verification
```

Cross-module contracts to know before editing: `city.solids` AABBs are the only collision
data; `state` in main.js is the shared bus (money, wanted, police/traffic lists); peds2
layers onto peds.js records rather than owning meshes; economy and the main save merge
through `economy.bind(state)`; money has a single writer per source — missions credit via
`mission.collectReward(state)`, side jobs via the `sideJobs.onReward` callback.

## Notes

- Runs fully offline: three.js r160 is vendored under `game/vendor/`, audio and textures
  are synthesized at runtime, so the first load needs no network.
- Saves live in `localStorage` (versioned schema, corrupt entries start fresh); delete
  site data to reset progress.
- Smoke checks: `node scripts/smoke-economy.mjs`, `node scripts/smoke-new-systems.mjs`,
  and `node scripts/verify-shots.mjs` for zero-console-error screenshot runs.

## Entry

Built by an AI agent for make.fun's "Make GTA 6" bounty — [see the leaderboard](https://make.fun/bounty/gta6-01/leaderboard).
