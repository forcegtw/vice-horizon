// missions2.js — the side-job board: checkpoint races, timed delivery runs and
// rampage contracts. Runs alongside the story chain (main.js owns the trigger
// key); every job reuses one 3D marker so the scene graph never grows with job
// count. Rewards are reported through onReward so money keeps a single writer
// (state.money is credited in main.js), and rampage kills bubble up as crimes
// through onCrime. All positions snap to the road grid via city.roadLines,
// matching Missions.randomStreetSpot, so every target is reachable by car.
// blips() guards a race whose route was never built; the delivery speed bonus
// is clamped so a fast haul can never pay more than DELIVERY_BONUS_MAX.

import * as THREE from '../vendor/three.min.js';
import { HALF } from './city.js';
import { WORLD } from './config.js';
import { makeMarker } from './missions.js';

export const JOB_COLORS = {
  race: 0x5fd6ff,
  delivery: 0xffa95f,
  rampage: 0xff5fd6,
};

// Static job catalogue. Race checkpoints and delivery addresses are generated
// per start from the road grid, so payouts scale with route length.
export const JOB_CATALOGUE = [
  { id: 'race-1', kind: 'race', name: 'Boardwalk Sprint', cps: 4, limit: 70, payout: 650 },
  { id: 'race-2', kind: 'race', name: 'Downtown Slalom', cps: 5, limit: 90, payout: 850 },
  { id: 'race-3', kind: 'race', name: 'Coast-to-Coast', cps: 6, limit: 115, payout: 1100 },
  { id: 'delivery-1', kind: 'delivery', name: 'Pizza Dash', limit: 55, payout: 420 },
  { id: 'delivery-2', kind: 'delivery', name: 'Parcel Express', limit: 80, payout: 700 },
  { id: 'delivery-3', kind: 'delivery', name: 'Gold Bullion Run', limit: 100, payout: 1000 },
  { id: 'rampage-1', kind: 'rampage', name: 'Sidewalk Rage', target: 6, limit: 60, payout: 550 },
  { id: 'rampage-2', kind: 'rampage', name: 'Neon Nightmare', target: 9, limit: 75, payout: 800 },
];

// Delivery speed bonus: up to +25% of the base payout when over half the clock
// remains at drop-off.
const DELIVERY_BONUS_MAX = 0.25;

// Objective radii and payout-scaling constants.
const RACE_CP_RADIUS = 6;
const PICKUP_RADIUS = 5;
const DROPOFF_RADIUS = 6;
const ROUTE_MIN_GAP = WORLD.lotSize;   // checkpoints always step at least one block
const ROUTE_RETRY_CAP = 8;
const PAYOUT_BASE_SHARE = 0.6;         // minimum share of the catalogue payout
const PAYOUT_DISTANCE_SPAN = HALF * 1.2; // haul distance that reaches full pay

export class SideJobs {
  constructor(scene, rng, city, sfx) {
    this.scene = scene;
    this.rng = rng;
    this.city = city;
    this.sfx = sfx;
    this.catalogue = JOB_CATALOGUE;
    this.cursor = 0;          // next catalogue entry offered when work is asked for
    this.job = null;          // active job record (a copy of the spec + route/stage)
    this.state = 'idle';      // idle | active
    this.timer = 0;
    this.progress = 0;        // checkpoints hit / packages done / kills
    this.marker = makeMarker(JOB_COLORS.race);
    this.marker.visible = false;
    scene.add(this.marker);
    this.raceGate = null;     // translucent start-line ribbon for races
    this.msg = '';
    this.msgT = 0;
    this.onReward = null;     // (cash, jobName) => void, wired in main.js
    this.onCrime = null;      // rampage kills surface as ped-hit crimes
  }

  message(text, seconds = 4) {
    this.msg = text;
    this.msgT = seconds;
  }

  blipColor() {
    return this.job ? JOB_COLORS[this.job.kind] || 0xffc94a : 0xffc94a;
  }

