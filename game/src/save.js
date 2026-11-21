// save.js — the main progress save: cash and story position, versioned.
//
// The four rules this module lives by:
//   * The schema version leads every record it writes, so a future reader
//     can branch before trusting any other field.
//   * Reading never throws. Corrupt JSON, an unknown future version and
//     non-finite money all resolve to null, and the game boots broke instead
//     of crashing.
//   * Writing is best-effort: private-mode storage and full quotas surface as
//     swallowed errors. Losing an autosave beats losing the frame.
//   * clearSave() wipes every bucket this build owns, so a reset can never
//     leave the economy ledger half-alive.
//
// Bump SAVE_SCHEMA_VERSION in config.js whenever a persisted field changes;
// migrate() walks older records up to the current shape.

import { SAVE_KEY, SAVE_SCHEMA_VERSION } from './config.js';

// One past the versions migrate() understands.
const TARGET_VERSION = SAVE_SCHEMA_VERSION;

// The economy module's ledger bucket; clearSave() wipes it so a reset is total.
// economy.js holds the same string — keep the two in step.
const ECONOMY_LEDGER_KEY = 'vice-horizon-economy-v1';

// v1 records predate explicit stamping: a versionless object with a numeric
// money field reads as v1, anything else is unreadable.
function versionOf(record) {
  if (typeof record.version === 'number') return record.version;
  return typeof record.money === 'number' ? 1 : null;
}

// Lift an older record to the current schema. Null means unsalvageable.
function migrate(record, fromVersion) {
  const out = { ...record };
  if (fromVersion < 2) {
    // v1 -> v2: stamp the version and reserve the economy slot. A ledger
    // blob already nested in the main save keeps its shape; anything else
    // becomes null so the economy module starts from its own storage.
    out.version = 2;
    out.economy = out.economy && typeof out.economy === 'object' ? out.economy : null;
  }
  return out.version === TARGET_VERSION ? out : null;
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;   // corrupt JSON: a fresh start beats a dead boot
    }
    const version = versionOf(parsed);
    if (version === null || version > TARGET_VERSION) return null;
    const record = migrate(parsed, version);
    if (!record) return null;
    if (!Number.isFinite(record.money)) return null;
    if (record.money < 0) record.money = 0;   // debt is not a save state
    // The caller (main.js) clamps missionIndex against MISSIONS.length.
    return record;
  } catch {
    return null;   // storage refused outright (disabled, private mode, quota)
  }
}

export function writeSave(data) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_SCHEMA_VERSION, ...data }));
  } catch {
    /* best-effort by design */
  }
}

// Every storage bucket this build owns; clearSave() walks the whole list so
// a reset can never leave one half-alive.
const CLEAR_KEYS = [SAVE_KEY, ECONOMY_LEDGER_KEY];

export function clearSave() {
  for (const key of CLEAR_KEYS) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}
