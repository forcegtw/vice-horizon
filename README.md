# Vice Horizon

An open-world crime playground that runs entirely in the browser: jack cars, outrun the
stars, and run cash-cache jobs through a neon city — plain ES modules on a vendored
three.js (r160), with no build step anywhere.

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/forcegtw/vice-horizon/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/forcegtw/vice-horizon/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

## Play it

```bash
node serve.ts        # serves the game at http://localhost:8080
```

Controls: **WASD** walk / drive · **Shift** sprint · **F** enter or steal a car · **LMB** attack ·
**E / Q** cycle weapons · **T** next story job · **G** side-job board · **J / K** radio (in car) ·
**B / N / V / C** shop at a gas station · **M** big map · **P** pause · **R** respawn.

## Systems

| System | What it does |
| --- | --- |
| Wanted | Crimes bank heat (carjacks, gunfire, ped hits); stars spawn cops per level, cops open fire past 30 m, and heat decays once no cop has line of sight; escape or respawn to clear. The HUD shows stars and a tinted heat bar. |
| Weather | Clear / overcast / rain / storm cycle — wet asphalt darkens and gains sheen, fog thickens, and rain particles with two-bolt lightning ride the day/night clock. The HUD clock carries the current label. |
| Radio | Four procedural synthwave stations synthesized live in WebAudio (bass + arp + hats + kick, one mood each), cycle with a jingle sting, mute with K; the fourth "station" is RADIO OFF, and it plays only in a car. |
| Economy | Gas-station shops sell health, armor, an engine tune (+18% top speed) and plating (+50 armor capacity); purchases persist in a versioned localStorage ledger merged with the main save. |
| Minimap | A corner radar (roads, player arrow, mission blip, police dots, traffic flecks) plus a full-map overlay on M with side-job blips; the radar bezel tints red while wanted. |
| Side jobs | Checkpoint races, timed deliveries with a speed bonus (up to +25% for an early haul) and rampage contracts — start with G, paid on completion, rampage kills feed the wanted system. |
| Missions | The story chain: a car boost, a timed cash-cache run, a rival elimination — markers, HUD briefs, payouts credited on completion. |
| Day/night | A 165 s cycle: shader sky dome with stars, orbiting sun + moonlight, flickering neon signage, and a headlight rig that fades in at dusk. |

## What's in it

- Three vehicle bodies (sedan/coupe, van, truck) with extruded profiles, glass canopies,
  torus tires on spoked rims, emissive lights, exhausts and antennas
- Pedestrians with jointed walk-animation tiers (stroll / hurry / sprint / idle), fear-flee
  from wanted players, and district crowd density
- A day/night cycle with a shader sky, warm sun, moonlight, neon signage and lit facades;
  a PMREM environment map whose reflections dim at night
- Traffic that brakes for cars and the player, police that escalates with your wanted
  level, pedestrians that scatter from gunfire, WebAudio sound effects (enveloped tones,
  wailing siren) and a pooled particle system for sparks and explosions
- Gas-station shop stops (health / armor / engine tune / plating) with a cash ledger that
  persists separately from the main save
- Versioned localStorage saves with a v1→v2 migration, remappable input bindings, and a
  deterministic `?shot=NAME&seed=N` screenshot mode

Note: this is an arcade sandbox, not a simulator — collisions are circle-vs-AABB, aiming
is a simple forward ray with no wall occlusion, and traffic runs on lane-loop AI rather
than pathfinding.

## Architecture

```
game/index.html        shell: canvas + a11y status line, loads src/main.js as an ES module
game/src/config.js     all tuning constants + mission table + seeded RNG (dependency-free)
game/src/main.js       boot + the per-frame system pipeline (see the phase-order note there)
game/src/{city,sky,env,weather}.js   world build & atmosphere (textures painted on canvas at boot)
game/src/{vehicles,peds,peds2,models}.js  arcade physics, traffic/police AI, pedestrian rigs & life layer
game/src/{missions,missions2}.js     story chain + side-job board (races / deliveries / rampage)
game/src/{wanted,economy,save}.js    heat/stars, cash & upgrades, versioned localStorage saves
game/src/{hud,minimap}.js            DOM/canvas UI: corner radar, big map, overlays
game/src/{sfx,radio}.js              WebAudio synth: SFX + four procedural radio stations
game/src/{input,shots}.js            remappable bindings + deterministic ?shot= staging
```

Cross-module contracts worth knowing before editing: `city.solids` AABBs are the only
collision data; the `state` object in main.js is the shared bus (money, wanted,
police/traffic lists); peds2 layers onto peds.js records instead of owning meshes; the
economy and the main save merge through `economy.bind(state)`. Smoke checks live in
`scripts/smoke-*.mjs`.

## Notes

- Runs fully offline: three.js r160 is vendored under `game/vendor/`, and audio and
  textures are synthesized at runtime, so the first load needs no network.
- Saves live in `localStorage` (versioned schema; corrupt entries start fresh) — delete
  site data to reset progress.

## Entry

Built by an AI agent for make.fun's "Make GTA 6" bounty — [see the leaderboard](https://make.fun/bounty/gta6-01/leaderboard).
