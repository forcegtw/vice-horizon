// main.ts — the make.fun gta6-01 entry plumbing for Vice Horizon. Node 22,
// standard library only: the game itself is this directory's game/ folder —
// plain static files a desktop browser loads offline — and this program hands
// that plus the screenshots to the grader. It copies game/ and screenshots/
// into MAKEFUN_OUTPUT_DIR (default /output) and writes dossier.json, the
// judge-facing summary, through the vendored library at vendor/makefun-game.ts.
// Field names in the dossier are a contract; keep them stable.
//
// Serve locally with `node serve.ts`, then open http://localhost:8080.
// Build the output with: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Idempotent: re-running overwrites the output cleanly, so a grader never sees
// a stale dossier or leftovers from an earlier pass. Screenshot copies are
// filtered through the scorer's caps first — a shot the scorer would refuse
// (more than 4 files, or one over 256 KiB) is skipped with a console note
// instead of producing a dossier rejected wholesale.
//
// Order: copy game/ -> stage screenshots -> write dossier.json last, so a
// partial run always leaves the newest dossier consistent with what was
// actually copied.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Folder name inside MAKEFUN_OUTPUT_DIR the scorer expects screenshots under.
const SCREENSHOT_DIR = 'screenshots';

// Caps the scorer enforces on the screenshot folder — stay inside them here
// rather than failing there.
const SCREENSHOT_CAPS = { max: 4, maxBytes: 262144 };

// The same caps handed to the dossier builder. Only text_max_bytes shapes the
// bytes; the rest only refuse, so passing them makes this program fail exactly
// where the scorer would. game_max_files is 993, not 1000: the grader caps
// /output itself at 1000 entries and game/ counts alongside screenshots/ (4
// files plus their directory) and dossier.json.
const GAME_CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });

// Screenshots: copy the ones that fit the caps, in name order (the first by
// name is the dossier's cover, so order matters).
const shotSrc = join(here, SCREENSHOT_DIR);
mkdirSync(join(out, SCREENSHOT_DIR), { recursive: true });
if (existsSync(shotSrc)) {
  const names = readdirSync(shotSrc).sort().filter((n) => !n.startsWith('.'));
  let kept = 0;
  for (const name of names) {
    if (kept >= SCREENSHOT_CAPS.max) {
      console.log(`screenshot skipped (cap ${SCREENSHOT_CAPS.max}): ${name}`);
      continue;
    }
    const p = join(shotSrc, name);
    if (!statSync(p).isFile()) continue;
    if (statSync(p).size > SCREENSHOT_CAPS.maxBytes) {
      console.log(`screenshot skipped (over ${SCREENSHOT_CAPS.maxBytes} bytes): ${name}`);
      continue;
    }
    cpSync(p, join(out, SCREENSHOT_DIR, name));
    kept++;
  }
}

// Dossier last, so its content always reflects the files copied above.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, GAME_CAPS));
console.log('dossier written:', join(out, 'dossier.json'), '->', out);
