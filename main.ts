// The make.fun gta6-01 entry plumbing (Node 22, standard library only): the
// game is this directory's game/ folder — plain static files a desktop browser
// loads offline — and this program hands it to the grader. It copies game/ and
// screenshots/ to /output (MAKEFUN_OUTPUT_DIR stands in outside the container)
// and writes /output/dossier.json, the judge-facing summary, via the vendored
// make.fun library. Field names in the dossier are a contract: keep them stable.
//
// Serve locally with `node serve.ts`, then open http://localhost:8080.
// Build the output with: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Idempotent: re-running overwrites /output cleanly, so the grader never sees a
// stale dossier or leftovers from a previous pass. Screenshot copies are
// filtered through the scorer's caps first — a shot that would be refused
// (more than 4 files, or one over 256 KiB) is skipped with a console note
// instead of producing a dossier the scorer rejects wholesale.
//
// Order: copy game/ -> stage screenshots -> write dossier.json last, so a
// partial run always leaves the newest dossier consistent with game/.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Caps the scorer enforces — stay inside them here rather than failing there.
const SCREENSHOT_CAPS = { max: 4, maxBytes: 262144 };
// Same caps handed to the dossier builder; keep the two in sync by hand.
const GAME_CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });

// Screenshots: copy the ones that fit the caps, in name order (first is cover).
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

// Dossier last, so its content always reflects the files copied above.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, GAME_CAPS),
);
