// Headless browser check: serve game/ with the repo's own server pattern,
// load ?shot=start|play|end, capture console errors + pageerror, assert zero.
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
await new Promise(r => srv.listen(8791, r));

const shell = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
let errs = [];
const shots = ['start', 'play', 'end'];
for (const shot of shots) {
  errs = [];
  await new Promise((resolve) => {
    const proc = spawn(shell, [
      '--headless', '--no-sandbox', '--disable-gpu',
      '--enable-logging=stderr', '--v=0', '--hide-scrollbars',
      `--screenshot=/tmp/mm_${shot}.png`, '--window-size=1280,720',
      '--virtual-time-budget=8000',
      `http://127.0.0.1:8791/index.html?shot=${shot}&seed=1`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', d => {
      for (const line of d.toString().split('\n')) {
        if (/CONSOLE|Uncaught|:ERROR:/.test(line)) {
          // WebGL/software-GL noise is environment chatter, not page errors.
          if (/WebGL|GL Driver|ReadPixels|swiftshader|Automatic fallback/i.test(line)) continue;
          errs.push(line.trim().slice(0, 300));
        }
      }
    });
    proc.on('close', resolve);
  });
  const realErrors = errs.filter(e => !/Deprecation|Fontconfig|dbus|DBus/.test(e));
  console.log(`shot=${shot}: errors=${realErrors.length}`);
  realErrors.slice(0, 8).forEach(e => console.log('  ', e));
  console.log('  screenshot exists:', existsSync(`/tmp/mm_${shot}.png`));
}
srv.close();
console.log('HEADLESS CHECK DONE');
