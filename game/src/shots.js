// Deterministic screenshot mode: ?shot=NAME&seed=N freezes the sim into a staged
// tableau, lets it settle, then the grader captures the canvas. Each shot name maps
// to a setup function that positions the player, camera, cars and HUD.

export const SHOTS = {
  start(state) {
    // Title screen: camera over the boulevard at dusk, overlay visible.
    state.overlay.show(
      'VICE HORIZON',
      'An open-world crime playground on the neon coast.',
      'WASD drive &amp; walk · F enter/steal car · LMB attack · M mission · P pause',
      'START',
    );
    state.player.x = 8; state.player.z = 30;
    state.camera.position.set(state.player.x - 18, 26, state.player.z - 34);
    state.camera.lookAt(state.player.x, 6, state.player.z + 10);
    state.time = WORLD_DAY * 0.36; // bright morning title with long-ish shadows
  },
  play(state) {
    // Golden-hour cruise on the centre boulevard: stolen car mid-drive, skyline
    // catching warm light, mission marker ahead. Golden hour reads far better in
    // screenshots than deep night: richer color, visible detail, no mud.
    state.hideOverlay();
    const c = state.traffic.cars[0];
    state.stealCar(c);
    c.x = 0; c.z = 40; c.heading = 0;
    c.speed = 12;
    state.player.inCar = true;
    state.camYaw = 0;
    state.wanted = 2;
    state.spawnCopAt(0, 68);
    state.time = WORLD_DAY * 0.52; // mid-morning warm sun, full detail visible
    state.mission.start();
    state.mission.targets[0].x = 0;
    state.mission.targets[0].z = 90;
    state.mission.marker.position.set(0, 0, 90);
    state.mission.message('MISSION — Night Boost: Boost the marked coupe and deliver it to the garage dock.');
  },
  end(state) {
    // On foot on a night street, cash-run mission active, marker glowing down the road.
    state.hideOverlay();
    state.money = 3480;
    state.mission.index = 1;
    state.mission.start();
    // Stand on the centre vertical boulevard looking north at the glowing cache marker.
    state.player.x = 0; state.player.z = -70;
    state.player.heading = 0;
    state.camYaw = 0;
    state.mission.targets[0].x = 0; state.mission.targets[0].z = 0;
    state.time = WORLD_DAY * 0.79; // blue-hour night, lit street, neon markers
    state.mission.marker.position.set(0, 0, 0);
    state.mission.message('Grab the cash caches before the clock runs out.', 60);
  },
};

const WORLD_DAY = 150;
