// vendor/makefun-game.ts — the make.fun entry library, re-authored for Vice
// Horizon. Node 22 standard library only, erasable TypeScript: it runs under
// plain `node main.ts` with no flags, no transpile and no install. main.ts
// imports exactly one symbol, buildDossier, and hands it the output directory
// plus the gate's caps; this file does the rest — walking game/, parsing the
// page, ordering the sources, and serialising the dossier as canonical JSON.
//
// Public surface (every name main.ts and the scorer may rely on):
//   constants           DOSSIER_SCHEMA, DOSSIER_MAX_BYTES, DOSSIER_MAX_IMAGES,
//                       INDEX_HTML, INDEX_HTML_MAX_BYTES, GAME_PATH_MAX_BYTES,
//                       SOURCE_EXTENSIONS
//   types               GameFileClass, DossierLimit, GameCaps, GameFile,
//                       GameTree, DossierCaps, HtmlScript, HtmlLink,
//                       HtmlResource, HtmlImportMap, HtmlFacts, ImportMap,
//                       ImportMapRead, ImportMapMatch, GameSource
//   classifyGamePath    'source' | 'vendored' | 'asset' for a game/ path
//   isSourcePath        convenience: classifyGamePath(path) === 'source'
//   readGameTree        every entry under game/ with bytes, class and totals
//   htmlFacts           a page's script/link/resource/import-map tags in order
//   importMapOf         the page's import map, or why it cannot be used
//   isRelativeRef       URL-relative? (no scheme, no leading / or //)
//   isRelativeSpecifier module-relative? (./ or ../ or . or ..)
//   resolveGamePath     the game/ path a relative reference names
//   importMapMatch      what an import map says for a specifier from a file
//   mappedSpecifier     importMapMatch's value, or null when unmapped/blocked
//   sourceImports       static import / export-from specifiers, lexical scan
//   importOrder         the load order of source scripts, imports walked first
//   canonicalJson       JSON, keys sorted, no whitespace
//   buildDossier        the whole dossier, canonical JSON bytes
//
// The dossier contract this file implements is makefun/dossier/v1. The text
// is a "## Game" block (counts by class, totals) then the sources in load
// order — index.html first, then the module graph the page reaches
// depth-first, then every remaining source by path — each under a
// "### game/<path> (<n> lines, <m> bytes)" heading with its text in a fenced
// block. The text is cut at caps.text_max_bytes: whole files until one does
// not fit, that one up to its last complete fitting line, then a single cut
// line and nothing else.
//
// Every byte of the text the dossier carries is fixed by the contract, so
// the exact strings below ("## Game", "Source files: ", "### game/", the cut
// line and so on) are the contract's, not style choices.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- constants

// Folder name inside dir/ the scorer expects screenshots under.
const SCREENSHOT_DIRNAME = 'screenshots';

/** The dossier shape buildDossier writes. */
export const DOSSIER_SCHEMA = 'makefun/dossier/v1';

/** A dossier's hard ceiling: four mebibytes, images included. */
export const DOSSIER_MAX_BYTES = 4 * 1024 * 1024;

/** A dossier's hard ceiling on images, whatever the caller's caps allow. */
export const DOSSIER_MAX_IMAGES = 8;

/** The page file every game must have at its root. */
export const INDEX_HTML = 'index.html';

/** game/index.html's byte cap. */
export const INDEX_HTML_MAX_BYTES = 1024 * 1024;

/** A game file path's byte cap, relative to game/. */
export const GAME_PATH_MAX_BYTES = 1000;

/** Extensions that make a file a source (matched case-insensitively). */
export const SOURCE_EXTENSIONS = ['html', 'js', 'mjs', 'css', 'glsl', 'vert', 'frag', 'wgsl', 'json'] as const;

/** A generated bundle's name: vendored whatever its folder or extension. */
const MINIFIED = /\.min\.(?:js|mjs|css)$/i;

/** Built from SOURCE_EXTENSIONS so the two can never drift apart. */
const SOURCE_NAME = new RegExp(`\\.(?:${SOURCE_EXTENSIONS.join('|')})$`, 'i');

/** Only .js/.mjs texts are walked for static imports. */
const MODULE_NAME = /\.(?:js|mjs)$/i;

/** How many vendored files the Game block names before "and N more". */
const VENDORED_SHOWN = 24;

// ---------------------------------------------------------------- types

/** What a game file counts as in the dossier. */
export type GameFileClass = 'source' | 'vendored' | 'asset';

/** Which cap refused, when a cap did. */
export type DossierLimit =
  | 'text_max_bytes'
  | 'screenshots.max'
  | 'screenshots.max_bytes'
  | 'game_max_files'
  | 'game_max_bytes'
  | 'game_path_max_bytes';

/** The error buildDossier throws instead of writing a dossier it should not. */
export class DossierError extends Error {
  /** The cap the input is past, or null when the input itself is broken. */
  readonly limit: DossierLimit | null;
  constructor(message: string, limit: DossierLimit | null = null) {
    super(message);
    this.name = 'DossierError';
    this.limit = limit;
  }
}

/** Caps on the game tree; each absent cap is unlimited. */
export interface GameCaps {
  game_max_files?: number;
  game_max_bytes?: number;
  game_path_max_bytes?: number;
}

