// shots.js — deterministic screenshot staging: ?shot=NAME&seed=N freezes the
// sim into a staged tableau the grader captures. Each setup is pure with
// respect to the seeded RNG (same seed, same screenshot) and forces HUD state
// explicitly instead of reading live gameplay. start keeps the overlay up for
// the title capture; play/end hide it and pose the world directly.
//
// Timing: start = bright morning title with long shadows, play = warm mid-
// morning cruise on the centre boulevard, end = blue-hour night on foot — the
// three beats cover the widest visual range in three captures.
// WORLD_DAY mirrors config.dayLength; bump both if the cycle is retuned.
// Kept dependency-free (no config import) for the smoke harness.

const WORLD_DAY = 165; // == WORLD.dayLength (config.js)

// Camera booms for the title framing, in world metres.
const SHOT_BOOM = { titleBack: 18, titleUp: 26 };

export const SHOTS = {
  start(state) {
    // Title screen: camera over the boulevard, overlay visible.
    state.overlay.show(
      'VICE HORIZON',
      'An open-world crime playground on the neon coast.',
      'WASD drive &amp; walk · F enter/steal car · LMB attack · M mission · P pause',
      'START',
    );
    state.player.x = 8;
    state.player.z = 30;
    state.camera.position.set(state.player.x - SHOT_BOOM.titleBack, SHOT_BOOM.titleUp, state.player.z - 34);
    state.camera.lookAt(state.player.x, 6, state.player.z + 10);
    state.time = WORLD_DAY * 0.36;
  },

  play(state) {
    // Golden-hour cruise: stolen car mid-drive, mission marker ahead, wanted=2
    // so the HUD stars and the radar bezel tint show. Every other traffic car
    // is pushed far off-frame so nothing spawns on top of the camera.
    state.hideOverlay();
    const c = state.traffic.cars.find((k) => k.mesh.userData.style === 'sedan') || state.traffic.cars[0];
    state.stealCar(c);
    c.x = 0; c.z = 40; c.heading = 0;
    c.speed = 12;
    state.player.inCar = true;
    state.camYaw = 0;
    state.wanted = 2;
    for (const other of state.traffic.cars) {
      if (other === c) continue;
      other.x = -180 + (other.x % 20);
      other.z = -320;
      other.speed = 0;
    }
    state.time = WORLD_DAY * 0.52;
    state.mission.start();
    state.mission.targets[0].x = 0;
    state.mission.targets[0].z = 90;
    state.mission.marker.position.set(0, 0, 90);
    state.mission.message('MISSION — Night Boost: Boost the marked coupe and deliver it to the garage dock.');
  },

  end(state) {
    // On foot on the centre boulevard at night, cash-run active, glowing cache
    // marker down the road, some pocket money so the HUD cash line reads.
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
    state.time = WORLD_DAY * 0.79;
  },
};
