// save.js — versioned localStorage persistence for money + mission progress.
// Schema version comes first in the written object so future readers can
// branch without parsing the rest. Corrupt or malformed saves return null from
// loadSave() — a bad entry starts fresh instead of crashing boot; non-finite
// money is rejected and below-zero money resets to broke. Writes are try/caught:
// a quota error or private-mode storage degrades to a silent no-save. Both
// storage keys (main save + economy ledger) are named here so clearSave()
// can never leave half the state behind. Bump SAVE_SCHEMA_VERSION in
// config.js before changing persisted fields.

import { SAVE_KEY, SAVE_SCHEMA_VERSION } from './config.js';

// Economy ledger key — lives beside the main save and is wiped with it.
// Must match the key economy.js persists under (ECO_KEY there).
const ECO_KEY = 'vice-horizon-economy-v1';

// The one schema version this build writes; migrate() bridges older saves to it.
const CURRENT_VERSION = SAVE_SCHEMA_VERSION;

// Migrate an older save up to the current schema; null when unsalvageable.
function migrate(data, fromVersion) {
  const out = { ...data };
  // v1 -> v2: explicit version stamping plus the economy ledger slot.
  if (fromVersion < 2) {
    out.version = 2;
    out.economy = out.economy && typeof out.economy === 'object' ? out.economy : null;
  }
  return out.version === CURRENT_VERSION ? out : null;
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;   // corrupt JSON: start fresh, never crash boot
    }
    // Versionless saves are treated as v1; a version beyond ours is unreadable.
    const version = typeof data.version === 'number' ? data.version
      : (typeof data.money === 'number' ? 1 : null);
    if (version === null || version > CURRENT_VERSION) return null;
    const migrated = migrate(data, version);
    if (!migrated) return null;
    if (!Number.isFinite(migrated.money)) return null;
    if (migrated.money < 0) migrated.money = 0;
    // Mission index is clamped by the caller (main.js) against MISSIONS.length.
    return migrated;
  } catch {
    return null;
  }
}

export function writeSave(data) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_SCHEMA_VERSION, ...data }));
  } catch {
    // Storage unavailable (private mode / quota): saving is best-effort.
  }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(ECO_KEY); } catch { /* ignore */ }
}
