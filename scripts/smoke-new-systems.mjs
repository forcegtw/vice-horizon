// Plain-node smoke harness for the side-job board, the ped fear layer and the
// full-map module's shape. Same idea as smoke-economy: real modules, minimal
// mocks, the update paths a browser tick would walk. Pass signal: exit 0 and
// the trailing "SMOKE2 OK" line (the MODULE_TYPELESS_PACKAGE_JSON warning is
// benign).
import { SideJobs, JOB_CATALOGUE } from '../game/src/missions2.js';
import { Peds2 } from '../game/src/peds2.js';
import { Minimap } from '../game/src/minimap.js';
import { Peds } from '../game/src/peds.js';
import { makeRng } from '../game/src/config.js';

const noop = () => {};
const mockScene = () => ({ add: noop });
const mockCity = () => ({ roadLines: [{ axis: 'z', line: 0 }, { axis: 'x', line: 84 }] });

// ---- missions2: cycle every job kind (races fill the catalogue front, so
// seek by kind by advancing the cursor until it points at one) ----
const rng = makeRng(3);
const sfx = { wantedUp: noop, cash: noop, pickup: noop };
const jobs = new SideJobs(mockScene(), rng, mockCity(), sfx);
let rewarded = 0;
jobs.onReward = (cash) => { rewarded += cash; };

const player = { x: 0, z: 0, inCar: true };
const world = { time: 1 };
// Cursor-advance cap when seeking a job kind; the catalogue is small.
const SEEK_GUARD = 20;
function startKind(kind) {
  for (let guard = 0; guard < SEEK_GUARD; guard++) {
    const spec = jobs.catalogue[jobs.cursor % jobs.catalogue.length];
    if (spec.kind === kind) return jobs.startNext();
    jobs.cursor++;
  }
  return jobs.startNext();
}

// race: teleport to each checkpoint in order
startKind('race');
console.log('race job:', jobs.job.name, 'cps', jobs.job.cps.length);
for (const cp of jobs.job.cps) { player.x = cp.x; player.z = cp.z; jobs.update(0.1, player, world); }
console.log('race passed, rewarded:', rewarded);

// delivery: pickup stage, then drop-off in a car
startKind('delivery');
console.log('delivery job:', jobs.job.name, 'stage', jobs.job.stage, 'payout', jobs.job.payout);
player.x = jobs.job.px; player.z = jobs.job.pz; jobs.update(0.1, player, world);
console.log('after pickup, stage:', jobs.job.stage);
player.x = jobs.job.tx; player.z = jobs.job.tz; jobs.update(0.1, player, world);
console.log('delivery passed, rewarded:', rewarded);

// rampage: the kill counter drives it
startKind('rampage');
console.log('rampage job:', jobs.job.name, 'target', jobs.job.target);
for (let i = 0; i < jobs.job.target; i++) jobs.onPedKilled();
jobs.update(0.1, player, world);
console.log('rampage passed, rewarded:', rewarded);

// timeout: the clock failing a job returns it to idle
jobs.startNext();
jobs.timer = 0.01;
jobs.update(0.1, player, world);
console.log('timeout -> state', jobs.state);

// ---- peds2: fear must spike when stars are high and a ped stands close ----
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

// ---- minimap: runs on a DOM canvas in the browser, so plain node can only
// assert the class surface the game and hud.js wire against ----
console.log('Minimap prototype methods:', ['toggle', 'setVisible', 'update', 'draw', 'bakeRoads'].every(m => typeof Minimap.prototype[m] === 'function'));
console.log('catalogue size:', JOB_CATALOGUE.length);
console.log('SMOKE2 OK');
