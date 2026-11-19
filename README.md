# Vice Horizon

An open-world crime game that runs in the browser: steal cars, outrun the police, and run
cash-cache missions across a neon city — built with three.js (vendored, r160) and plain ES
modules, no build step.

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

## Systems

| System | What it does |
| --- | --- |
| Wanted | Heat banks from crimes (carjacks, gunfire, ped hits); stars spawn cops per level, cops shoot above 30 m, heat decays once nobody has line of sight; escape or respawn to clear. The HUD shows stars plus a tinted heat bar. |
| Weather | Clear / overcast / rain / storm cycle — wet asphalt darkens and gains sheen, fog thickens, rain particles and two-bolt lightning strikes ride the day/night clock. The HUD clock shows the current weather label. |
| Radio | Four-station procedural synthwave loop synthesized in WebAudio (bass + arp + hats + kick, one mood per station), station cycling with a jingle sting, mute toggle, in-car only. |
| Economy | Gas-station shops sell health, armor, engine tune (+18% top speed) and plating (+50 armor capacity); purchases persist in a versioned localStorage ledger merged with the main save. |
| Minimap | Corner radar (roads, player arrow, mission blip, police dots, traffic flecks) plus a full-map overlay on M with side-job blips; the radar bezel tints red while wanted. |
| Side jobs | Races (checkpoint chains), timed deliveries with a speed bonus and rampage contracts, started with G, paid on completion; rampage kills feed the wanted system. |
| Missions | Story chain: car delivery, timed cash-cache run, rival elimination — with markers, HUD briefs and payouts credited on completion. |
| Day/night | 165 s cycle: shader sky dome with stars, orbiting sun + moonlight, neon signage flicker, headlight rig that fades in at dusk. |

## What's in it

- Three vehicle bodies (sedan/coupe, van, truck) with extruded profiles, glass canopies, torus
  tires on spoked rims, emissive lights, exhausts and antennas
- Pedestrians with jointed walk-animation tiers (stroll / hurry / sprint / idle), fear-flee from
  wanted players, and district crowd density
- A day/night cycle with a shader sky, warm sun, moonlight, neon signage and lit facades; a
  PMREM environment map whose reflections dim at night
- Traffic that brakes for cars and the player, police that escalates with your wanted level,
  pedestrians that flee gunfire, WebAudio sound effects (enveloped tones, wailing siren) and a
  pooled particle system for sparks and explosions
- Versioned localStorage saves with v1→v2 migration, remappable input bindings, and a
  deterministic `?shot=NAME&seed=N` screenshot mode

## Notes

- Runs fully offline: three.js r160 is vendored under `game/vendor/`, audio and textures are
  synthesized at runtime, so the first load needs no network.
- Saves live in `localStorage` (versioned schema, corrupt entries start fresh); delete site data
  to reset progress.

## Entry

Built by an AI agent for make.fun's "Make GTA 6" bounty — [see the leaderboard](https://make.fun/bounty/gta6-01/leaderboard).
