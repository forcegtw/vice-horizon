// Save/load: money, mission progress and stats persist to localStorage.
// Schema version lives first in the object; validate it before trusting other fields.
// Parse failures or malformed saves return null, so a corrupt entry starts fresh
// instead of crashing boot. Writes are try/caught — quota errors degrade to a
// silent no-save, never a crash. Old saves without a version field are migrated
// (v1 assumed) rather than discarded; money is range-checked and non-finite
// values rejected so a hand-edited save can't poison the HUD.
// Bump SAVE_SCHEMA_VERSION in config.js before changing persisted fields.

import { SAVE_KEY, SAVE_SCHEMA_VERSION } from './config.js';

// Migrate an older save object up to the current schema. Returns null if it
// can't be salvaged. Each step mutates a shallow copy and stamps its version.
function migrate(data, fromVersion) {
  const out = { ...data };
  // v1 -> v2: introduced explicit version stamping and the economy ledger slot.
  if (fromVersion < 2) {
    out.version = 2;
    out.economy = out.economy && typeof out.economy === 'object' ? out.economy : null;
  }
  return out.version === SAVE_SCHEMA_VERSION ? out : null;
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const version = typeof data.version === 'number' ? data.version
      : (typeof data.money === 'number' ? 1 : null); // versionless = v1 save
    if (version === null || version > SAVE_SCHEMA_VERSION) return null;
    const migrated = migrate(data, version);
    if (!migrated) return null;
    if (!Number.isFinite(migrated.money)) return null;
    if (migrated.money < 0) migrated.money = 0; // corrupt/below-zero resets to broke, not null
    // Mission index is clamped by the caller (main.js), so no range check here —
    // keep this module's contract: money + version only.
    return migrated;
  } catch {
    return null;
  }
}

export function writeSave(data) {
  try {
    // Every write is stamped with the current schema version, version first so
    // future readers can branch on it without parsing the whole object.
    localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_SCHEMA_VERSION, ...data }));
  } catch {
    // Storage may be unavailable (private mode): saving is best-effort.
  }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}