  // Minimap hook: the current objective — a race lists its whole remaining
  // route, the live checkpoint bright and the future ones dimmed.
  blips() {
    if (this.state !== 'active' || !this.job) return [];
    const out = [];
    if (this.job.kind === 'race') {
      if (!this.job.cps) return [];
      this.job.cps.forEach((c, i) => {
        if (i >= this.progress) {
          out.push({
            x: c.x, z: c.z,
            color: i === this.progress ? this.blipColor() : 0x3f7f9f,
            size: i === this.progress ? 5 : 3,
          });
        }
      });
    } else {
      out.push({ x: this.job.tx, z: this.job.tz, color: this.blipColor(), size: 5 });
    }
    return out;
  }

  // Take the next catalogue entry and roll a fresh route for it.
  startNext() {
    if (this.state === 'active') return this.message('Finish the current job first.', 2.5);
    const spec = this.catalogue[this.cursor % this.catalogue.length];
    this.cursor++;
    this.job = { ...spec };
    this.progress = 0;
    this.timer = spec.limit;
    this.state = 'active';

    if (spec.kind === 'race') {
      this.job.cps = this.buildRoute(spec.cps);
      this.job.startPos = { x: this.job.cps[0].x, z: this.job.cps[0].z };
      this.showRaceGate(this.job.startPos);
      this.marker.visible = true;
      this.setMarkerAt(this.job.cps[0], JOB_COLORS.race);
      this.message(`RACE — ${spec.name}: hit ${this.job.cps.length} checkpoints in ${spec.limit}s.`);
    } else if (spec.kind === 'delivery') {
      const pick = this.streetSpot();
      const drop = this.streetSpot();
      this.job.stage = 'pickup';
      this.job.px = pick.x;
      this.job.pz = pick.z;
      this.job.tx = drop.x;
      this.job.tz = drop.z;
      // Payout scales with straight-line haul distance, base share guaranteed.
      const haul = Math.hypot(drop.x - pick.x, drop.z - pick.z);
      this.job.payout = Math.round(spec.payout * (PAYOUT_BASE_SHARE + Math.min(1, haul / PAYOUT_DISTANCE_SPAN)));
      this.marker.visible = true;
      this.setMarkerAt(pick, JOB_COLORS.delivery);
      this.message(`DELIVERY — ${spec.name}: grab the goods, then drop them across town. $${this.job.payout} on time.`);
    } else {
      this.job.kind = 'rampage';
      this.job.stage = 'hunt';
      this.marker.visible = false;
      this.message(`RAMPAGE — ${spec.name}: take down ${spec.target} peds in ${spec.limit}s. Police will care.`);
    }
    this.sfx.pickup();
    return spec;
  }

  // Ordered checkpoint chain that always steps at least one block, so a route
  // reads as a drive instead of jitter around one intersection.
  buildRoute(count) {
    const pts = [];
    let last = null;
    for (let i = 0; i < count; i++) {
      let spot = this.streetSpot();
      let tries = 0;
      while (last && Math.hypot(spot.x - last.x, spot.z - last.z) < ROUTE_MIN_GAP && tries++ < ROUTE_RETRY_CAP) {
        spot = this.streetSpot();
      }
      pts.push({ x: spot.x, z: spot.z });
      last = spot;
    }
    return pts;
  }

  streetSpot() {
    const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
    const along = (this.rng() - 0.5) * 2 * HALF * 0.8;
    return lane.axis === 'z' ? { x: lane.line, z: along } : { x: along, z: lane.line };
  }

  setMarkerAt(pos, color) {
    this.marker.position.set(pos.x, 0, pos.z);
    for (const child of this.marker.children) child.material.color.setHex(color);
  }

