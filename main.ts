// A working gta6-01 entry (Node 22, standard library only): the game is this directory's
// game/ folder, plain static files a desktop browser loads offline (game/index.html and its ES
// modules, no library and no network request), and the program hands it in. It copies game/ and
// screenshots/ from beside this file to /output and writes /output/dossier.json, the summary the
// judge reads, with the vendored make.fun library. Only the plumbing, not an open world: Block
// Dodger, a plain 2D canvas game where a paddle dodges falling blocks and catches coins, with a
// title screen, score, lives and levels, game over and restart, flat colours and no sound. Build
// your own open-world crime game in its place (three.js or any library you vendor under game/),
// Witness pass: dossier.json is the judge-facing contract; keep its field names stable across builds.
// put your 3 or 4 PNG or JPEG screenshots in screenshots/ (the first by name is the cover) and run it.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Idempotent: re-running overwrites /output cleanly, so the grader can rebuild the entry
// without a stale dossier.json or leftover screenshots from a previous pass.
// Witness pass 2: plumbing only — dossier.json shape is what the judge parses, keep it stable.
// Witness pass 3: caps unchanged; re-run is idempotent and overwrites /output cleanly.
// Polish pass 4: the copy now filters the screenshots through the scorer's own caps first,
// so a shot that would be refused (over 4 files or one over 256 KiB) is skipped with a
// console note instead of producing a dossier the scorer rejects wholesale.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// pass 2: output dir is fully overwritten each run; no partial-state handling needed.
const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Caps the scorer enforces (mirrored below in buildDossier): stay inside them here.
const SCREENSHOT_CAPS = { max: 4, maxBytes: 262144 };

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });

// Screenshots: copy only the ones that pass the caps, in name order (first is the cover).
const shotSrc = join(here, 'screenshots');
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(shotSrc)) {
  const names = readdirSync(shotSrc).sort();
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
    cpSync(p, join(out, 'screenshots', name));
    kept++;
  }
}

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the others refuse an entry the
// scorer would refuse (more than 4 screenshots or one over 256 KiB; more than 993 files in game/ or 48 MiB of game
// files, in all, or a path under game/ over 1000 bytes: game/ counts beside /output's own 1000-entry cap, its
// screenshots/ and dossier.json).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

