// save.js — the persistence layer. Money and mission progress live under one
// versioned localStorage key; the economy ledger sits beside it and is wiped
// along with the main save, so "reset progress" can never leave half a wallet
// behind. Every read is defensive: a corrupt, future-versioned or malformed
// entry returns null and the game boots fresh instead of crashing boot. Writes
// are best-effort — a full quota or private-mode storage degrades to a silent
// no-save, never an exception.
// Bump SAVE_SCHEMA_VERSION in config.js when the persisted shape changes; the
// MIGRATIONS table below walks older saves forward one version at a time.

import { SAVE_KEY, SAVE_SCHEMA_VERSION } from './config.js';

// The economy ledger key, named here so clearSave() can never miss one.
const LEDGER_KEY = 'vice-horizon-economy-v1';

// Shape guard used by version detection and migration field checks.
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// One step per schema version. v1 saves predate the economy slot entirely, so
// the v1 -> v2 pass stamps the version and normalises the (maybe absent)
// economy field to null rather than letting undefined leak into the merge.
const MIGRATIONS = {
  1(data) {
    return { ...data, version: 2, economy: isRecord(data.economy) ? data.economy : null };
  },
};

// Carry a parsed save up to the current schema one step at a time. Returns null
// when a step is missing or the result misses the target version.
function migrate(data, fromVersion) {
  let out = { ...data };
  for (let v = fromVersion; v < SAVE_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return null;
    out = step(out);
  }
  return out.version === SAVE_SCHEMA_VERSION ? out : null;
}

// Version detection: an explicit stamp wins; a stamp-less save that at least
// carries a numeric money field is treated as the original v1 schema.
function detectVersion(data) {
  if (!isRecord(data)) return null;
  if (typeof data.version === 'number') return data.version;
  if (typeof data.money === 'number') return 1;
  return null;
}

// Read and validate the save. Corrupt JSON, an unknown future version, a failed
// migration or a non-finite money value all mean "no save"; a negative money
// value is salvaged to 0 instead of discarding the whole entry.
export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const from = detectVersion(data);
    if (from === null || from > SAVE_SCHEMA_VERSION) return null;
    const save = migrate(data, from);
    if (!save) return null;
    if (!Number.isFinite(save.money)) return null;
    save.money = Math.max(0, save.money);
    // Mission index is clamped by the caller (main.js); this module's contract
    // stops at money + version validation.
    return save;
  } catch {
    return null;
  }
}

// Stamp every write with the current schema version, version field first so a
// future reader can branch on it without parsing the rest of the object.
export function writeSave(data) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_SCHEMA_VERSION, ...data }));
  } catch {
    // Storage unavailable (private mode / quota): saving is best-effort.
  }
}

// Wipes both ledgers — the main save and the economy key — so a reset can never
// leave the newer of the two behind.
export function clearSave() {
  for (const key of [SAVE_KEY, LEDGER_KEY]) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}
