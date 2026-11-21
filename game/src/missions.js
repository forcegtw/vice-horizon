// Story missions: objective markers, briefs, completion checks, payouts. Three
// chained jobs drive the open world — boost a car, run cash caches, clear rival
// lookouts — and each job carries its own branch of update(), so a fourth never
// has to touch the main loop.
//
// Invariants that keep this safe to extend:
// - The state machine only ever steps forward (idle -> active -> complete ->
//   done-all); restart means a full re-init, never rewinding steps.
// - Objective markers poll cheaply; only state transitions compose HUD text.
// - Payouts are credited exactly once: update() parks them in rewardPending and
//   the main loop drains collectReward() once per frame, so a re-entered update
//   branch can never double-fire.
// - pointAtNearest() tolerates a missing player reference (shot staging and the
//   smoke harness call start() before main.js binds the player).

import * as THREE from '../vendor/three.min.js';
import { MISSIONS, WORLD, CASH_RUN } from './config.js';
import { HALF } from './city.js';

// Dock-side drop point for the car-delivery finale: two lots in from the east
// waterline, just off the shoreline road.
const GARAGE_DOCK = { x: HALF - 20, z: 8 };

// A glowing objective marker: a soft halo disc, a ground ring and a slim light
// pillar, all translucent so the tint reads without washing out the street.
// children[0] must stay the pillar — the update loop pulses its opacity.
export function makeMarker(color = 0xffc94a) {
  const g = new THREE.Group();
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 2.4, 3.2, 16, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })
  );
  pillar.position.y = 1.6;
  g.add(pillar);
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(3.1, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.05;
  g.add(halo);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.2, 2.7, 24),
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
    this.index = 0;          // which story job is on deck
    this.state = 'idle';     // idle | active | complete | done-all
    this.marker = makeMarker();
    this.marker.visible = false;
    scene.add(this.marker);
    this.targets = [];       // live objectives: {x, z, kind, done, ...}
    this.timer = 0;          // collect-mission clock
    this.collected = 0;
    this.rewardPending = 0;
    this.cashPickups = [];   // physical pickup meshes (unused pool, kept for API)
    this.msg = '';
    this.msgT = 0;
    this.playerRef = null;   // bound by main.js once the player exists
  }

  message(text, seconds = 4) {
    this.msg = text;
    this.msgT = seconds;
  }

  current() { return MISSIONS[this.index] || null; }

  // Begin (or restart) the current story job.
  start() {
    const m = this.current();
    if (!m) return;
    this.state = 'active';
    this.collected = 0;
    this.targets = [];
    this.clearPickups();
    this.marker.visible = true;

    if (m.kind === 'car-delivery') {
      // A glowing coupe parked on a random street corner; the marker points at it.
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
      for (let i = 0; i < 3; i++) {
        const spot = this.randomStreetSpot();
        this.targets.push({ x: spot.x, z: spot.z, kind: 'rival', done: false, mesh: null });
      }
      this.pointAtNearest();
      this.message(`MISSION — ${m.name}: ${m.brief}`);
    }
  }

  // A spot on the road grid: pick a lane, then a point along it.
  randomStreetSpot() {
    const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
    const along = (this.rng() - 0.5) * 2 * HALF * 0.8;
    return lane.axis === 'z' ? { x: lane.line, z: along } : { x: along, z: lane.line };
  }

  // Aim the marker at the nearest live target (first target before the player
  // ref exists — shot staging calls start() early).
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

  // Per-frame update; `player` is the live body reference, `world` the clock.
  update(dt, player, world) {
    if (this.msgT > 0) this.msgT -= dt;
    if (this.state !== 'active') return;
    const m = this.current();

    // Marker pulse: the pillar's opacity breathes with the clock.
    const pulse = 0.35 + Math.sin(world.time * 4) * 0.12;
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

      if (t.kind === 'cash' && d < 3) {
        t.done = true;
        this.collected++;
        this.sfx.pickup();
        this.message(`Cache collected (${this.collected}/${CASH_RUN.caches})`, 2.5);
        this.pointAtNearest();
      } else if (t.kind === 'rival' && t.mesh && t.mesh.userData.dead) {
        t.done = true;
        this.collected++;
        this.message(`Lookout down (${this.collected}/3)`, 2.5);
        this.pointAtNearest();
      } else if (t.kind === 'car' && player.inCar && d < 4.5) {
        // Phase 2: the boosted coupe must be dropped at the garage dock by the
        // map edge. Appended mid-loop on purpose; the same pass may visit it.
        t.done = true;
        this.targets.push({ x: GARAGE_DOCK.x, z: GARAGE_DOCK.z, kind: 'dock', done: false });
        this.marker.position.set(GARAGE_DOCK.x, 0, GARAGE_DOCK.z);
        this.message('Nice boost. Now drop it at the garage dock.', 4);
      } else if (t.kind === 'dock' && player.inCar && d < 6) {
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

  // The main loop drains a passed mission's payout here, once per frame — kept
  // out of update() so a payout can never double-fire.
  collectReward(state) {
    if (this.rewardPending > 0) {
      state.money += this.rewardPending;
      this.rewardPending = 0;
    }
  }

  // Called from main.js when the player asks for the next job (T / START click).
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
  }
}
