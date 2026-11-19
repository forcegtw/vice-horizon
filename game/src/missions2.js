// missions2.js — side-job board: checkpoint races, timed deliveries and
// rampage contracts, running alongside the story chain. One reused marker per
// SideJobs instance plus a race start gate; nothing here grows the scene over
// time. Money is reported through onReward — state.money is credited in
// main.js, keeping a single writer for cash. Routes and addresses are rolled
// per-start from city.roadLines, so payouts scale with haul length. blips()
// guards a race whose route was never built, and the delivery bonus is clamped
// so an early haul can never pay more than DELIVERY_BONUS_MAX.
//
// Job kinds and their flow:
//   race     — hit every checkpoint before the clock; marker hops per gate
//   delivery — pickup point, then a drop-off that needs a car
//   rampage  — onPedKilled() counts down a target; wanted level climbs too

import * as THREE from '../vendor/three.min.js';
import { WORLD } from './config.js';
import { HALF } from './city.js';
import { makeMarker } from './missions.js';

// Blip and marker colors, one per job kind; shared neutral when idle.
const JOB_COLORS = {
  race: 0x5fd6ff,
  delivery: 0xffa95f,
  rampage: 0xff5fd6,
};
const IDLE_COLOR = 0xffc94a;
const DIM_BLIP = 0x3f7f9f;

// Static catalogue. Race checkpoint counts and limits are per-job; the actual
// route and payout roll at startNext().
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

// Delivery speed bonus: max fraction of the base payout added for a fast haul.
const DELIVERY_BONUS_MAX = 0.25;

// Distance in metres that counts as "reached" for gates, pickups and drops.
// Gates and drop-offs are a touch more generous than pickups on purpose: at
// speed 6 m is one frame, while a walk-up pickup should feel deliberate.
const HIT_RADIUS_GATE = 6;
const HIT_RADIUS_PICKUP = 5;

export class SideJobs {
  constructor(scene, rng, city, sfx) {
    this.scene = scene;
    this.rng = rng;
    this.city = city;
    this.sfx = sfx;
    this.catalogue = JOB_CATALOGUE;
    this.cursor = 0;        // next catalogue entry to offer
    this.job = null;        // active job record (spec + rolled route/stage)
    this.state = 'idle';    // idle | active
    this.timer = 0;
    this.progress = 0;      // checkpoints / packages / kills
    this.marker = makeMarker(JOB_COLORS.race);
    this.marker.visible = false;
    scene.add(this.marker);
    this.raceGate = null;   // start-line ribbon, created on first race
    this.msg = '';
    this.msgT = 0;
    this.onReward = null;   // (cash, jobName) => void — wired in main.js
    this.onCrime = null;    // rampage kills bubble up as ped-hit crimes
  }

  message(text, seconds = 4) {
    this.msg = text;
    this.msgT = seconds;
  }

  blipColor() {
    return this.job ? JOB_COLORS[this.job.kind] || IDLE_COLOR : IDLE_COLOR;
  }

  // Minimap hook: remaining race checkpoints (next one bright, rest dim) or the
  // single delivery/rampage objective.
  blips() {
    if (this.state !== 'active' || !this.job) return [];
    const out = [];
    if (this.job.kind === 'race') {
      if (!this.job.cps) return out;
      this.job.cps.forEach((c, i) => {
        if (i >= this.progress) {
          out.push({
            x: c.x,
            z: c.z,
            color: i === this.progress ? this.blipColor() : DIM_BLIP,
            size: i === this.progress ? 5 : 3,
          });
        }
      });
    } else {
      out.push({ x: this.job.tx, z: this.job.tz, color: this.blipColor(), size: 5 });
    }
    return out;
  }

  startNext() {
    if (this.state === 'active') {
      this.message('Finish the current job first.', 2.5);
      return null;
    }
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
      this.message(`RACE — ${spec.name}: hit ${spec.cps} checkpoints in ${spec.limit}s.`);
    } else if (spec.kind === 'delivery') {
      const pick = this.streetSpot();
      const drop = this.streetSpot();
      this.job.stage = 'pickup';
      this.job.px = pick.x; this.job.pz = pick.z;
      this.job.tx = drop.x; this.job.tz = drop.z;
      // Payout scales with straight-line haul distance, min 60% of base.
      const haul = Math.hypot(drop.x - pick.x, drop.z - pick.z);
      this.job.payout = Math.round(spec.payout * (0.6 + Math.min(1, haul / (HALF * 1.2))));
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

  // Checkpoint chain that always steps at least one block between points, so a
  // route reads as a drive instead of jitter around one intersection.
  buildRoute(count) {
    const pts = [];
    let last = null;
    for (let i = 0; i < count; i++) {
      let spot = this.streetSpot();
      let tries = 0;
      while (last && Math.hypot(spot.x - last.x, spot.z - last.z) < WORLD.lotSize && tries++ < 8) {
        spot = this.streetSpot();
      }
      pts.push({ x: spot.x, z: spot.z });
      last = spot;
    }
    return pts;
  }

  // A random spot on a random road line, inside 80% of the city half-extent.
  streetSpot() {
    const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
    const along = (this.rng() - 0.5) * 2 * HALF * 0.8;
    return lane.axis === 'z' ? { x: lane.line, z: along } : { x: along, z: lane.line };
  }

  setMarkerAt(pos, color) {
    this.marker.position.set(pos.x, 0, pos.z);
    for (const child of this.marker.children) child.material.color.setHex(color);
  }

  // Thin glowing bar across a race's first checkpoint.
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

  // Rampage scoring hook; main.js calls it wherever a ped dies.
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
    // The job's own payout (delivery bonuses rewrite it) wins over the spec;
    // clamped so a malformed record pays nothing, never negative cash.
    const payout = Math.max(0, this.job.payout ?? 0);
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

    // Marker pulse, matched to the story marker's rhythm.
    this.marker.children[0].material.opacity = 0.35 + Math.sin(world.time * 4) * 0.12;

    const px = player.x;
    const pz = player.z;
    const d = (x, z) => Math.hypot(x - px, z - pz);

    if (job.kind === 'race') {
      const cp = job.cps[this.progress];
      if (d(cp.x, cp.z) < HIT_RADIUS_GATE) {
        this.progress++;
        this.sfx.pickup();
        if (this.progress >= job.cps.length) return this.pass();
        this.setMarkerAt(job.cps[this.progress], JOB_COLORS.race);
        this.message(`Checkpoint ${this.progress}/${job.cps.length} — ${Math.ceil(this.timer)}s left`, 2);
      }
    } else if (job.kind === 'delivery') {
      if (job.stage === 'pickup' && d(job.px, job.pz) < HIT_RADIUS_PICKUP) {
        job.stage = 'dropoff';
        this.setMarkerAt({ x: job.tx, z: job.tz }, JOB_COLORS.delivery);
        this.message('Package secured. Haul it to the drop-off.', 3);
        this.sfx.pickup();
      } else if (job.stage === 'dropoff' && d(job.tx, job.tz) < HIT_RADIUS_GATE && player.inCar) {
        // Up to DELIVERY_BONUS_MAX if over half the clock remains; 0% at half or below.
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
