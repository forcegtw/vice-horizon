// missions.js — the story chain: boost a car, run cash caches, clear rivals.
// Each job owns its own update branch, so adding a fourth never touches the
// main loop. The state machine steps forward only; restart means a full re-init
// through start(), never rewinding steps. HUD text is touched only on state
// transitions, and rewards are credited exactly once inside the completion
// branch — never per frame.
// pointAtNearest tolerates a missing player ref: shot staging and the smoke
// harness call start() before main.js has handed over the player.

import * as THREE from '../vendor/three.min.js';
import { MISSIONS, CASH_RUN } from './config.js';
import { HALF } from './city.js';

// Objective geometry tuning: a soft halo disc on the ground, a thin bright ring,
// and a slim light pillar. Reduced opacity tints the street without washing out
// the view; children[0] is the pillar, whose opacity the loop pulses.
const MARKER_PILLAR_RADIUS = 2.4;
const MARKER_HALO_RADIUS = 3.1;
const MARKER_RING_INNER = 2.2;
const MARKER_RING_OUTER = 2.7;
const MARKER_PULSE_BASE = 0.35;
const MARKER_PULSE_SWING = 0.12;

// Pick-up radii per objective kind, in metres.
const CASH_RADIUS = 3;
const CAR_RADIUS = 4.5;
const DOCK_RADIUS = 6;

// The garage dock every boosted car is delivered to, near the east map edge.
const DOCK_X = HALF - 20;
const DOCK_Z = 8;

// Rival lookouts the eliminate mission asks for; their HP is bookkept by
// main.js's attack(), which flips mesh.userData.dead when one drops.
const RIVAL_COUNT = 3;

