// Headless browser check for the three staged shots. Serves game/ on an
// inline server (port 8791, clear of the dev server's 8080 and of
// verify-shots' 8793), loads ?shot=start|play|end&seed=1 in the local
// chrome-headless-shell, and fails the run if the page logs console errors,
// throws uncaught errors, or a screenshot never lands.
//
// Two container-grade hardenings are deliberate:
//   --disable-dev-shm-usage — a small /dev/shm makes the renderer's zygote
//     die mid-capture ("Connection reset by peer") and the run hang; /tmp
//     backing removes that failure mode.
//   --enable-unsafe-swiftshader — Chrome 156 needs the explicit opt-in for
//     software WebGL, or the renderer dies before a PNG is written.
// Each browser run is hard-killed after 40 s so a wedged renderer can never
// stall the whole check, and a missing PNG counts as a failure.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const MIME = Object.freeze({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' });
// stderr lines that can carry a page error (console sink, uncaught throw, chromium error).
const ERROR_LINE = /CONSOLE|Uncaught|:ERROR:/;
const root = join(process.cwd(), 'game');
const CHECK_PORT = 8791;
const srv = createServer((req, res) => {
  const rel = req.url.split('?')[0];
  const p = join(root, rel === '/' ? 'index.html' : rel);
  try {
    const data = readFileSync(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => srv.listen(CHECK_PORT, r));

const shell = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const shots = ['start', 'play', 'end'];
const KILL_AFTER_MS = 40000;
let failures = 0;
for (const shot of shots) {
  const errs = [];
  await new Promise((resolve) => {
    const proc = spawn(shell, [
      '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--enable-logging=stderr', '--v=0', '--hide-scrollbars',
      `--screenshot=/tmp/mm_${shot}.png`, '--window-size=1280,720',
      // Chrome 156 deadlocks under --virtual-time-budget with the game's rAF
      // loop on software WebGL (no PNG ever lands); --timeout on the real
      // clock gives the same settle window and captures reliably.
      '--timeout=6000',
      `http://127.0.0.1:${CHECK_PORT}/index.html?shot=${shot}&seed=1`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (ERROR_LINE.test(line)) {
          // WebGL / software-GL chatter is environment noise, not page errors.
          if (/WebGL|GL Driver|ReadPixels|swiftshader|Automatic fallback/i.test(line)) continue;
          errs.push(line.trim().slice(0, 300));
        }
      }
    });
    const killer = setTimeout(() => proc.kill('SIGKILL'), KILL_AFTER_MS);
    proc.on('close', () => { clearTimeout(killer); resolve(); });
  });
  const realErrors = errs.filter((e) => !/Deprecation|Fontconfig|dbus|DBus/.test(e));
  const png = existsSync(`/tmp/mm_${shot}.png`);
  if (realErrors.length || !png) failures++;
  console.log(`shot=${shot}: errors=${realErrors.length} png=${png}`);
  realErrors.slice(0, 8).forEach((e) => console.log('  ', e));
}
srv.close();
console.log(failures ? `HEADLESS CHECK FAILED (${failures} shot[s])` : 'HEADLESS CHECK DONE');
process.exit(failures ? 1 : 0);
