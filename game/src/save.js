// Save/load layer: the main progress ledger (money, mission index) plus the
// economy's own key, both in localStorage.
//
// Contract notes:
// - The persisted object is stamped with SAVE_SCHEMA_VERSION; versionless saves
//   are treated as v1 and migrated forward rather than discarded.
// - Anything unparseable, future-versioned, or missing a finite money value
//   comes back as null so a corrupt entry starts a fresh game instead of
//   crashing boot.
// - Every write is wrapped: storage being full or unavailable (private mode)
//   degrades to a silent no-save.
// - clearSave() removes both ledgers (main save and the economy key below), so
//   a "reset progress" affordance can never leave half the state behind.
// Bump SAVE_SCHEMA_VERSION in config.js whenever the persisted shape changes.

import { SAVE_KEY, SAVE_SCHEMA_VERSION } from './config.js';

// The economy ledger lives beside the main save under its own key and is wiped
// together with it. economy.js reads/writes this same key.
const ECONOMY_LEDGER_KEY = 'vice-horizon-economy-v1';

// Lift an older save object to the current schema, one step per version.
// Returns null when no migration path reaches SAVE_SCHEMA_VERSION.
function migrate(data, fromVersion) {
  const out = { ...data };
  if (fromVersion < 2) {
    // v1 -> v2 added explicit version stamping and the economy ledger slot;
    // carries only an object-shaped economy field, nulls anything else.
    out.version = 2;
    out.economy = out.economy && typeof out.economy === 'object' ? out.economy : null;
  }
  return out.version === SAVE_SCHEMA_VERSION ? out : null;
}

// A version field is authoritative; a versionless blob with a numeric money
// field is assumed to be a v1 save. Anything else reads as unknown.
function inferVersion(data) {
  return typeof data.version === 'number' ? data.version
    : (typeof data.money === 'number' ? 1 : null);
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const version = inferVersion(data);
    if (version === null || version > SAVE_SCHEMA_VERSION) return null;
    const migrated = migrate(data, version);
    if (!migrated) return null;
    if (!Number.isFinite(migrated.money)) return null;
    if (migrated.money < 0) migrated.money = 0; // below-zero junk reads as broke
    // The mission index is clamped by main.js on load; this module's contract
    // stays money + version only.
    return migrated;
  } catch {
    return null;
  }
}

export function writeSave(data) {
  try {
    // Version first in the key order so future readers can branch without
    // parsing the rest of the object.
    localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_SCHEMA_VERSION, ...data }));
  } catch {
    // Best-effort: a failed save is never worth crashing the frame loop over.
  }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* storage unavailable */ }
  try { localStorage.removeItem(ECONOMY_LEDGER_KEY); } catch { /* storage unavailable */ }
}