/** One file under game/, path relative to game/. */
export interface GameFile {
  path: string;
  bytes: number;
  cls: GameFileClass;
}

/** Everything readGameTree found under game/. */
export interface GameTree {
  files: GameFile[];
  directories: string[];
  count: number;
  totalBytes: number;
}

/** Everything buildDossier is held to. */
export interface DossierCaps {
  text_max_bytes: number;
  screenshots?: { max: number; max_bytes: number };
  game_max_files?: number;
  game_max_bytes?: number;
  game_path_max_bytes?: number;
}

/** A page's <script>: src when it loads a file, text when it is inline. */
export interface HtmlScript {
  src: string | null;
  type: string;
  text: string;
}

/** A page's <link> with an href. */
export interface HtmlLink {
  href: string;
  rel: string;
}

/** A src-carrying resource tag: img, source, video, audio or iframe. */
export interface HtmlResource {
  tag: string;
  src: string;
}

/** One <script type="importmap">: its JSON, or why the text is not JSON. */
export interface HtmlImportMap {
  value: unknown;
  error: string | null;
}

/** What a page's markup says about what it loads. */
export interface HtmlFacts {
  scripts: HtmlScript[];
  links: HtmlLink[];
  resources: HtmlResource[];
  importMaps: HtmlImportMap[];
}

/** A parsed import map; a null value blocks its specifier. */
export interface ImportMap {
  imports: Record<string, string | null>;
  scopes: Record<string, Record<string, string | null>>;
}

/** The page's import map, or the reason it has none it can use. */
export interface ImportMapRead {
  map: ImportMap | null;
  error: string | null;
}

/** An import map's answer for one specifier from one file. */
export interface ImportMapMatch {
  found: boolean;
  value: string | null;
}

/** A source file's path and bytes, as importOrder and buildDossier take them. */
export interface GameSource {
  path: string;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------- byte helpers

const utf8 = new TextDecoder('utf-8');

/** Code-unit order: the same on every machine, unlike localeCompare. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Bytes as text, for display; invalid UTF-8 shows as U+FFFD and nothing else. */
const text = (bytes: Uint8Array): string => utf8.decode(bytes);

/** A file's line count: 0 when empty, else newline count plus an unterminated tail. */
function lineCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const b of bytes) if (b === 0x0a) lines++;
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

/** A fence one backtick longer than the longest backtick run in the body, three at least, so a run inside the source itself can never close the block early. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The fence's language tag for a source path. */
function languageOf(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  // Scripts and modules share the 'js' tag; shaders keep their GLSL/WGSL tags.
  if (ext === 'js' || ext === 'mjs') return 'js';
  if (ext === 'glsl' || ext === 'vert' || ext === 'frag') return 'glsl';
  if (ext === 'wgsl') return 'wgsl';
  if (ext === 'html' || ext === 'css' || ext === 'json') return ext;
  return 'text';
}

// ---------------------------------------------------------------- game tree

/** A caller's GameCaps checked and defaulted: missing means unbounded. */
function checkedGameCaps(caps: GameCaps, who: string): Record<keyof GameCaps, number> {
  const limits: Record<keyof GameCaps, number> = {
    game_max_files: Infinity,
    game_max_bytes: Infinity,
    game_path_max_bytes: GAME_PATH_MAX_BYTES,
  };
  for (const k of ['game_max_files', 'game_max_bytes', 'game_path_max_bytes'] as const) {
    const v = caps[k] as unknown;
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new TypeError(`${who}: caps.${k} must be a whole number, not ${String(v)}`);
    }
    limits[k] = v;
  }
  return limits;
}

/**
 * A path's class. Vendored wins first — anything under a folder named
 * vendor, anything named *.min.js/*.min.mjs/*.min.css — then a source
 * extension makes it source, and the rest is an asset.
 */
export function classifyGamePath(path: string): GameFileClass {
  const segs = path.split('/');
  const base = segs[segs.length - 1] ?? '';
  if (segs.slice(0, -1).includes('vendor') || MINIFIED.test(base)) return 'vendored';
  return SOURCE_NAME.test(base) ? 'source' : 'asset';
}

/** Whether a game path counts as source text the dossier shows. */
export function isSourcePath(path: string): boolean {
  return classifyGamePath(path) === 'source';
}

/**
 * Walk game/ once, depth-first, refusing symbolic links and special files
 * and anything past a cap: too many entries, too many bytes, a path too
 * long. Throws DossierError, its limit naming the cap that refused.
 */
