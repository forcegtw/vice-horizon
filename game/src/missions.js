// missions.js — the story chain: three chained jobs (car boost, cash run,
// rival sweep). One marker mesh per Missions instance is reused across jobs,
// so the scene graph never grows with play time. The state machine only
// moves forward: a failed run means re-starting the job, never rewinding
// steps. Payouts ride a pending slot drained once per frame through
// collectReward, so a reward can never double-fire out of a re-entered
// update branch. Every spawn point snaps to city.roadLines, which keeps all
// objectives drive-able.

import * as THREE from '../vendor/three.min.js';
import { MISSIONS, CASH_RUN } from './config.js';
import { HALF } from './city.js';

// Objective marker: light pillar, ground halo, ring — all translucent so the
// street beneath stays readable. children[0] is the pillar; callers pulse its
// opacity each frame, so keep that slot first.
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

// Rivals in the eliminate job — a content number, not a tuning knob.
const RIVALS = 3;
// Reach radii: caches are generous, car hand-offs need precision, docks wide.
const RADIUS = Object.freeze({ cash: 3, car: 4.5, dock: 6 });
// Deliveries drop at the garage dock by the map's east edge.
const DOCK_X = 20;   // metres inside the boundary, i.e. HALF - DOCK_X
const DOCK_Z = 8;
// The dock point itself, resolved once.
const DOCK = Object.freeze({ x: HALF - DOCK_X, z: DOCK_Z });
// Progress denominators shared by caches and rivals in HUD copy.
const PROGRESS_TOTALS = Object.freeze({ collect: CASH_RUN.caches, eliminate: RIVALS });

export class Missions {
  constructor(scene, rng, city, sfx) {
    this.scene = scene;
    this.rng = rng;
    this.city = city;
    this.sfx = sfx;
    this.index = 0;            // position in the MISSIONS table
    this.state = 'idle';       // idle | active | complete | done-all
    this.marker = makeMarker();
    this.marker.visible = false;
    scene.add(this.marker);
    this.targets = [];         // {x, z, kind, done, mesh?}
    this.timer = 0;            // collect-job countdown
    this.collected = 0;        // caches grabbed / rivals downed this run
    this.rewardPending = 0;
    this.cashPickups = [];
    this.msg = '';
    this.msgT = 0;
    this.playerRef = null;     // bound by main.js after boot
  }

  message(text, seconds = 4) {
    this.msg = text;
    this.msgT = seconds;
  }

  current() { return MISSIONS[this.index] || null; }

  setPlayerRef(p) { this.playerRef = p; }

  start() {
    const m = this.current();
    if (!m) return;
    this.state = 'active';
    this.collected = 0;
    this.targets = [];
    this.clearPickups();
    this.marker.visible = true;

    if (m.kind === 'car-delivery') {
      // A coupe parked on a street corner; the marker points at it.
      const spot = this.randomStreetSpot();
      this.targets.push({ x: spot.x, z: spot.z, kind: 'car', done: false });
      this.marker.position.set(spot.x, 0, spot.z);
    } else if (m.kind === 'collect') {
      for (let i = 0; i < CASH_RUN.caches; i++) {
        const spot = this.randomStreetSpot();
        this.targets.push({ x: spot.x, z: spot.z, kind: 'cash', done: false });
      }
      this.timer = CASH_RUN.timeLimit;
      this.pointAtNearest();
    } else if (m.kind === 'eliminate') {
      for (let i = 0; i < RIVALS; i++) {
        const spot = this.randomStreetSpot();
        this.targets.push({ x: spot.x, z: spot.z, kind: 'rival', done: false, mesh: null });
      }
      this.pointAtNearest();
    }
    this.message(`MISSION — ${m.name}: ${m.brief}`);
  }

  // A random spot on a random road line, inside 80% of the city half-extent.
  randomStreetSpot() {
    const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
    const along = (this.rng() - 0.5) * 2 * HALF * 0.8;
    return lane.axis === 'z' ? { x: lane.line, z: along } : { x: along, z: lane.line };
  }

  // The marker follows the closest live target. Falls back to the first
  // target when the player ref isn't bound yet (shot staging and smoke
  // harnesses call start() early).
  pointAtNearest() {
    const live = this.targets.filter((t) => !t.done);
    if (!live.length) return;
    let best = live[0];
    if (this.playerRef) {
      let bestD = Infinity;
      for (const t of live) {
        const d = (t.x - this.playerRef.x) ** 2 + (t.z - this.playerRef.z) ** 2;
        if (d < bestD) { bestD = d; best = t; }
      }
    }
    this.marker.position.set(best.x, 0, best.z);
  }

  clearPickups() {
    for (const p of this.cashPickups) this.scene.remove(p.mesh);
    this.cashPickups.length = 0;
  }

  update(dt, player, world) {
    if (this.msgT > 0) this.msgT -= dt;
    if (this.state !== 'active') return;
    const m = this.current();

    // The marker pulse drives the pillar's opacity; halo and ring stay steady.
    this.marker.children[0].material.opacity = 0.35 + Math.sin(world.time * 4) * 0.12;

    // Collect jobs are timed: a timeout fails the run outright.
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

      if (t.kind === 'cash' && d < RADIUS.cash) {
        t.done = true;
        this.collected++;
        this.sfx.pickup();
        this.message(`Cache collected (${this.collected}/${PROGRESS_TOTALS.collect})`, 2.5);
        this.pointAtNearest();
      } else if (t.kind === 'rival' && t.mesh && t.mesh.userData.dead) {
        // Rivals die through main.js's attack path; the mesh flag is the
        // kill record this state machine reads.
        t.done = true;
        this.collected++;
        this.message(`Lookout down (${this.collected}/${PROGRESS_TOTALS.eliminate})`, 2.5);
        this.pointAtNearest();
      } else if (t.kind === 'car' && player.inCar && d < RADIUS.car) {
        // Phase 2: deliver the boosted car to the dock by the map edge.
        t.done = true;
        this.targets.push({ x: DOCK.x, z: DOCK.z, kind: 'dock', done: false });
        this.marker.position.set(DOCK.x, 0, DOCK.z);
        this.message('Nice boost. Now drop it at the garage dock.', 4);
      } else if (t.kind === 'dock' && player.inCar && d < RADIUS.dock) {
        t.done = true;
        this.message('Delivery complete.', 3);
      }
    }

    if (allDone) {
      this.state = this.index < MISSIONS.length - 1 ? 'complete' : 'done-all';
      this.marker.visible = false;
      this.clearPickups();
      this.rewardPending = m.reward;
      this.message(`MISSION PASSED — $${m.reward}`, 5);
      this.sfx.cash();
    }
  }

  // Credit one pending payout per frame; the loop calls this after update().
  collectReward(state) {
    if (this.rewardPending > 0) {
      state.money += this.rewardPending;
      this.rewardPending = 0;
    }
  }

  // T (or the start button) advances: start a new job, or step past a passed one.
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
    this.targets = [];
    this.timer = 0;
    this.collected = 0;
    this.rewardPending = 0;
  }
}