// A glowing objective marker: translucent cylinder pillar + halo disc + ring.
export function makeMarker(color = 0xffc94a) {
  const g = new THREE.Group();
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(MARKER_PILLAR_RADIUS, MARKER_PILLAR_RADIUS, 3.2, 16, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })
  );
  pillar.position.y = 1.6;
  g.add(pillar);
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(MARKER_HALO_RADIUS, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.05;
  g.add(halo);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(MARKER_RING_INNER, MARKER_RING_OUTER, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.12;
  g.add(ring);
  return g;
}

export class Missions {
  constructor(scene, rng, city, sfx) {
    this.scene = scene;
    this.rng = rng;
    this.city = city;
    this.sfx = sfx;
    this.index = 0;          // current story job
    this.state = 'idle';     // idle | active | complete | done-all
    this.marker = makeMarker();
    this.marker.visible = false;
    scene.add(this.marker);
    this.targets = [];       // {x, z, kind, done, mesh?}
    this.timer = 0;
    this.collected = 0;
    this.rewardPending = 0;
    this.cashPickups = [];
    this.msg = '';
    this.msgT = 0;
    this.playerRef = null;
  }

  message(text, seconds = 4) {
    this.msg = text;
    this.msgT = seconds;
  }

  current() { return MISSIONS[this.index] || null; }

  // Begin (or restart) the current mission from a clean slate.
  start() {
    const m = this.current();
    if (!m) return;
    this.state = 'active';
    this.collected = 0;
    this.targets = [];
    this.clearPickups();
    this.marker.visible = true;

    if (m.kind === 'car-delivery') {
      // A glowing coupe waits on a street corner; the marker points at it.
      const spot = this.randomStreetSpot();
      this.targets.push({ x: spot.x, z: spot.z, kind: 'car', done: false });
      this.marker.position.set(spot.x, 0, spot.z);
      this.message(`MISSION — ${m.name}: ${m.brief}`);
    } else if (m.kind === 'collect') {
      for (let i = 0; i < CASH_RUN.caches; i++) {
        const spot = this.randomStreetSpot();
        this.targets.push({ x: spot.x, z: spot.z, kind: 'cash', done: false });
      }
      this.timer = CASH_RUN.timeLimit;
      this.pointAtNearest();
      this.message(`MISSION — ${m.name}: ${m.brief}`);
    } else if (m.kind === 'eliminate') {
      for (let i = 0; i < RIVAL_COUNT; i++) {
        const spot = this.randomStreetSpot();
        this.targets.push({ x: spot.x, z: spot.z, kind: 'rival', done: false, mesh: null });
      }
      this.pointAtNearest();
      this.message(`MISSION — ${m.name}: ${m.brief}`);
    }
  }

  // A reachable spot on the road grid: a street line at a random offset, kept
  // inside 80% of the map so objectives never spawn in the far margin.
  randomStreetSpot() {
    const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
    const along = (this.rng() - 0.5) * 2 * HALF * 0.8;
    return lane.axis === 'z' ? { x: lane.line, z: along } : { x: along, z: lane.line };
  }

  // Swing the marker to the nearest live objective; before main.js binds the
  // player (shot staging, smoke runs) fall back to the first live target.
  pointAtNearest() {
    const live = this.targets.filter((t) => !t.done);
    if (!live.length) return;
    if (!this.playerRef) {
      this.marker.position.set(live[0].x, 0, live[0].z);
      return;
    }
    let best = live[0];
    let bd = Infinity;
    for (const t of live) {
      const d = (t.x - this.playerRef.x) ** 2 + (t.z - this.playerRef.z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    this.marker.position.set(best.x, 0, best.z);
  }

  clearPickups() {
    for (const p of this.cashPickups) this.scene.remove(p.mesh);
    this.cashPickups.length = 0;
  }

  setPlayerRef(p) { this.playerRef = p; }

  // Per-frame update; `world` carries the shared clock for marker pulsing.
  update(dt, player, world) {
    if (this.msgT > 0) this.msgT -= dt;
    if (this.state !== 'active') return;
    const m = this.current();

    const pulse = MARKER_PULSE_BASE + Math.sin(world.time * 4) * MARKER_PULSE_SWING;
    this.marker.children[0].material.opacity = pulse;

    if (m.kind === 'collect') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.state = 'idle';
        this.marker.visible = false;
        this.message('MISSION FAILED — time ran out.', 5);
        this.sfx.wantedUp();
        return;
      }
    }

    let allDone = true;
    for (const t of this.targets) {
      if (t.done) continue;
      allDone = false;
      const d = Math.hypot(t.x - player.x, t.z - player.z);

      if (t.kind === 'cash' && d < CASH_RADIUS) {
        t.done = true;
        this.collected++;
        this.sfx.pickup();
        this.message(`Cache collected (${this.collected}/${CASH_RUN.caches})`, 2.5);
        this.pointAtNearest();
      } else if (t.kind === 'rival' && t.mesh && t.mesh.userData.dead) {
        t.done = true;
        this.collected++;
        this.message(`Lookout down (${this.collected}/${RIVAL_COUNT})`, 2.5);
        this.pointAtNearest();
      } else if (t.kind === 'car' && player.inCar && d < CAR_RADIUS) {
        // Phase 2 of the boost: drive the coupe to the garage dock.
        t.done = true;
        this.targets.push({ x: DOCK_X, z: DOCK_Z, kind: 'dock', done: false });
        this.marker.position.set(DOCK_X, 0, DOCK_Z);
        this.message('Nice boost. Now drop it at the garage dock.', 4);
      } else if (t.kind === 'dock' && player.inCar && d < DOCK_RADIUS) {
        t.done = true;
        this.message('Delivery complete.', 3);
      }
    }

    if (allDone) {
      const reward = m.reward;
      this.state = this.index < MISSIONS.length - 1 ? 'complete' : 'done-all';
      this.marker.visible = false;
      this.clearPickups();
      this.rewardPending = reward;
      this.message(`MISSION PASSED — $${reward}`, 5);
      this.sfx.cash();
    }
  }

  // Drain a passed mission's payout. Deliberately separate from update() so a
  // payout can never double-fire from a re-entered update branch: the loop
  // calls this once per frame.
  collectReward(state) {
    if (this.rewardPending > 0) {
      state.money += this.rewardPending;
      this.rewardPending = 0;
    }
  }

  // Advance the chain: collect a completed job and either kick off the next one
  // or, when the table is exhausted, settle into the done-all ending.
  advance() {
    if (this.state === 'complete' || this.state === 'done-all') {
      this.index++;
      this.state = 'idle';
      if (this.index >= MISSIONS.length) {
        this.index = MISSIONS.length;
        this.state = 'done-all';
        this.message('All jobs done. The city is yours.', 6);
      }
    } else if (this.state === 'idle' && this.current()) {
      this.start();
    }
  }

  reset() {
    this.index = 0;
    this.state = 'idle';
    this.marker.visible = false;
    this.clearPickups();
    this.rewardPending = 0;
    // Clear the banner too, so a reset never leaves a stale "MISSION PASSED"
    // hanging on screen until its old timer runs out.
    this.msg = '';
    this.msgT = 0;
  }
}