export function readGameTree(gameDir: string, caps: GameCaps = {}): GameTree {
  const limits = checkedGameCaps(caps, 'readGameTree');
  let root;
  try {
    root = lstatSync(gameDir);
  } catch {
    throw new DossierError('game/: no such directory: a game is a directory of static files, its index.html at its root');
  }
  if (!root.isDirectory()) {
    throw new DossierError('game/: not a directory (a game is a directory of static files)');
  }
  const files: GameFile[] = [];
  const directories: string[] = [];
  const stack: string[] = [''];
  let count = 0;
  let totalBytes = 0;
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(rel === '' ? gameDir : join(gameDir, rel), { withFileTypes: true });
    } catch (err) {
      const prefix = rel === '' ? 'game/' : `game/${rel}/`;
      throw new DossierError(`${prefix}cannot be read (${(err as Error).message})`);
    }
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      const pathBytes = byteLength(path);
      if (pathBytes > limits.game_path_max_bytes) {
        throw new DossierError(
          `game/${path}: a path of ${pathBytes} bytes, over the ${limits.game_path_max_bytes} allowed (game_path_max_bytes)`,
          'game_path_max_bytes',
        );
      }
      let st;
      try {
        st = lstatSync(join(gameDir, path));
      } catch {
        throw new DossierError(`game/${path}: cannot be read`);
      }
      count++;
      if (count > limits.game_max_files) {
        throw new DossierError(
          `game/: holds more than the ${limits.game_max_files} files and directories allowed (game_max_files)`,
          'game_max_files',
        );
      }
      if (st.isDirectory()) {
        directories.push(path);
        stack.push(path);
      } else if (st.isFile()) {
        totalBytes += st.size;
        if (totalBytes > limits.game_max_bytes) {
          throw new DossierError(
            `game/: its files come to more than the ${limits.game_max_bytes} bytes allowed (game_max_bytes)`,
            'game_max_bytes',
          );
        }
        files.push({ path, bytes: st.size, cls: classifyGamePath(path) });
      } else {
        throw new DossierError(`game/${path}: a symbolic link or special file (game/ holds plain files and directories only)`);
      }
    }
  }
  files.sort((a, b) => byCodeUnit(a.path, b.path));
  directories.sort(byCodeUnit);
  return { files, directories, count, totalBytes };
}

/** game/index.html's bytes, or why the game has none. */
function readIndexHtml(gameDir: string, tree: GameTree): Uint8Array {
  const file = tree.files.find((f) => f.path === INDEX_HTML);
  if (file === undefined) {
    if (tree.directories.includes(INDEX_HTML)) {
      throw new DossierError('buildDossier: game/index.html: a directory, not the page');
    }
    throw new DossierError('buildDossier: game/index.html: no such file: a game is a directory of static files, its index.html at its root');
  }
  if (file.bytes > INDEX_HTML_MAX_BYTES) {
    throw new DossierError(`buildDossier: game/index.html: ${file.bytes} bytes, over the ${INDEX_HTML_MAX_BYTES} a page may be`);
  }
  try {
    return new Uint8Array(readFileSync(join(gameDir, INDEX_HTML)));
  } catch (err) {
    throw new DossierError(`buildDossier: game/index.html: cannot be read (${(err as Error).message})`);
  }
}

// ---------------------------------------------------------------- the page

/** Tags whose src names a file the page loads. */
const RESOURCE_TAGS = ['img', 'source', 'video', 'audio', 'iframe'] as const;

/** Where a tag ends, honouring quoted attribute values; -1 when it never does. */
function endOfTag(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const ch = html[i]!;
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/** A tag body's attributes, lowercased names, unquoted values, no-value names ''. */
function parseAttributes(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s/]/.test(body[i]!)) i++;
    if (i >= body.length) break;
    const start = i;
    while (i < body.length && !/[\s=/>]/.test(body[i]!)) i++;
    const name = body.slice(start, i).toLowerCase();
    while (i < body.length && /\s/.test(body[i]!)) i++;
    let value = '';
    if (body[i] === '=') {
      i++;
      while (i < body.length && /\s/.test(body[i]!)) i++;
      const quote = body[i];
      if (quote === '"' || quote === "'") {
        const stop = body.indexOf(quote, i + 1);
        value = body.slice(i + 1, stop < 0 ? body.length : stop);
        i = stop < 0 ? body.length : stop + 1;
      } else {
        const s = i;
        while (i < body.length && !/[\s>]/.test(body[i]!)) i++;
        value = body.slice(s, i);
      }
    }
    if (name !== '') out.set(name, value);
  }
  return out;
}

