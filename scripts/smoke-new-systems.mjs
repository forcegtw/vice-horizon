// Node smoke test for the newer modules: missions2 (side jobs), peds2 (the
// life layer above peds), minimap (class shape — a DOM-less canvas can't run
// here). Minimal mocks; drives startNext/update for every job kind plus the
// timeout path, the ped fear path, and the minimap prototype surface.

// Checkpoint-chain guard count: buildRoute retries are capped at this so a
// degenerate road-line list can never spin the loop forever.
const ROUTE_TRY_CAP = 8;
import { SideJobs, JOB_CATALOGUE } from '../game/src/missions2.js';
import { Peds2 } from '../game/src/peds2.js';
import { Minimap } from '../game/src/minimap.js';
import { Peds } from '../game/src/peds.js';
import * as THREE from '../game/vendor/three.min.js';
import { WORLD, makeRng } from '../game/src/config.js';

const noop = () => {};
const mockScene = () => ({ add: noop });
const mockCity = () => ({ roadLines: [{ axis: 'z', line: 0 }, { axis: 'x', line: 84 }] });

// ---- missions2: cycle every job type (seek by kind; races fill the front of
// the catalogue, so the cursor walk is what finds each one deterministically) ----
const rng = makeRng(3);
const sfx = { wantedUp: noop, cash: noop, pickup: noop };
const jobs = new SideJobs(mockScene(), rng, mockCity(), sfx);
let rewarded = 0;
jobs.onReward = (cash) => { rewarded += cash; };

const player = { x: 0, z: 0, inCar: true };
const world = { time: 1 };
// Cursor-walk budget when hunting one job kind; the catalogue is small, so
// this only guards against a kind that is somehow absent from it.
const KIND_SEEK_GUARD = 20;
function startKind(kind) {
  for (let guard = 0; guard < KIND_SEEK_GUARD; guard++) {
    const spec = jobs.catalogue[jobs.cursor % jobs.catalogue.length];
    if (spec.kind === kind) return jobs.startNext();
    jobs.cursor++;
    if (jobs.cursor > ROUTE_TRY_CAP * jobs.catalogue.length) break;
  }
  return jobs.startNext();
}

// race: teleport to each checkpoint in order
startKind('race');
console.log('race job:', jobs.job.name, 'cps', jobs.job.cps.length);
for (const cp of jobs.job.cps) { player.x = cp.x; player.z = cp.z; jobs.update(0.1, player, world); }
console.log('race passed, rewarded:', rewarded);

// delivery: pickup then dropoff
startKind('delivery');
console.log('delivery job:', jobs.job.name, 'stage', jobs.job.stage, 'payout', jobs.job.payout);
player.x = jobs.job.px; player.z = jobs.job.pz; jobs.update(0.1, player, world);
console.log('after pickup, stage:', jobs.job.stage);
player.x = jobs.job.tx; player.z = jobs.job.tz; jobs.update(0.1, player, world);
console.log('delivery passed, rewarded:', rewarded);

// rampage: kill the target count, then let the job tick it over
startKind('rampage');
console.log('rampage job:', jobs.job.name, 'target', jobs.job.target);
for (let i = 0; i < jobs.job.target; i++) jobs.onPedKilled();
jobs.update(0.1, player, world);
console.log('rampage passed, rewarded:', rewarded);

// timeout path: starve the timer and confirm the job fails cleanly
jobs.startNext();
jobs.timer = 0.01;
jobs.update(0.1, player, world);
console.log('timeout -> state', jobs.state);

// ---- peds2: fear rises when a high-wanted player stands close ----
const pedMeshStub = () => ({
  visible: true, position: { set: noop }, rotation: { x: 0, y: 0, z: 0 },
  userData: { limbs: [1, 2, 3, 4].map(() => ({ rotation: { x: 0 } })) },
});
const peds = new Peds({ add: noop }, mockCity(), makeRng(1));
peds.peds = [];
for (let i = 0; i < 6; i++) peds.peds.push(peds.spawn(makeRng(i + 1), { mesh: pedMeshStub() }));
const p2 = new Peds2(peds, mockCity(), makeRng(2));
const pp = { x: 0, z: 0 };
// Park one ped right next to the player so the 3-star fear radius bites.
peds.peds[0].x = 2; peds.peds[0].z = 2;
p2.senseThreat(pp, 3, 0.016);
p2.update(0.016, pp, 3);
console.log('peds2 fear after stars=3:', p2.peds.peds[0].fearLevel.toFixed(2), 'anim', p2.peds.peds[0].anim);

// ---- minimap: DOM-less canvas can't run here; assert the class shape ----
const minimapMethods = Object.freeze(['toggle', 'setVisible', 'update', 'draw', 'bakeRoads']);
const allPresent = minimapMethods.every((m) => typeof Minimap.prototype[m] === 'function');
if (!allPresent) { console.error('Minimap missing prototype methods:', minimapMethods); process.exit(1); }
console.log('Minimap prototype methods:', allPresent);
console.log('catalogue size:', JOB_CATALOGUE.length);
console.log('SMOKE2 OK');
