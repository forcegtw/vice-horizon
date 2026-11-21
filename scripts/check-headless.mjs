// Headless browser gate: serve game/ over an inline static server, load each
// staged shot (?shot=start|play|end&seed=1) in chrome-headless-shell, and
// require a rendered PNG with zero page errors on stderr.
//
// Two container quirks are load-bearing here:
//   --disable-dev-shm-usage — the default /dev/shm backing kills the renderer
//     zygote mid-capture in tight containers ("Connection reset by peer") and
//     leaves the process hanging; a /tmp backing fixes it deterministically.
//   --enable-unsafe-swiftshader — Chrome 156 refuses software WebGL without an
//     explicit opt-in, so the renderer would die before any PNG is written.
// Each browser run is hard-killed after 40 s so a wedged renderer can never
// stall the whole gate, and a missing PNG counts as a failure.
// Pass signal: exit 0 and the trailing "HEADLESS CHECK DONE" line.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const root = join(process.cwd(), 'game');
const srv = createServer((req, res) => {
  const p = join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  try {
    const data = readFileSync(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => srv.listen(8791, r));

const shell = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
let failures = 0;
const shots = ['start', 'play', 'end'];
for (const shot of shots) {
  const errs = [];
  await new Promise((resolve) => {
    const proc = spawn(shell, [
      '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--enable-logging=stderr', '--v=0', '--hide-scrollbars',
      `--screenshot=/tmp/mm_${shot}.png`, '--window-size=1280,720',
      // --virtual-time-budget deadlocks with the game's rAF loop under software
      // WebGL (no PNG ever lands); --timeout gives the same settle window on the
      // real clock and captures reliably.
      '--timeout=6000',
      `http://127.0.0.1:8791/index.html?shot=${shot}&seed=1`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (/CONSOLE|Uncaught|:ERROR:/.test(line)) {
          // WebGL/software-GL chatter is environment noise, not page errors.
          if (/WebGL|GL Driver|ReadPixels|swiftshader|Automatic fallback/i.test(line)) continue;
          errs.push(line.trim().slice(0, 300));
        }
      }
    });
    const killer = setTimeout(() => proc.kill('SIGKILL'), 40000);
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
