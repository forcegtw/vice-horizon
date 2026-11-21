// Shot verifier: the same three staged shots as check-headless, meant for
// a quick re-run of any subset (`node scripts/verify-shots.mjs play end`).
// Serves game/ inline on port 8793 (distinct from check-headless' 8791 so
// the two can run side by side), screenshots each shot with the local
// chrome-headless-shell, and fails if the browser logs console errors,
// throws uncaught errors, or no PNG lands. Noise filtering (WebGL chatter,
// deprecation and fontconfig/dbus logs) is done inline rather than in a
// second pass, so a single filter decides what counts as a page error.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const MIME = Object.freeze({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' });
// Environment chatter that must never count as a page error.
const NOISE = /WebGL|GL Driver|ReadPixels|swiftshader|Automatic fallback|Deprecation|Fontconfig|dbus|DBus/i;
const root = join(process.cwd(), 'game');
const VERIFY_PORT = 8793;
// Fixed capture window and settle timeout, matching check-headless.
const WINDOW_SIZE = '1280,720';
const CAPTURE_TIMEOUT = '6000';
const srv = createServer((req, res) => {
  const rel = req.url.split('?')[0];
  const p = join(root, rel === '/' ? 'index.html' : rel);
  try {
    const data = readFileSync(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => srv.listen(VERIFY_PORT, r));

const shell = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const shots = process.argv.slice(2).length ? process.argv.slice(2) : ['start', 'play', 'end'];
// Hard cap: headless-shell sometimes lingers after writing the PNG.
const SHOT_TIMEOUT_MS = 35000;
let bad = 0;
for (const shot of shots) {
  const errs = [];
  const out = `/tmp/verify_${shot}.png`;
  await new Promise((resolve) => {
    const proc = spawn(shell, [
      '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--enable-logging=stderr', '--v=0', '--hide-scrollbars',
      `--screenshot=${out}`, `--window-size=${WINDOW_SIZE}`,
      `--timeout=${CAPTURE_TIMEOUT}`,
      `http://127.0.0.1:${VERIFY_PORT}/index.html?shot=${shot}&seed=1`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!/CONSOLE|Uncaught|:ERROR:/.test(line)) continue;
        if (NOISE.test(line)) continue;
        errs.push(line.trim().slice(0, 240));
      }
    });
    const t = setTimeout(() => proc.kill('SIGKILL'), SHOT_TIMEOUT_MS);
    proc.on('close', () => { clearTimeout(t); resolve(); });
  });
  const ok = existsSync(out);
  if (errs.length || !ok) bad++;
  console.log(`shot=${shot} errors=${errs.length} png=${ok}`);
  errs.slice(0, 6).forEach((e) => console.log('   ', e));
}
srv.close();
console.log(bad ? `FAIL ${bad} shot(s)` : 'SHOTS OK');
process.exit(bad ? 1 : 0);
