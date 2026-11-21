// Deterministic screenshot staging: ?shot=NAME&seed=N freezes the simulation
// into a prepared tableau, gives it settle frames, and the grader captures the
// canvas. Every shot name maps to a setup function that places the player,
// camera, cars and HUD state; HUD values are forced per shot rather than read
// from live play.
//
// Determinism rules each setup must obey:
// - Same seed in, same screenshot out. Setups only draw from the seeded RNG
//   through the systems they call (e.g. mission.start()), never from Math.random.
// - settle frames run after staging so particles, HUD caches and shadows
//   converge before capture — do not skip them.
// Timing summary: start = morning title card, play = golden-hour cruise,
// end = blue-hour night street. Three beats spanning the widest visual range.
// WORLD_DAY mirrors config.dayLength; retune both together (shots.js stays
// dependency-free for the smoke harness, so it carries its own copy).

export const SHOTS = {
  start(state) {
    // Title card: the camera hovers over the boulevard while the overlay is up.
    state.overlay.show(
      'VICE HORIZON',
      'An open-world crime playground on the neon coast.',
      'WASD drive &amp; walk · F enter/steal car · LMB attack · M mission · P pause',
      'START',
    );
    state.player.x = TITLE_SPAWN.x;
    state.player.z = TITLE_SPAWN.z;
    // Title framing comes from SHOT_BOOM below so retuning it is a one-line edit.
    state.camera.position.set(state.player.x - SHOT_BOOM.titleBack, SHOT_BOOM.titleUp, state.player.z - 34);
    state.camera.lookAt(state.player.x, 6, state.player.z + 10);
    state.time = WORLD_DAY * 0.36; // bright morning, long-ish shadows
  },
  play(state) {
    // Golden-hour cruise down the centre boulevard: the stolen sedan mid-drive,
    // skyline in warm light, the mission marker glowing ahead. Wanted stays at 2
    // on purpose so the HUD stars and the tinted radar bezel both read.
    state.hideOverlay();
    const ride = state.traffic.cars.find((k) => k.mesh.userData.style === 'sedan') || state.traffic.cars[0];
    state.stealCar(ride);
    ride.x = 0; ride.z = 40; ride.heading = 0;
    ride.speed = 12;
    state.player.inCar = true;
    state.camYaw = 0;
    state.wanted = 2;
    // Sweep every other car out of frame: a van spawning under the camera would
    // wreck the composition.
    for (const other of state.traffic.cars) {
      if (other === ride) continue;
      other.x = -180 + (other.x % 20); other.z = -320; other.speed = 0;
    }
    state.time = WORLD_DAY * 0.52; // warm mid-morning sun, full detail
    state.mission.start();
    state.mission.targets[0].x = 0;
    state.mission.targets[0].z = 90;
    state.mission.marker.position.set(0, 0, 90);
    state.mission.message('MISSION — Night Boost: Boost the marked coupe and deliver it to the garage dock.');
  },
  end(state) {
    // Night street on foot: cash-run mission live, the glowing cache marker
    // straight up the centre boulevard.
    state.hideOverlay();
    state.money = 3480;
    state.mission.index = 1;
    state.mission.start();
    // Stand on the centre vertical boulevard facing north.
    state.player.x = 0; state.player.z = -70;
    state.player.heading = 0;
    state.camYaw = 0;
    state.mission.targets[0].x = 0;
    state.mission.targets[0].z = 0;
    state.time = WORLD_DAY * 0.79; // blue-hour night, lit street, neon markers
    state.mission.marker.position.set(0, 0, 0);
    state.mission.message('Grab the cash caches before the clock runs out.', 60);
  },
};

// One full day-night sweep in seconds — keep equal to WORLD.dayLength in
// config.js; this local copy exists because shots.js must import nothing.
const WORLD_DAY = 165;

// Camera booms the staged shots share, in world metres. Bump together with
// CAMERA in config.js if the chase rig is retuned.
const SHOT_BOOM = { titleBack: 18, titleUp: 26 };
const TITLE_SPAWN = { x: 8, z: 30 }; // where the title-card hero stands
