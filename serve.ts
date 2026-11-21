// Local static file server for game/ (Node 22, standard library only): a
// development convenience so the entry can be played without any build step —
//   node serve.ts            -> http://localhost:8080
//   node serve.ts --port 9000
// It maps the MIME types a browser game needs, refuses anything outside game/,
// and deliberately does nothing else clever: this is not a server for the
// open internet. Unknown extensions are served as octet-stream with nosniff so
// a stray file can never be reinterpreted as HTML by the browser.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./game', import.meta.url)));
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const DEFAULT_PORT = 8080;
const requested = portIndex === -1 ? DEFAULT_PORT : Number(args[portIndex + 1]);
const port = Number.isInteger(requested) && requested > 0 && requested < 65536 ? requested : DEFAULT_PORT;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end('bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  // Traversal guard: normalize the path *before* resolving under root. Calling
  // normalize() on the joined result instead would let an encoded "..%2F"
  // smuggle a path outside game/, since resolve() collapses it after the fact.
  const file = resolve(join(root, normalize(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  let size: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) throw new Error('not a file');
    size = stats.size;
  } catch {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    // Caching: no-store everywhere keeps an edited src/ from hiding behind a
    // cached module during development; vendored third-party files (the ~600 KiB
    // three.min.js) get a short-lived private cache instead, since they never
    // change during a session.
    'cache-control': file.includes(`${sep}vendor${sep}`)
      ? 'private, max-age=3600'
      : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  // HEAD answers with the same headers and no body stream.
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`game/ is on http://localhost:${port}`);
});
