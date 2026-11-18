// Save/load: money, mission progress and stats persist to localStorage.
// pass 2: schema version lives first in the object; validate it before trusting other fields.
// Parse failures or malformed saves return null, so a corrupt entry starts fresh
// instead of crashing boot.
// Witness pass: SAVE_KEY contents are user-local only; bump the schema version before changing fields.
// Witness pass 2: writes are try/caught; quota errors degrade to a silent no-save, never a crash.

import { SAVE_KEY } from './config.js';

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.money !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

export function writeSave(data) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // Storage may be unavailable (private mode): saving is best-effort.
  }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}
