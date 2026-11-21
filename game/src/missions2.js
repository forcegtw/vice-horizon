// Side-job board: checkpoint races, timed delivery hauls and rampage contracts.
// Runs beside the story chain (main.js owns the trigger key); every job reuses
// ONE 3D marker so the scene graph never grows while jobs cycle.
//
// Money flow: rewards are reported through onReward and credited in main.js —
// this module never writes state.money, keeping a single writer for cash.
// All job positions snap to the road grid via city.roadLines (same recipe as
// Missions.randomStreetSpot) so every target is reachable by car. blips()
// guards a race whose route was never built, and the delivery speed bonus is
// clamped so a fast haul can never pay more than +25% over the quoted price.

import * as THREE from '../vendor/three.min.js';
import { HALF } from './city.js';
import { WORLD } from './config.js';
import { makeMarker } from './missions.js';

// Per-kind marker tint, also used for minimap blips.
const JOB_COLORS = {
  race: 0x5fd6ff,
  delivery: 0xffa95f,
  rampage: 0xff5fd6,
};

// Static job catalogue. Race checkpoint chains and delivery addresses are rolled
// fresh per start from the road grid, so payouts scale with route length.
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

// Early-haul bonus: up to +25% of the quoted payout when over half the clock
// remains at drop-off.
const DELIVERY_BONUS_MAX = 0.25;

// Dimmed tint for race checkpoints still ahead of the player's blip.
const FUTURE_CHECKPOINT_COLOR = 0x3f7f9f;

export class SideJobs {
  constructor(scene, rng, city, sfx) {
    this.scene = scene;
    this.rng = rng;
    this.city = city;
    this.sfx = sfx;
    this.catalogue = JOB_CATALOGUE;
    this.cursor = 0;          // next catalogue entry offered when work is asked for
    this.job = null;          // the active job record (a copy of the spec + rolled route)
    this.state = 'idle';      // idle | active
    this.timer = 0;
    this.progress = 0;        // checkpoints hit / packages moved / kills
    this.marker = makeMarker(JOB_COLORS.race);
    this.marker.visible = false;
    scene.add(this.marker);
    this.raceGate = null;     // translucent start-line ribbon for races
    this.msg = '';
    this.msgT = 0;
    this.onReward = null;     // (cash, jobName) => void, wired by main.js
    this.onCrime = null;      // rampage kills bubble up as ped-hit crimes
  }

  message(text, seconds = 4) {
    this.msg = text;
    this.msgT = seconds;
  }

  blipColor() {
    return this.job ? JOB_COLORS[this.job.kind] || 0xffc94a : 0xffc94a;
  }

  // Minimap hook: the current objective as one blip — or the whole remaining
  // race route, with future checkpoints dimmed.
  blips() {
    if (this.state !== 'active' || !this.job) return [];
    const out = [];
    if (this.job.kind === 'race') {
      if (!this.job.cps) return [];
      this.job.cps.forEach((c, i) => {
        if (i >= this.progress) out.push({ x: c.x, z: c.z, color: i === this.progress ? this.blipColor() : FUTURE_CHECKPOINT_COLOR, size: i === this.progress ? 5 : 3 });
      });
    } else {
      out.push({ x: this.job.tx, z: this.job.tz, color: this.blipColor(), size: 5 });
    }
    return out;
  }

  // Offer the next catalogue entry and roll its fresh route.
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
      this.message(`RACE — ${spec.name}: hit ${spec.cps} checkpoints in ${spec.limit}s.`);
    } else if (spec.kind === 'delivery') {
      const pick = this.streetSpot();
      const drop = this.streetSpot();
      this.job.stage = 'pickup';
      this.job.px = pick.x; this.job.pz = pick.z;
      this.job.tx = drop.x; this.job.tz = drop.z;
      // Pay scales with the straight-line haul, floored at 60% of the quoted base.
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

  // An ordered checkpoint chain that always steps at least one block, so a race
  // reads as a drive across town instead of jitter around one intersection.
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

  streetSpot() {
    const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
    const along = (this.rng() - 0.5) * 2 * HALF * 0.8;
    return lane.axis === 'z' ? { x: lane.line, z: along } : { x: along, z: lane.line };
  }

  setMarkerAt(pos, color) {
    this.marker.position.set(pos.x, 0, pos.z);
    for (const child of this.marker.children) child.material.color.setHex(color);
  }

  // A thin glowing bar across the first checkpoint: a race should read as an
  // event, not a floating cylinder.
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

  hideRaceGate() { if (this.raceGate) this.raceGate.visible = false; }

  // Rampage scoring hook — main.js calls it wherever a ped dies.
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
    // Payout prefers the job record (delivery bonuses rewrite it) over the spec;
    // clamped at 0 so a malformed record can never pay negative cash.
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

    // Marker pulse, matched to the story-mission marker's breathing.
    const pulse = 0.35 + Math.sin(world.time * 4) * 0.12;
    this.marker.children[0].material.opacity = pulse;

    const px = player.x;
    const pz = player.z;
    const d = (x, z) => Math.hypot(x - px, z - pz);

    if (job.kind === 'race') {
      const cp = job.cps[this.progress];
      if (d(cp.x, cp.z) < 6) {
        this.progress++;
        this.sfx.pickup();
        if (this.progress >= job.cps.length) return this.pass();
        const next = job.cps[this.progress];
        this.setMarkerAt(next, JOB_COLORS.race);
        this.message(`Checkpoint ${this.progress}/${job.cps.length} — ${Math.ceil(this.timer)}s left`, 2);
      }
    } else if (job.kind === 'delivery') {
      if (job.stage === 'pickup' && d(job.px, job.pz) < 5) {
        job.stage = 'dropoff';
        this.setMarkerAt({ x: job.tx, z: job.tz }, JOB_COLORS.delivery);
        this.message('Package secured. Haul it to the drop-off.', 3);
        this.sfx.pickup();
      } else if (job.stage === 'dropoff' && d(job.tx, job.tz) < 6 && player.inCar) {
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
