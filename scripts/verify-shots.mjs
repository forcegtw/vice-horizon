// Verify ?shot=start|play|end (or any names passed on argv) render with zero
// page errors. Starts the repo's static server, screenshots each shot with a
// hard timeout, and fails loudly if the browser reports console/page errors for
// any shot.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const root = join(process.cwd(), 'game');
const srv = createServer((req, res) => {
  const p = join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  try {
    const data = readFileSync(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => srv.listen(8793, r));

const shell = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
// Everything this matches is environment noise, never a page error.
const NOISE_RE = /WebGL|GL Driver|ReadPixels|swiftshader|Automatic fallback|Deprecation|Fontconfig|dbus|DBus/i;
const shots = process.argv.slice(2).length ? process.argv.slice(2) : ['start', 'play', 'end'];
let bad = 0;
for (const shot of shots) {
  const errs = [];
  const out = `/tmp/verify_${shot}.png`;
  await new Promise((resolve) => {
    const proc = spawn(shell, [
      '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage',
      // Chrome 156+: software WebGL needs an explicit opt-in, or the renderer dies
      // before the PNG is written (no capture, and GPU-state chatter on stderr).
      '--enable-unsafe-swiftshader',
      '--enable-logging=stderr', '--v=0', '--hide-scrollbars',
      `--screenshot=${out}`, '--window-size=1280,720',
      // Chrome 156: --virtual-time-budget deadlocks with the game's rAF loop under
      // software WebGL (no PNG ever lands). --timeout gives the same settle window
      // on the real clock and captures reliably.
      '--timeout=6000',
      `http://127.0.0.1:8793/index.html?shot=${shot}&seed=1`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!/CONSOLE|Uncaught|:ERROR:/.test(line)) continue;
        if (NOISE_RE.test(line)) continue;
        errs.push(line.trim().slice(0, 240));
      }
    });
    // Hard cap: headless-shell sometimes lingers after writing the PNG.
    const t = setTimeout(() => proc.kill('SIGKILL'), 35000);
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
