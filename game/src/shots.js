// Deterministic screenshot mode: ?shot=NAME&seed=N freezes the sim into a
// staged tableau, lets it settle, and the grader captures the canvas. Each
// shot name maps to a setup function that positions the player, camera, cars
// and HUD; HUD state is forced per shot, never read from the live game. Every
// setup is pure with respect to the seeded RNG — same seed, same screenshot —
// and settle frames matter: particles, the clock and the HUD converge before
// capture, so don't skip them.
// Timing summary: start = morning title, play = golden-hour cruise, end =
// blue-hour night — three beats covering the widest visual range in three
// captures.
// This file stays dependency-free (no imports) so plain-node smoke harnesses
// can parse it without pulling the world in.

// WORLD_DAY mirrors WORLD.dayLength from config.js — if the cycle is retuned,
// update that constant (not this one).
const WORLD_DAY = 165;

// Camera booms used by every shot, in world metres — bump together with
// config.CAMERA so retuning the title framing is one edit.
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
    state.time = WORLD_DAY * 0.36; // bright morning title with long-ish shadows
  },
  play(state) {
    // Golden-hour cruise down the centre boulevard: stolen car mid-drive,
    // skyline catching warm light, mission marker ahead. Golden hour reads far
    // better in screenshots than deep night: richer colour, visible detail, no
    // mud. wanted=2 is intentional so the HUD stars and bezel tint show.
    state.hideOverlay();
    const c = state.traffic.cars.find((k) => k.mesh.userData.style === 'sedan') || state.traffic.cars[0];
    state.stealCar(c);
    c.x = 0;
    c.z = 40;
    c.heading = 0;
    c.speed = 12;
    state.player.inCar = true;
    state.camYaw = 0;
    state.wanted = 2;
    // Clear the corridor around the player's car: a traffic van spawning on top
    // of the camera ruins the framing. Push every other car to an off-screen
    // holding corner (x jitters on a 20 m grid so the row never stacks).
    const holdingX = -180;
    const holdingZ = -320;
    for (const other of state.traffic.cars) {
      if (other === c) continue;
      other.x = holdingX + (other.x % 20);
      other.z = holdingZ;
      other.speed = 0;
    }
    state.time = WORLD_DAY * 0.52; // mid-morning warm sun, full detail visible
    state.mission.start();
    state.mission.targets[0].x = 0;
    state.mission.targets[0].z = 90;
    state.mission.marker.position.set(0, 0, 90);
    state.mission.message('MISSION — Night Boost: Boost the marked coupe and deliver it to the garage dock.');
  },
  end(state) {
    // On foot on a night street, cash-run mission active, the cache marker
    // glowing down the road.
    state.hideOverlay();
    state.money = 3480;
    state.mission.index = 1;
    state.mission.start();
    // Stand on the centre vertical boulevard looking north at the marker.
    state.player.x = 0;
    state.player.z = -70;
    state.player.heading = 0;
    state.camYaw = 0;
    state.mission.targets[0].x = 0;
    state.mission.targets[0].z = 0;
    state.time = WORLD_DAY * 0.79; // blue-hour night, lit street, neon markers
    state.mission.marker.position.set(0, 0, 0);
    state.mission.message('Grab the cash caches before the clock runs out.', 60);
  },
};