  // Start-line ribbon across the first checkpoint, so a race reads as an event
  // rather than a floating cylinder.
  showRaceGate(pos) {
    if (!this.raceGate) {
      this.raceGate = new THREE.Mesh(
        new THREE.BoxGeometry(WORLD.roadWidth * 0.9, 0.4, 1.2),
        new THREE.MeshBasicMaterial({ color: JOB_COLORS.race, transparent: true, opacity: 0.5 })
      );
      this.raceGate.position.y = 0.3;
      this.scene.add(this.raceGate);
    }
    this.raceGate.visible = true;
    this.raceGate.position.set(pos.x, 0.3, pos.z);
  }

  hideRaceGate() {
    if (this.raceGate) this.raceGate.visible = false;
  }

  // Rampage scoring hook, called from main.js wherever peds die.
  onPedKilled() {
    if (this.state !== 'active' || this.job?.kind !== 'rampage') return;
    this.progress++;
    if (this.progress < this.job.target) {
      this.message(`Rampage: ${this.progress}/${this.job.target}`, 1.5);
    }
    if (this.onCrime) this.onCrime();
  }

  fail(reason) {
    this.state = 'idle';
    this.job = null;
    this.marker.visible = false;
    this.hideRaceGate();
    this.message(`JOB FAILED — ${reason}`, 5);
    this.sfx.wantedUp();
  }

  pass() {
    // Payout prefers the job's own record (delivery bonuses rewrite it), then
    // the spec; clamped at 0 so a malformed record can never pay negative cash.
    const payout = Math.max(0, this.job.payout ?? this.job.spec?.payout ?? 0);
    this.message(`JOB PASSED — $${payout}`, 5);
    this.sfx.cash();
    if (this.onReward) this.onReward(payout, this.job.name);
    this.state = 'idle';
    this.job = null;
    this.marker.visible = false;
    this.hideRaceGate();
  }

  update(dt, player, world) {
    if (this.msgT > 0) this.msgT -= dt;
    if (this.state !== 'active' || !this.job) return;
    const job = this.job;
    this.timer -= dt;
    if (this.timer <= 0) return this.fail('time ran out.');

    // Marker pulse, matched to the story mission's marker.
    const pulse = 0.35 + Math.sin(world.time * 4) * 0.12;
    this.marker.children[0].material.opacity = pulse;

    const px = player.x;
    const pz = player.z;
    const d = (x, z) => Math.hypot(x - px, z - pz);

    if (job.kind === 'race') {
      const cp = job.cps[this.progress];
      if (d(cp.x, cp.z) < RACE_CP_RADIUS) {
        this.progress++;
        this.sfx.pickup();
        if (this.progress >= job.cps.length) return this.pass();
        const next = job.cps[this.progress];
        this.setMarkerAt(next, JOB_COLORS.race);
        this.message(`Checkpoint ${this.progress}/${job.cps.length} — ${Math.ceil(this.timer)}s left`, 2);
      }
    } else if (job.kind === 'delivery') {
      if (job.stage === 'pickup' && d(job.px, job.pz) < PICKUP_RADIUS) {
        job.stage = 'dropoff';
        this.setMarkerAt({ x: job.tx, z: job.tz }, JOB_COLORS.delivery);
        this.message('Package secured. Haul it to the drop-off.', 3);
        this.sfx.pickup();
      } else if (job.stage === 'dropoff' && d(job.tx, job.tz) < DROPOFF_RADIUS && player.inCar) {
        // Speed bonus: up to +25% when over half the clock remains.
        const bonus = Math.max(0, Math.min(1, this.timer / job.limit - 0.5) * 2);
        job.payout = Math.round(job.payout * (1 + DELIVERY_BONUS_MAX * bonus));
        return this.pass();
      }
    } else if (job.kind === 'rampage') {
      if (this.progress >= job.target) return this.pass();
    }
  }

  reset() {
    this.state = 'idle';
    this.job = null;
    this.timer = 0;
    this.progress = 0;
    this.marker.visible = false;
    this.hideRaceGate();
    this.msg = '';
    this.msgT = 0;
  }
}