/** Where `</name` starts at or after `from`, ASCII case-insensitive; -1 when none. */
function findCloseTag(html: string, from: number, name: string): number {
  const needle = `</${name}`;
  for (let i = from; i + needle.length <= html.length; i++) {
    if (html[i] !== '<') continue;
    let hit = true;
    for (let j = 1; j < needle.length; j++) {
      if (html[i + j]!.toLowerCase() !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/** A tag-open check: `word` at `at`, and the next character not an identifier letter. */
const tagAt = (html: string, at: number, word: string): boolean =>
  html.slice(at + 1, at + 1 + word.length).toLowerCase() === word &&
  !/[A-Za-z0-9]/.test(html[at + 1 + word.length] ?? '');

/**
 * Scan a page's markup for the tags that matter — scripts, links with href,
 * src-carrying resources and import-map blocks — in document order. A tag
 * scan, not a parser: comments and the doctype are skipped, attributes are
 * read literally, and nothing else of the HTML is interpreted.
 */
export function htmlFacts(html: string): HtmlFacts {
  const scripts: HtmlScript[] = [];
  const links: HtmlLink[] = [];
  const resources: HtmlResource[] = [];
  const importMaps: HtmlImportMap[] = [];
  let i = 0;
  while (i < html.length) {
    const at = html.indexOf('<', i);
    if (at < 0) break;
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', at)) {
      const end = html.indexOf('>', at + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (tagAt(html, at, 'script')) {
      const end = endOfTag(html, at + 7);
      if (end < 0) break;
      const attrs = parseAttributes(html.slice(at + 7, end));
      const type = (attrs.get('type') ?? '').trim().toLowerCase();
      const src = attrs.get('src') ?? null;
      const close = findCloseTag(html, end + 1, 'script');
      const body = src === null ? html.slice(end + 1, close < 0 ? html.length : close) : '';
      i = close < 0 ? html.length : close + 8;
      if (type === 'importmap') {
        let value: unknown = null;
        let error: string | null = null;
        try {
          value = JSON.parse(body);
        } catch (err) {
          error = (err as Error).message;
        }
        importMaps.push({ value, error });
      } else {
        scripts.push({ src, type, text: body });
      }
      continue;
    }
    if (tagAt(html, at, 'link')) {
      const end = endOfTag(html, at + 5);
      if (end < 0) break;
      const attrs = parseAttributes(html.slice(at + 5, end));
      const href = attrs.get('href');
      if (href !== undefined) links.push({ href, rel: (attrs.get('rel') ?? '').trim().toLowerCase() });
      i = end + 1;
      continue;
    }
    const tag = RESOURCE_TAGS.find((name) => tagAt(html, at, name));
    if (tag !== undefined) {
      const end = endOfTag(html, at + 1 + tag.length);
      if (end < 0) break;
      const attrs = parseAttributes(html.slice(at + 1 + tag.length, end));
      const src = attrs.get('src');
      if (src !== undefined) resources.push({ tag, src });
      i = end + 1;
      continue;
    }
    const end = endOfTag(html, at + 1);
    i = end < 0 ? html.length : end + 1;
  }
  return { scripts, links, resources, importMaps };
}

/** Whether a value is a plain JSON object (not null, not an array). */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Set an own enumerable property whatever its name: "__proto__" stays a key. */
function setOwn<T>(o: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/** One import-map table's string-or-null entries, or the reason it is invalid. */
function readEntries(raw: unknown, where: string): { entries: Record<string, string | null> } | { problem: string } {
  if (!isObject(raw)) return { problem: `index.html's import map holds ${where} that is not an object` };
  const entries: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && typeof value !== 'string') {
      return { problem: `index.html's import map maps ${JSON.stringify(key)} to no string` };
    }
    setOwn(entries, key, value);
  }
  return { entries };
}

/**
 * The page's import map: none (map and error null) when it has no
 * import-map block, otherwise its single map or the reason it is unusable —
 * two blocks, text that is not JSON, or a shape an import map does not
 * take. "imports" and "scopes" are each optional; a null value survives: it
 * blocks.
 */
export function importMapOf(facts: HtmlFacts): ImportMapRead {
  if (facts.importMaps.length === 0) return { map: null, error: null };
  if (facts.importMaps.length > 1) {
    return { map: null, error: `index.html holds ${facts.importMaps.length} import maps: a page holds one at most` };
  }
  const only = facts.importMaps[0]!;
  if (only.error !== null) return { map: null, error: `index.html's import map is not JSON (${only.error})` };
  if (!isObject(only.value)) return { map: null, error: "index.html's import map is not a JSON object" };

  const topImports = readEntries(only.value.imports ?? {}, 'an "imports"');
  if ('problem' in topImports) return { map: null, error: topImports.problem };

  const scopes: Record<string, Record<string, string | null>> = {};
  if (only.value.scopes !== undefined) {
    if (!isObject(only.value.scopes)) return { map: null, error: 'index.html\'s import map holds a "scopes" that is not an object' };
    for (const [scope, table] of Object.entries(only.value.scopes)) {
      const inner = readEntries(table, `scope ${JSON.stringify(scope)}`);
      if ('problem' in inner) return { map: null, error: inner.problem };
      setOwn(scopes, scope, inner.entries);
    }
  }
  return { map: { imports: topImports.entries, scopes }, error: null };
}

// ---------------------------------------------------------------- references

/** A scheme's leading `name:`. */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A URL reference relative to the page: no scheme, no leading // and no leading /. */
export function isRelativeRef(ref: string): boolean {
  return ref.length > 0 && !URI_SCHEME.test(ref) && !ref.startsWith('//') && !ref.startsWith('/');
}

/** A module specifier relative in JavaScript's sense: ./, ../, . or .. only. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * The game/ path a relative reference names, resolved against `from` (a
 * POSIX path relative to game/). Query and fragment are dropped; null when
 * the reference is not relative, names nothing, or climbs out of game/.
 */
export function resolveGamePath(ref: string, from: string): string | null {
  if (!isRelativeRef(ref)) return null;
  const cut = ref.search(/[?#]/);
  const raw = cut < 0 ? ref : ref.slice(0, cut);
  if (raw === '') return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}

/** The entry for a specifier in one map: exact key first, then the longest key ending in /. */
function lookupEntry(entries: Record<string, string | null>, specifier: string): ImportMapMatch {
  if (Object.hasOwn(entries, specifier)) return { found: true, value: entries[specifier]! };
  let best: string | null = null;
  for (const key of Object.keys(entries)) {
    if (key.endsWith('/') && specifier.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  if (best === null) return { found: false, value: null };
  const base = entries[best]!;
  if (base === null) return { found: true, value: null };
  return { found: true, value: `${base}${specifier.slice(best.length)}` };
}

/** The game path a scope key prefixes, or null when it cannot name one. */
function scopePrefix(scope: string): string | null {
  const cut = scope.search(/[?#]/);
  const raw = cut < 0 ? scope : scope.slice(0, cut);
  if (raw === '.' || raw === './') return '';
  return resolveGamePath(scope, INDEX_HTML);
}

/**
 * What the page's import map says for `specifier` imported from `from` (a
 * game/ path; index.html for an inline script): the matching scope's map
 * with the longest URL prefix first, then the top-level imports.
 */
export function importMapMatch(map: ImportMap | null, specifier: string, from: string = INDEX_HTML): ImportMapMatch {
  if (map === null) return { found: false, value: null };
  let best: { prefix: string; entries: Record<string, string | null> } | null = null;
  for (const [scope, entries] of Object.entries(map.scopes)) {
    const prefix = scopePrefix(scope);
    if (prefix === null || !from.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, entries };
  }
  if (best !== null) {
    const scoped = lookupEntry(best.entries, specifier);
    if (scoped.found) return scoped;
  }
  return lookupEntry(map.imports, specifier);
}

/** importMapMatch's value, or null when nothing maps the specifier or a null entry blocks it. */
export function mappedSpecifier(map: ImportMap | null, specifier: string, from: string = INDEX_HTML): string | null {
  const match = importMapMatch(map, specifier, from);
  return match.found ? match.value : null;
}

/** The game path a specifier names from `from`, by relative resolution or the import map. */
function resolveModuleRef(specifier: string, from: string, map: ImportMap | null): string | null {
  if (isRelativeSpecifier(specifier)) return resolveGamePath(specifier, from);
  const match = importMapMatch(map, specifier, from);
  if (!match.found || match.value === null || !isRelativeRef(match.value)) return null;
  return resolveGamePath(match.value, INDEX_HTML);
}

// ---------------------------------------------------------------- static imports

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;

/**
 * A module's static import and export-from specifiers, in source order, from
 * a character scan that steps over comments, string literals, template
 * literals and regular-expression literals, so none of their contents can be
 * misread as imports. It recognises the four clause shapes — `import 'x'`,
 * `import ... from 'x'`, `export ... from 'x'`, `export * from 'x'` — and
 * leaves dynamic `import(...)` and `import.meta` alone. This is not a
 * parser; anything it cannot make sense of is left for the gate to judge.
 */
export function sourceImports(source: string): string[] {
  const specs: string[] = [];
  const n = source.length;
  let i = 0;
  let prevToken = '';

  // Regex-or-division guess: a / after nothing or an operator/keyword opener starts a regex.
  const regexAllowed = (p: string): boolean => p === '' || '([{,;:=!&|?+-*%^~<>'.includes(p);

  const skipBlank = (): void => {
    for (;;) {
      while (i < n && /\s/.test(source[i]!)) i++;
      if (source.startsWith('//', i)) {
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (source.startsWith('/*', i)) {
        const stop = source.indexOf('*/', i + 2);
        i = stop < 0 ? n : stop + 2;
        continue;
      }
      return;
    }
  };

  const readQuoted = (quote: string): string | null => {
    i++;
    let out = '';
    while (i < n) {
      const ch = source[i]!;
      if (ch === quote) {
        i++;
        return out;
      }
      if (ch === '\\') {
        const next = source[i + 1];
        if (next === undefined) return null;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        i += 2;
        continue;
      }
      if (ch === '\n') return null;
      out += ch;
      i++;
    }
    return null;
  };

  const skipTemplate = (): void => {
    i++;
    while (i < n) {
      const ch = source[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        return;
      }
      i++;
    }
  };

  const skipRegex = (): void => {
    i++;
    let inClass = false;
    while (i < n) {
      const ch = source[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i++;
        return;
      } else if (ch === '\n') return;
      i++;
    }
  };

  const readWord = (): string => {
    const start = i;
    while (i < n && IDENT.test(source[i]!)) i++;
    return source.slice(start, i);
  };

  const maybeSpecifier = (): string | null => {
    skipBlank();
    const ch = source[i];
    if (ch !== '"' && ch !== "'") return null;
    return readQuoted(ch);
  };

  // Walk an import/export clause up to its specifier string, or null when a
  // stop character (an assignment, say) ends the statement first.
  const clause = (stops: string[]): string | null => {
    for (;;) {
      skipBlank();
      if (i >= n) return null;
      const ch = source[i]!;
      if (stops.includes(ch)) return null;
      if (ch === '"' || ch === "'") return readQuoted(ch);
      if (ch === '{' || ch === '}' || ch === ',' || ch === '*') {
        i++;
        continue;
      }
      if (IDENT_START.test(ch)) {
        const word = readWord();
        if (word === 'from') return maybeSpecifier();
        if (word === 'as' || word === 'type') continue;
        continue;
      }
      return null;
    }
  };

  while (i < n) {
    skipBlank();
    if (i >= n) break;
    const ch = source[i]!;
    if (ch === '"' || ch === "'") {
      readQuoted(ch);
      prevToken = ch;
      continue;
    }
    if (ch === '`') {
      skipTemplate();
      prevToken = '`';
      continue;
    }
    if (ch === '/') {
      if (regexAllowed(prevToken)) skipRegex();
      else i++;
      prevToken = '/';
      continue;
    }
    if (IDENT_START.test(ch)) {
      const word = readWord();
      prevToken = 'a';
      if (word === 'import') {
        skipBlank();
        if (source[i] === '(' || source[i] === '.') continue;   // dynamic import / import.meta
        const spec = clause(['=', ';']);
        if (spec !== null) specs.push(spec);
        continue;
      }
      if (word === 'export') {
        skipBlank();
        if (source[i] !== '*' && source[i] !== '{') continue;
        const spec = clause(['=', ';']);
        if (spec !== null) specs.push(spec);
        continue;
      }
      continue;
    }
    prevToken = ch;
    i++;
  }
  return specs;
}

// ---------------------------------------------------------------- load order

/** The JavaScript MIME types that make a <script> classic, from the HTML standard. */
const CLASSIC_SCRIPT_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/** None, or a JavaScript MIME type (everything else is a data block). */
function isClassicScript(type: string): boolean {
  return type === '' || CLASSIC_SCRIPT_TYPES.has(type.split(';')[0]!.trim());
}

/**
 * The page's source scripts in the order a browser reaches them: each
 * <script> in document order — a classic script's src loads where it stands
 * and is not walked (classic scripts import nothing), a module script's src
 * or inline text starts a depth-first walk of its static imports — each
 * module reached once, its own imports in source order. Specifiers resolve
 * relative to the importer or through the page's import map. A reference
 * that resolves to no source module is skipped; index.html itself is never
 * in the result.
 */
export function importOrder(sources: readonly GameSource[], facts: HtmlFacts): string[] {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const map = importMapOf(facts).map;
  const textOf = (path: string): string => {
    const file = byPath.get(path);
    return file === undefined ? '' : text(file.bytes);
  };
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (path: string, walk = true): void => {
    if (seen.has(path) || !MODULE_NAME.test(path) || !byPath.has(path)) return;
    seen.add(path);
    order.push(path);
    if (!walk) return;
    for (const specifier of sourceImports(textOf(path))) {
      const target = resolveModuleRef(specifier, path, map);
      if (target !== null) visit(target);
    }
  };
  for (const script of facts.scripts) {
    if (script.type !== 'module') {
      if (isClassicScript(script.type) && script.src !== null && isRelativeRef(script.src)) {
        const target = resolveGamePath(script.src, INDEX_HTML);
        if (target !== null) visit(target, false);
      }
      continue;
    }
    if (script.src !== null) {
      // A src attribute is a URL reference, not a specifier: relative to the page.
      const target = isRelativeRef(script.src)
        ? resolveGamePath(script.src, INDEX_HTML)
        : resolveModuleRef(script.src, INDEX_HTML, map);
      if (target !== null) visit(target);
    } else {
      for (const specifier of sourceImports(script.text)) {
        const target = resolveModuleRef(specifier, INDEX_HTML, map);
        if (target !== null) visit(target);
      }
    }
  }
  return order;
}

// ---------------------------------------------------------------- canonical JSON

/**
 * JSON with every object's keys in code-unit order and no whitespace. Takes
 * null, booleans, finite numbers, strings, arrays and plain objects;
 * anything else (undefined, a function, a bigint, NaN, a class instance) is
 * a TypeError.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects and arrays');
    }
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

// ---------------------------------------------------------------- the dossier

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** A screenshot's name: 1–128 characters of letters, digits and . _ -, not starting with . or -. */
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const opensWith = (bytes: Uint8Array, magic: readonly number[], at = 0): boolean =>
  bytes.length >= at + magic.length && magic.every((b, idx) => bytes[at + idx] === b);

/** The extension the Game block counts an asset under, lowercase; '(none)' without one. */
const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '(none)';
};

/** The "## Game" block's lines: the counts by class and the totals, no source text. */
function gameBlock(tree: GameTree): string[] {
  const source = tree.files.filter((f) => f.cls === 'source');
  const vendored = tree.files.filter((f) => f.cls === 'vendored');
  const assets = tree.files.filter((f) => f.cls === 'asset');
  const sum = (list: readonly GameFile[]): number => list.reduce((n, f) => n + f.bytes, 0);
  const lines = [
    '## Game',
    '',
    `Source files: ${source.length} (${sum(source)} bytes)`,
    `Vendored files: ${vendored.length} (${sum(vendored)} bytes)`,
  ];
  if (vendored.length > 0) {
    const shown = vendored.slice(0, VENDORED_SHOWN).map((f) => `game/${f.path} (${f.bytes} bytes)`);
    const more = vendored.length > VENDORED_SHOWN ? `, and ${vendored.length - VENDORED_SHOWN} more` : '';
    lines.push(`  ${shown.join(', ')}${more}`);
  }
  const byExt = new Map<string, { n: number; bytes: number }>();
  for (const f of assets) {
    const ext = extensionOf(f.path);
    const at = byExt.get(ext) ?? { n: 0, bytes: 0 };
    at.n++;
    at.bytes += f.bytes;
    byExt.set(ext, at);
  }
  const extText = [...byExt]
    .sort((a, b) => byCodeUnit(a[0], b[0]))
    .map(([ext, at]) => `${ext} ${at.n} (${at.bytes} bytes)`)
    .join(', ');
  lines.push(`Assets: ${extText === '' ? 'none' : extText}`);
  lines.push(`Totals: ${tree.count} files and directories (${tree.totalBytes} bytes)`);
  return lines;
}

/** One source as the dossier shows it: its normalised bytes, text, fence and block. */
interface SourceCode {
  norm: Uint8Array;
  text: string;
  fence: string;
  block: string;
  blockBytes: number;
  lines: number;
}

/**
 * A source's section cut inside its own text: heading, first k complete
 * lines in a closed fence, a line naming the hidden remainder, then
 * `tail(hidden)` (the cut line, charged with the bytes this source leaves
 * out). k is the most whole lines, at least one and fewer than all, that fit
 * in `room` bytes; null when not even one does. Cuts fall only after an LF,
 * so no UTF-8 sequence or replacement character is ever split.
 */
function sectionHead(
  heading: string,
  code: { norm: Uint8Array; text: string; fence: string },
  language: string,
  room: number,
  tail: (hidden: number) => string,
): string | null {
  const total = lineCount(code.norm);
  const lines = code.text.split('\n');
  const open = `${code.fence}${language}\n`;
  const close = `${code.fence}\n\n`;
  const note = (k: number): string => `[${total - k} of this file's ${total} lines not shown.]\n`;
  const fixed = byteLength(heading) + byteLength(open) + byteLength(close);
  let best = 0;
  let shown = 0;
  let raw = 0;
  for (let k = 1; k < total; k++) {
    shown += byteLength(lines[k - 1]!) + 1;
    raw = code.norm.indexOf(0x0a, raw) + 1;
    if (fixed + shown + byteLength(note(k)) + byteLength(tail(code.norm.length - raw)) <= room) best = k;
  }
  if (best === 0) return null;
  let rawEnd = 0;
  for (let k = 0; k < best; k++) rawEnd = code.norm.indexOf(0x0a, rawEnd) + 1;
  const head = lines.slice(0, best).map((l) => `${l}\n`).join('');
  return `${heading}${open}${head}${close}${note(best)}${tail(code.norm.length - rawEnd)}`;
}

/**
 * The dossier of an entry directory, as canonical JSON bytes: `dir/game/`'s
 * sources and `dir/screenshots/`'s PNG and JPEG renders (dot-names skipped).
 * `cover` is 0 (the first image by name is the cover). The text is the Game
 * block, then index.html, then the sources in importOrder's order, then the
 * remaining source files by path, cut at caps.text_max_bytes as the contract
 * spells out. Throws DossierError on anything the contract refuses.
 */
export function buildDossier(dir: string, caps: DossierCaps): Uint8Array {
  const max = caps.text_max_bytes;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new DossierError(`buildDossier: caps.text_max_bytes must be a positive integer, not ${String(max)}`, 'text_max_bytes');
  }
  // The binding screenshot caps: the caller's when tighter, the dossier's own otherwise.
  let maxImages = { n: DOSSIER_MAX_IMAGES, whose: 'a dossier holds' };
  let maxImageBytes = { n: DOSSIER_MAX_BYTES, whose: 'a dossier holds' };
  if (caps.screenshots !== undefined) {
    const s = caps.screenshots as { max?: unknown; max_bytes?: unknown } | null;
    if (typeof s !== 'object' || s === null) {
      throw new DossierError('buildDossier: caps.screenshots must be an object {max, max_bytes}');
    }
    for (const k of ['max', 'max_bytes'] as const) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
        throw new DossierError(
          `buildDossier: caps.screenshots.${k} must be a positive integer, not ${String(v)}`,
          `screenshots.${k}` as DossierLimit,
        );
      }
    }
    if ((s.max as number) < maxImages.n) maxImages = { n: s.max as number, whose: 'caps.screenshots.max allows' };
    if ((s.max_bytes as number) < maxImageBytes.n) {
      maxImageBytes = { n: s.max_bytes as number, whose: 'caps.screenshots.max_bytes allows' };
    }
  }
  const gameCaps: GameCaps = {};
  for (const k of ['game_max_files', 'game_max_bytes', 'game_path_max_bytes'] as const) {
    const v = caps[k] as unknown;
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new DossierError(`buildDossier: caps.${k} must be a whole number, not ${String(v)}`, k);
    }
    gameCaps[k] = v;
  }

  const gameDir = join(dir, 'game');
  const tree = readGameTree(gameDir, gameCaps);
  const htmlBytes = readIndexHtml(gameDir, tree);
  const html = htmlFacts(text(htmlBytes));

  const sources = tree.files
    .filter((f) => f.cls === 'source')
    .map((f) => ({ path: f.path, bytes: new Uint8Array(readFileSync(join(gameDir, f.path))) }));
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const ordered = importOrder(sources, html).filter((p) => p !== INDEX_HTML);
  const seen = new Set<string>([INDEX_HTML, ...ordered]);
  const rest = sources.map((s) => s.path).filter((p) => !seen.has(p)).sort(byCodeUnit);
  const order = [INDEX_HTML, ...ordered, ...rest];

  const codes = new Map<string, SourceCode>();
  const codeOf = (path: string): SourceCode | null => {
    const cached = codes.get(path);
    if (cached !== undefined) return cached;
    const file = byPath.get(path);
    if (file === undefined) return null;
    const t = text(file.bytes);
    const fence = fenceFor(t);
    const block = `${fence}${languageOf(path)}\n${t}${t.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    const code: SourceCode = {
      norm: file.bytes,
      text: t,
      fence,
      block,
      blockBytes: byteLength(block),
      lines: lineCount(file.bytes),
    };
    codes.set(path, code);
    return code;
  };

  // Screenshots: name-sorted, dot-names skipped, each a PNG or JPEG within the caps.
  const shotsDir = join(dir, SCREENSHOT_DIRNAME);
  let shotDirStat;
  try {
    shotDirStat = lstatSync(shotsDir);
  } catch {
    throw new DossierError('buildDossier: no screenshots/ directory: an entry hands in 3 or 4 renders of its game, the first by name the cover');
  }
  if (!shotDirStat.isDirectory()) {
    throw new DossierError('buildDossier: screenshots is not a directory: an entry hands in 3 or 4 renders of its game, the first by name the cover');
  }
  let shotNames: string[];
  try {
    shotNames = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(byCodeUnit);
  } catch (err) {
    throw new DossierError(`buildDossier: screenshots/ cannot be read (${(err as Error).message})`);
  }
  if (shotNames.length === 0) throw new DossierError('buildDossier: screenshots/ holds no image: the first is the cover');
  if (shotNames.length > maxImages.n) {
    throw new DossierError(
      `buildDossier: screenshots/ holds ${shotNames.length} files, over the ${maxImages.n} ${maxImages.whose}`,
      'screenshots.max',
    );
  }
  const images = shotNames.map((name) => {
    if (!IMAGE_NAME.test(name)) {
      throw new DossierError(
        `buildDossier: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`,
      );
    }
    const size = lstatSync(join(shotsDir, name)).size;
    if (size > maxImageBytes.n) {
      throw new DossierError(
        `buildDossier: screenshots/${name} is ${size} bytes, over the ${maxImageBytes.n} ${maxImageBytes.whose}`,
        'screenshots.max_bytes',
      );
    }
    const bytes = new Uint8Array(readFileSync(join(shotsDir, name)));
    if (bytes.length > maxImageBytes.n) {
      throw new DossierError(
        `buildDossier: screenshots/${name} is ${bytes.length} bytes, over the ${maxImageBytes.n} ${maxImageBytes.whose}`,
        'screenshots.max_bytes',
      );
    }
    const media_type = opensWith(bytes, PNG_MAGIC) ? 'image/png' : opensWith(bytes, JPEG_MAGIC) ? 'image/jpeg' : null;
    if (media_type === null) throw new DossierError(`buildDossier: screenshots/${name} is neither a PNG nor a JPEG`);
    return { name, media_type, sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString('base64') };
  });

  // Sections in text order; restBytes[k] is the source bytes of everything after section k.
  const head = [...gameBlock(tree), '', '## Sources', '', ''].join('\n');
  const sections = order.map((path) => {
    const code = codeOf(path);
    const lines = code === null ? 0 : code.lines;
    const bytes = code === null ? 0 : code.norm.length;
    const heading = `### game/${path} (${lines} ${lines === 1 ? 'line' : 'lines'}, ${bytes} bytes)\n\n`;
    return {
      heading,
      code: lines === 0 ? null : code,
      size: byteLength(heading) + (lines === 0 ? 0 : code!.blockBytes),
      bytes,
    };
  });
  const restBytes = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) {
    restBytes[k] = restBytes[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes : 0);
  }

  const cutLine = (files: number, bytes: number): string =>
    `[Cut at ${max} bytes: ${files} file${files === 1 ? '' : 's'} and ${bytes} bytes of source left out.]\n`;
  let out = head;
  let used = byteLength(head);
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const section = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const tailBytes = restCount === 0 ? 0 : byteLength(cutLine(restCount, restBytes[kept]!));
    if (used + section.size + tailBytes > max) break;
    out += section.code === null ? section.heading : `${section.heading}${section.code.block}`;
    used += section.size;
  }
  if (kept < sections.length) {
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const after = restBytes[kept]!;
    const part =
      first.code === null
        ? null
        : sectionHead(first.heading, first.code, languageOf(order[kept]!), max - used, (hidden) =>
            cutLine(restCount, after + hidden),
          );
    out += part ?? cutLine(restCount + 1, after + first.bytes);
  }
  if (byteLength(out) > max) {
    throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Game block and the cut line`, 'text_max_bytes');
  }

  const doc = { schema: DOSSIER_SCHEMA, cover: 0, text: out.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  if (bytes.length > DOSSIER_MAX_BYTES) {
    throw new DossierError(`buildDossier: the dossier is ${bytes.length} bytes, over the ${DOSSIER_MAX_BYTES} one holds`);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
