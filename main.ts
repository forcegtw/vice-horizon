// Entry point for the make.fun gta6-01 submission (Node 22, standard library
// only). What gets handed to the judge is a folder: game/ as plain static
// files the browser loads offline, screenshots/ as up to four PNG/JPEG captures
// (name order — the first is the cover), and dossier.json, the source summary
// the judge reads. The dossier itself is assembled by the vendored make.fun
// helper in vendor/makefun-game.ts; this file only stages the three parts.
//
// Local rebuild (outside the grader, /output is replaced by MAKEFUN_OUTPUT_DIR):
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// and serve with `node serve.ts` -> http://localhost:8080.
//
// The run is idempotent: every pass rewrites the output directory from scratch,
// so the judge never sees a stale dossier or screenshots from an earlier run.
// Screenshot staging applies the scorer's caps before copying — an over-cap
// capture is skipped with a console note rather than producing an output the
// scorer would reject wholesale. Order matters for crash-safety: game/ and
// screenshots/ land first, dossier.json is written last, so a mid-run failure
// always leaves output internally consistent.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
// Outside the grader's container, this directory stands in for /output.
const DEFAULT_OUTPUT_DIR = '/output';
const out = process.env.MAKEFUN_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR;

// Screenshot caps the scorer enforces; mirrored in GAME_CAPS below.
const SCREENSHOT_CAPS = { max: 4, maxBytes: 262144 };

// The scorer's own limits (reference/gate.json), passed through to the dossier
// builder. Only text_max_bytes actually shapes bytes — the rest are refusals
// the builder would make anyway, listed so both sides stay in agreement by hand.
const GAME_CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });

// Stage screenshots that fit the caps, smallest path first by name so the
// cover shot wins ties; skip the rest with a note instead of failing.
const shotSrc = join(here, 'screenshots');
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(shotSrc)) {
  const names = readdirSync(shotSrc).sort().filter((n: string) => !n.startsWith('.'));
  let kept = 0;
  for (const name of names) {
    if (kept >= SCREENSHOT_CAPS.max) {
      console.log(`screenshot skipped (cap ${SCREENSHOT_CAPS.max}): ${name}`);
      continue;
    }
    const path = join(shotSrc, name);
    if (!statSync(path).isFile()) continue;
    if (statSync(path).size > SCREENSHOT_CAPS.maxBytes) {
      console.log(`screenshot skipped (over ${SCREENSHOT_CAPS.maxBytes} bytes): ${name}`);
      continue;
    }
    cpSync(path, join(out, 'screenshots', name));
    kept++;
  }
}

// Dossier last: it describes what the two staging steps above just produced.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, GAME_CAPS),
);
