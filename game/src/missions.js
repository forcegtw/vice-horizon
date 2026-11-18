// Missions: objective markers, briefs, completion checks and rewards.
// Three chained jobs drive the open world: boost a car, run cash, clear lookouts.
// Each job owns its own update so adding a fourth never means touching the main loop.
// Witness pass: mission state machine steps forward only; restart = full re-init, never rewinding steps.

import * as THREE from '../vendor/three.min.js';
import { MISSIONS, WORLD } from './config.js';
import { HALF } from './city.js';

// A glowing ground cylinder marking an objective, plus a floating arrow.
// Reduced opacity so the marker tints the street without washing out the view:
// a soft halo disc, a thin ring at ground level and a slim light pillar.
export function makeMarker(color = 0xffc94a) {
  const g = new THREE.Group();
  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 2.4, 3.2, 16, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })
  );
  cyl.position.y = 1.6;
  g.add(cyl);
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
    this.index = 0;          // current mission
    this.state = 'idle';     // idle | active | complete | done-all
    this.marker = makeMarker();
    this.marker.visible = false;
    scene.add(this.marker);
    this.targets = [];       // {x, z, kind, ref}
    this.timer = 0;
    this.collected = 0;
    this.rewardPending = 0;
    this.cashPickups = [];
    this.msg = '';
    this.msgT = 0;
  }

  message(text, seconds = 4) {
    this.msg = text;
    this.msgT = seconds;
  }

  current() { return MISSIONS[this.index] || null; }

  // Begin (or restart) the current mission.
  start() {
    const m = this.current();
    if (!m) return;
    this.state = 'active';
    this.collected = 0;
    this.targets = [];
    this.clearPickups();
    this.marker.visible = true;

    if (m.kind === 'car-delivery') {
      // Park a glowing sports coupe on a random street corner.
      const ang = this.rng() * Math.PI * 2;
      const spot = this.randomStreetSpot();
      this.targets.push({ x: spot.x, z: spot.z, kind: 'car', done: false });
      this.marker.position.set(spot.x, 0, spot.z);
      this.message(`MISSION — ${m.name}: ${m.brief}`);
    } else if (m.kind === 'collect') {
      for (let i = 0; i < 4; i++) {
        const spot = this.randomStreetSpot();
        this.targets.push({ x: spot.x, z: spot.z, kind: 'cash', done: false });
      }
      this.timer = 150;
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

  randomStreetSpot() {
    const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
    const along = (this.rng() - 0.5) * 2 * HALF * 0.8;
    return lane.axis === 'z' ? { x: lane.line, z: along } : { x: along, z: lane.line };
  }

  pointAtNearest() {
    const live = this.targets.filter(t => !t.done);
    if (!live.length) return;
    let best = live[0], bd = Infinity;
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

  // Per-frame update; world gives collisions with cars/peds via callbacks.
  update(dt, player, world) {
    if (this.msgT > 0) this.msgT -= dt;
    if (this.state !== 'active') return;
    const m = this.current();

    // Marker pulse.
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
        this.message(`Cache collected (${this.collected}/4)`, 2.5);
        this.pointAtNearest();
      } else if (t.kind === 'rival' && t.mesh && t.mesh.userData.dead) {
        t.done = true;
        this.collected++;
        this.message(`Lookout down (${this.collected}/3)`, 2.5);
        this.pointAtNearest();
      } else if (t.kind === 'car' && player.inCar && d < 4.5) {
        // Phase 2: drive it to the garage dock near the map edge.
        t.done = true;
        this.targets.push({ x: HALF - 20, z: 8, kind: 'dock', done: false });
        this.marker.position.set(HALF - 20, 0, 8);
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

  // Player collects a passed mission's payout (called from main loop).
  collectReward(state) {
    if (this.rewardPending > 0) {
      state.money += this.rewardPending;
      this.rewardPending = 0;
    }
  }

  // Called when the player finishes a mission on foot near a marker: advance.
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
