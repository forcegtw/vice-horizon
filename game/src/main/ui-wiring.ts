// Interface wiring: everything the player sees or clicks, plus the shot
// staging entry. Splits out of the old main.js body — overlay, HUD, the
// wanted/radio/economy systems that own UI toasts, the minimap mirror, and
// the three event listeners (START button, P pause, window resize).
//
// wireHudWorld keeps the constructor order of the original module body
// (overlay -> hud -> wanted -> radio -> economy -> minimap); economy stays
// last in the shared rng stream, exactly where it was. wireUiEvents attaches
// the listeners and runs the initial resize. applyShot stages a ?shot= URL
// into a deterministic tableau before the first frame ticks.

import { Hud } from '../hud.js';
import { Wanted } from '../wanted.js';
import { Radio } from '../radio.js';
import { Economy } from '../economy.js';
import { Minimap } from '../minimap.js';
import { SHOTS } from '../shots.js';
import { wantedUp } from './input-bindings.ts';

// Create the UI-facing systems, hand them their state hooks, and publish them
// on the world context (w.overlay, w.hud, w.wanted, w.radio, w.economy,
// w.minimap).
export function wireHudWorld(w) {
  // Start-screen overlay.
  const overlay = Hud.overlay(document.body);
  overlay.show(
    'VICE HORIZON',
    'An open-world crime playground on the neon coast. Steal cars, run jobs, outrun the heat.',
    'WASD — move / drive · Shift — sprint · F — enter / steal car · LMB — attack<br>' +
    'E / Q — switch weapon · T — start next job · G — side job board<br>' +
    'M — toggle big map / next mission · P — pause · R — respawn after bust',
    'START',
  );

  const hud = new Hud(document.body);
  // Heat-driven star system sits on top of Police: crimes bank heat, cops follow
  // the star count, and heat bleeds off once nobody has eyes on the player.
  const wanted = new Wanted(w.state, w.sfx, hud);
  const radio = new Radio(w.sfx);
  const economy = new Economy(w.scene, w.city, w.rng);
  const minimap = new Minimap(document.body, w.city);
  minimap.setVisible = ((orig) => (v) => { orig(v); hud.setMinimapVisible(v); })(minimap.setVisible.bind(minimap));
  w.state.wantedSys = wanted;
  w.state.weather = w.weather;
  w.state.radio = radio;
  w.state.economy = economy;
  // Economy owns upgrades and merges its persisted cash into state.money
  // (only when the main save had none, so the newer save wins).
  economy.bind(w.state);
  // Side-job crime bridge: set here because wantedUp lives in input-bindings,
  // and boot must not depend on the bindings module.
  w.sideJobs.onCrime = () => wantedUp(w, 1, 'pedHit');

  w.overlay = overlay;
  w.hud = hud;
  w.wanted = wanted;
  w.radio = radio;
  w.economy = economy;
  w.minimap = minimap;
}

// The three global listeners. P pause stops the radio scheduler with the
// overlay up so music cannot silently queue and dump a burst on resume.
export function wireUiEvents(w) {
  w.overlay.btn.addEventListener('click', () => {
    w.sfx.ensure();
    w.sfx.resume();
    w.overlay.hide();
    w.running = true;
    w.mission.advance(); // kicks off mission 1 automatically
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP' && w.running) {
      w.state.paused = !w.state.paused;
      if (w.state.paused) {
        w.overlay.show('PAUSED', 'Take a breath. The city waits.', 'P — resume', 'RESUME');
      } else {
        w.overlay.hide();
        // Pause stopped the radio scheduler; restart it if the player is mid-drive.
        if (w.player.inCar && w.radio.enabled && w.radio.station().id !== 'off') w.radio.start();
      }
    }
  });

  const onResize = () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    w.renderer.setSize(vw, vh, false);
    w.camera.aspect = vw / vh;
    w.camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);
  onResize();
}

// Shot staging needs the overlay handle, so it runs after wireHudWorld.
export function applyShot(w) {
  if (!w.shotName || !SHOTS[w.shotName]) return false;
  w.running = true;
  w.state.overlay = w.overlay;
  SHOTS[w.shotName](w.state);
  if (w.shotName !== 'start') w.overlay.hide();
  return true;
}
