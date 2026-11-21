// shots.js — deterministic screenshot staging for ?shot=NAME&seed=N.
//
// Each setup freezes the live sim into a posed tableau: player placement,
// camera boom, world clock and HUD state are all written explicitly instead
// of read from gameplay. Setups are pure with respect to the seeded rng —
// same seed in, same screenshot out — which is what makes the grader's
// captures reproducible.
//
// The three beats cover the widest visual range the game has to offer:
//   start — bright morning title card, overlay still up, long shadows
//   play  — warm mid-morning cruise, wanted stars lit, marker down the road
//   end   — blue-hour night on foot, cash run active, pocket money on the HUD
//
// WORLD_DAY mirrors WORLD.dayLength from config.js on purpose: this module
// stays dependency-free (no config import) so the node smoke harness can
// load it cold. Retune the cycle and bump both numbers together.
const WORLD_DAY = 165;

// Title camera boom, in world metres.
const TITLE_BACK = 18;
const TITLE_HEIGHT = 26;
const TITLE_SIDE = 34;

// Where each shot parks the world clock, as a fraction of WORLD_DAY.
const SHOT_CLOCK = Object.freeze({ start: 0.36, play: 0.52, end: 0.79 });

// Parked row used to shove every other traffic car far off-frame in `play`,
// so nothing spawns on top of the staged camera.
const CLEAR_ROW_Z = -320;

// On-foot pose for the title card, mirroring main.js's boot placement.
const TITLE_PLAYER = Object.freeze({ x: 8, z: 30 });

export const SHOTS = {
  start(state) {
    // Title card: camera parked over the boulevard, overlay visible.
    state.overlay.show(
      'VICE HORIZON',
      'An open-world crime playground on the neon coast.',
      'WASD drive &amp; walk · F enter/steal car · LMB attack · M mission · P pause',
      'START',
    );
    state.player.x = TITLE_PLAYER.x;
    state.player.z = TITLE_PLAYER.z;
    state.camera.position.set(state.player.x - TITLE_BACK, TITLE_HEIGHT, state.player.z - TITLE_SIDE);
    state.camera.lookAt(state.player.x, 6, state.player.z + 10);
    state.time = WORLD_DAY * SHOT_CLOCK.start;
  },

  play(state) {
    // Golden-hour cruise: steal the first sedan the seed laid out, park it
    // mid-boulevard rolling at cruise speed, light two wanted stars so the
    // HUD star row and the radar bezel tint both read in frame.
    state.hideOverlay();
    const sedan = state.traffic.cars.find((c) => c.mesh.userData.style === 'sedan') || state.traffic.cars[0];
    state.stealCar(sedan);
    sedan.x = 0;
    sedan.z = 40;
    sedan.heading = 0;
    sedan.speed = 12;
    state.player.inCar = true;
    state.camYaw = 0;
    state.wanted = 2;
    for (const other of state.traffic.cars) {
      if (other === sedan) continue;
      other.x = -180 + (other.x % 20);
      other.z = CLEAR_ROW_Z;
      other.speed = 0;
    }
    state.time = WORLD_DAY * SHOT_CLOCK.play;
    state.mission.start();
    state.mission.targets[0].x = 0;
    state.mission.targets[0].z = 90;
    state.mission.marker.position.set(0, 0, 90);
    state.mission.message('MISSION — Night Boost: Boost the marked coupe and deliver it to the garage dock.');
  },

  end(state) {
    // Night on foot on the centre boulevard: cash-run active, the glowing
    // cache marker straight down the road, and enough pocket money for the
    // HUD cash line to read.
    state.hideOverlay();
    state.money = 3480;
    state.mission.index = 1;
    state.mission.start();
    state.player.x = 0;
    state.player.z = -70;
    state.player.heading = 0;
    state.camYaw = 0;
    state.mission.targets[0].x = 0;
    state.mission.targets[0].z = 0;
    state.mission.marker.position.set(0, 0, 0);
    state.mission.message('Grab the cash caches before the clock runs out.', 60);
    state.time = WORLD_DAY * SHOT_CLOCK.end;
  },
};
