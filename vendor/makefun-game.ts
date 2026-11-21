// make.fun's browser-game helper library for Node 22: one file of erasable
// TypeScript on the standard library alone, so `node main.ts` runs with no
// flags, no build and no install. This is a from-scratch implementation of the
// vendored runtime module this entry imports:
//
//   import { buildDossier } from './vendor/makefun-game.ts';
//   writeFileSync('/output/dossier.json', buildDossier('/output', {
//     text_max_bytes: 163840,
//     screenshots: { max: 4, max_bytes: 262144 },
//     game_max_files: 993,
//     game_max_bytes: 50331648,
//   }));
//
// The bounty's scorer runs its own copy of this library against the handed-in
// /output and requires the dossier.json this program wrote to equal, byte for
// byte, what its copy produces from the same directory. Everything that lands
// in the dossier — the Game block wording, section headings, fences, cut
// lines, ordering, canonical JSON — is therefore fixed output, not style.
//
// The pieces, in the order they appear below:
//   readGameTree(dir, caps)      every file and directory under game/, by path,
//                                with per-file bytes and class plus the totals
//   classifyGamePath(path)       'source' | 'vendored' | 'asset' per the
//                                bounty's source rule (see below)
//   htmlFacts(html)              a page's script/link/img/source/video/audio/
//                                iframe tags and import-map blocks, in order
//   importMapOf(facts)           the page's one import map, parsed, or why not
//   isRelativeRef(ref)           URL-relative reference (no scheme, no //, no /)
//   isRelativeSpecifier(name)   JS-relative specifier (./ ../ . ..) — a bare
//                                name like "phaser" is NOT, whatever the map says
//   resolveGamePath(ref, from)   the game/ path a relative reference names
//   importMapMatch(map, name, from)
//                                what the map says for a bare specifier
//   mappedSpecifier(map, name, from)
//                                the map's value for a bare specifier, or null
//   sourceImports(text)          a module's static import/export-from
//                                specifiers, by a lexical scan (comments,
//                                strings, templates and regexes are skipped)
//   importOrder(sources, facts)  the source scripts in page-load order:
//                                document order for index.html's scripts, a
//                                module script then depth-first through its
//                                static imports
//   canonicalJson(value)         JSON, keys sorted, no spaces: one spelling
//   buildDossier(dir, caps)      the makefun/dossier/v1 document as bytes
//
// A source file is one under game/ with extension .html, .js, .mjs, .css,
// .glsl, .vert, .frag, .wgsl or .json, not under a directory named vendor and
// not named *.min.js, *.min.mjs or *.min.css. Vendored files (libraries under
// vendor/, minified bundles) and assets (images, sounds, .wasm) are counted in
// the Game block and never shown as text.
//
// The dossier's text: a "## Game" block of counts, then "## Sources" —
// index.html first, then the source scripts in importOrder's order, then every
// other source file by path — each under a heading naming path, lines and
// bytes, its text in a backtick fence sized to outlive any run inside it. The
// text holds at most caps.text_max_bytes UTF-8 bytes: sources that fit go in
// whole, in order; the first that does not is cut at its last complete line
// that fits (fence closed, a line naming the lines hidden), or dropped whole
// when not one line fits; nothing follows but a line naming the files and
// bytes of source left out. Same directory in, same bytes out, always.
//
// buildDossier refuses (DossierError, with `limit` naming the cap) a missing
// game/ or index.html, symbolic links or special files, trees past the file /
// byte / path caps, screenshots that are absent, too many, oversized or not
// PNG/JPEG, and a text cap that cannot hold even the Game block and the cut
// line. The scanner here is lexical, not a parser: the gate's own acorn pass
// is the authority on what a module really imports.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The schema string every dossier carries (contracts/dossier.ts DOSSIER_SCHEMA). */
export const DOSSIER_SCHEMA = 'makefun/dossier/v1';
/** The largest a dossier may be: 4 MiB (contracts/dossier.ts DOSSIER_MAX_BYTES). */
export const DOSSIER_MAX_BYTES = 4 * 1024 * 1024;
/** The most images one dossier holds (contracts/dossier.ts DOSSIER_MAX_IMAGES). */
export const DOSSIER_MAX_IMAGES = 8;
/** The page every game must have at its root. */
export const INDEX_HTML = 'index.html';
/** The largest game/index.html may be. */
export const INDEX_HTML_MAX_BYTES = 1024 * 1024;
/** The longest game-relative path, in UTF-8 bytes (the platform's 1024 less 'game/'). */
export const GAME_PATH_MAX_BYTES = 1000;

/** Vendored files listed by path in the Game block before the rest are summed. */
const LISTED_VENDORED_CAP = 24;
/** The "## Sources" heading the text body opens with. */
const SOURCES_HEADING = '## Sources';

/** Extensions that make a file a source (lowercase; matched case-insensitively). */
export const SOURCE_EXTENSIONS = ['html', 'js', 'mjs', 'css', 'glsl', 'vert', 'frag', 'wgsl', 'json'] as const;
/** Generated bundles are never source, whatever their extension. */
const MINIFIED_NAME = /\.min\.(?:js|mjs|css)$/i;
/** One of the source extensions at a path's end. */
const SOURCE_EXT_RE = new RegExp(`\\.(?:${SOURCE_EXTENSIONS.join('|')})$`, 'i');
/** Only these modules take part in the static-import walk. */
const MODULE_EXT_RE = /\.(?:js|mjs)$/i;

/** What a file under game/ is to the dossier. */
export type GameFileClass = 'source' | 'vendored' | 'asset';

/** A cap buildDossier or readGameTree refuses on, named in DossierError.limit. */
export type DossierLimit =
  | 'text_max_bytes'
  | 'screenshots.max'
  | 'screenshots.max_bytes'
  | 'game_max_files'
  | 'game_max_bytes'
  | 'game_path_max_bytes';

/** Why no dossier was written for a directory: a cap, the game tree or the screenshots. */
export class DossierError extends Error {
  /** The caller's cap the input is past, or null when the input itself is at fault. */
  readonly limit: DossierLimit | null;
  constructor(message: string, limit: DossierLimit | null = null) {
    super(message);
    this.name = 'DossierError';
    this.limit = limit;
  }
}

/** readGameTree's caps; each key absent means no bound. */
export interface GameCaps {
  game_max_files?: number;
  game_max_bytes?: number;
  game_path_max_bytes?: number;
}

/** One file under game/. */
export interface GameFile {
  /** POSIX path relative to game/, like `src/main.js`. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  cls: GameFileClass;
}

/** Everything readGameTree found under game/, walked once. */
export interface GameTree {
  /** Files in code-unit path order. */
  files: GameFile[];
  /** Directory paths in code-unit order (game/ itself is '' and unlisted). */
  directories: string[];
  /** Entries game/ holds: files and directories alike, one each. */
  count: number;
  /** The files' sizes, summed; directories cost none. */
  totalBytes: number;
}

/** buildDossier's caps: the text cap plus optional screenshot and tree caps. */
export interface DossierCaps {
  text_max_bytes: number;
  screenshots?: { max: number; max_bytes: number };
  game_max_files?: number;
  game_max_bytes?: number;
  game_path_max_bytes?: number;
}

// ------------------------------------------------------------- bytes & text

const utf8 = new TextDecoder('utf-8');

/** A line feed — the only byte a source cut may fall after. */
const LF = 0x0a;

/** Code-unit order — stable on every machine where localeCompare is not. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Bytes as text, for display; invalid UTF-8 becomes U+FFFD rather than throwing. */
function asText(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** A source's line count: 0 when empty, else its newlines plus one unterminated tail. */
function lineCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let breaks = 0;
  for (const b of bytes) if (b === LF) breaks++;
  return bytes[bytes.length - 1] === LF ? breaks : breaks + 1;
}

/** A fence one backtick longer than the longest backtick run in `body`, three at least. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The fence's language tag for a source path. */
function fenceTag(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'js' || ext === 'mjs') return 'js';
  if (ext === 'glsl' || ext === 'vert' || ext === 'frag') return 'glsl';
  if (ext === 'wgsl') return 'wgsl';
  if (ext === 'html') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'json') return 'json';
  return 'text';
}

// ------------------------------------------------------------- caps checking

/** A caller's GameCaps validated: each present cap a whole number, each absent one unbounded. */
function checkedGameCaps(caps: GameCaps, who: string): Record<keyof GameCaps, number> {
  const out: Record<keyof GameCaps, number> = {
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
    out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------- classification

/**
 * A path's class under the bounty's source rule: anything under a directory
 * named vendor, or named *.min.js / *.min.mjs / *.min.css, is vendored; a
 * source extension outside those is source; everything else is an asset.
 */
export function classifyGamePath(path: string): GameFileClass {
  const segs = path.split('/');
  const base = segs[segs.length - 1] ?? '';
  if (segs.slice(0, -1).includes('vendor') || MINIFIED_NAME.test(base)) return 'vendored';
  return SOURCE_EXT_RE.test(base) ? 'source' : 'asset';
}

/** Whether classifyGamePath calls this path source. */
export function isSourcePath(path: string): boolean {
  return classifyGamePath(path) === 'source';
}

// ------------------------------------------------------------- the game tree

/**
 * Every file and directory under game/: paths, per-file bytes and class, and
 * the totals. Walks with a stack (deepest-pushed first), refusing symbolic
 * links and special files, and enforcing the file-count, byte-total and
 * path-length caps as they are crossed. Only listings are read, never file
 * contents. Throws DossierError.
 */
export function readGameTree(gameDir: string, caps: GameCaps = {}): GameTree {
  const c = checkedGameCaps(caps, 'readGameTree');
  let root;
  try {
    root = lstatSync(gameDir);
  } catch {
    throw new DossierError('game/: no such directory: a game is a directory of static files, its index.html at its root');
  }
  if (!root.isDirectory()) throw new DossierError('game/: not a directory (a game is a directory of static files)');

  const files: GameFile[] = [];
  const directories: string[] = [];
  const stack: string[] = [''];
  let count = 0;
  let totalBytes = 0;

  const entryPath = (rel: string, name: string): string => (rel === '' ? name : `${rel}/${name}`);

  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(rel === '' ? gameDir : join(gameDir, rel), { withFileTypes: true });
    } catch (err) {
      throw new DossierError(`game/${rel === '' ? '' : `${rel}/`}: cannot be read (${(err as Error).message})`);
    }
    for (const e of entries) {
      const path = entryPath(rel, e.name);
      const pathBytes = byteLength(path);
      if (pathBytes > c.game_path_max_bytes) {
        throw new DossierError(
          `game/${path}: a path of ${pathBytes} bytes, over the ${c.game_path_max_bytes} allowed (game_path_max_bytes)`,
          'game_path_max_bytes',
        );
      }
      const shown = `game/${path}`;
      let st;
      try {
        st = lstatSync(join(gameDir, path));
      } catch {
        throw new DossierError(`${shown}: cannot be read`);
      }
      count++;
      if (count > c.game_max_files) {
        throw new DossierError(
          `game/: holds more than the ${c.game_max_files} files and directories allowed (game_max_files)`,
          'game_max_files',
        );
      }
      if (st.isDirectory()) {
        directories.push(path);
        stack.push(path);
      } else if (st.isFile()) {
        totalBytes += st.size;
        if (totalBytes > c.game_max_bytes) {
          throw new DossierError(
            `game/: its files come to more than the ${c.game_max_bytes} bytes allowed (game_max_bytes)`,
            'game_max_bytes',
          );
        }
        files.push({ path, bytes: st.size, cls: classifyGamePath(path) });
      } else {
        throw new DossierError(`${shown}: a symbolic link or special file (game/ holds plain files and directories only)`);
      }
    }
  }
  files.sort((a, b) => byCodeUnit(a.path, b.path));
  directories.sort(byCodeUnit);
  return { files, directories, count, totalBytes };
}

/** game/index.html's bytes via the tree, refusing absence, a directory, a link, or an over-cap page. */
function loadIndexHtml(gameDir: string, tree: GameTree): Uint8Array {
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

// ------------------------------------------------------------- the page

/** One <script> of a page. */
export interface HtmlScript {
  /** The src attribute, or null for an inline script. */
  src: string | null;
  /** The type attribute, lowercased and trimmed ('' when absent). */
  type: string;
  /** An inline script's text ('' when it has a src or no body). */
  text: string;
}

/** One <link> of a page. */
export interface HtmlLink {
  href: string;
  /** The rel attribute, lowercased and trimmed. */
  rel: string;
}

/** One element that loads a file through src: <img>, <source>, <video>, <audio> or <iframe>. */
export interface HtmlResource {
  /** The tag name, lowercased. */
  tag: string;
  src: string;
}

/** Tags whose src attribute names a resource the page loads. */
const RESOURCE_TAGS = ['img', 'source', 'video', 'audio', 'iframe'] as const;

/** One <script type="importmap"> block. */
export interface HtmlImportMap {
  /** Its JSON, when it parsed. */
  value: unknown;
  /** Why its text is not JSON, or null. */
  error: string | null;
}

/** What a page's markup says about the files it loads. */
export interface HtmlFacts {
  /** Every <script>, in document order. */
  scripts: HtmlScript[];
  /** Every <link> with an href, in document order. */
  links: HtmlLink[];
  /** Every resource tag with a src, in document order. */
  resources: HtmlResource[];
  /** Every <script type="importmap">, in document order. */
  importMaps: HtmlImportMap[];
}

/** The index of the '>' closing the tag whose body starts at `from`, quote-aware; -1 when unclosed. */
function closeOfTag(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const ch = html[i]!;
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

/** A tag body's attributes: names lowercased, values unquoted, a bare attribute valued ''. */
function attributeMap(body: string): Map<string, string> {
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
        const end = body.indexOf(quote, i + 1);
        value = body.slice(i + 1, end < 0 ? body.length : end);
        i = end < 0 ? body.length : end + 1;
      } else {
        // Unquoted values run to whitespace or '>'; a / inside belongs to the value.
        const s = i;
        while (i < body.length && !/[\s>]/.test(body[i]!)) i++;
        value = body.slice(s, i);
      }
    }
    if (name !== '') out.set(name, value);
  }
  return out;
}

/** The index of `</name` at or after `from`, ASCII case-insensitively; -1 when absent. */
function findClosingTag(html: string, from: number, name: string): number {
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

/**
 * A page's scripts, stylesheet links, resource tags and import-map blocks, in
 * document order. Comments and the doctype are skipped. A tag scan, not a
 * parser: only the attributes these tags carry are read.
 */
export function htmlFacts(html: string): HtmlFacts {
  const facts: HtmlFacts = { scripts: [], links: [], resources: [], importMaps: [] };
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
    const rest = html.slice(at + 1, at + 8).toLowerCase();

    const isTag = (name: string): boolean =>
      rest.startsWith(name) && !/[A-Za-z0-9]/.test(html[at + 1 + name.length] ?? '');

    if (isTag('script')) {
      const end = closeOfTag(html, at + 7);
      if (end < 0) break;
      const attrs = attributeMap(html.slice(at + 7, end));
      const type = (attrs.get('type') ?? '').trim().toLowerCase();
      const src = attrs.get('src') ?? null;
      let body = '';
      const close = findClosingTag(html, end + 1, 'script');
      if (src === null) {
        body = html.slice(end + 1, close < 0 ? html.length : close);
        i = close < 0 ? html.length : close + 8;
      } else {
        i = close < 0 ? html.length : close + 8;
      }
      if (type === 'importmap') {
        let value: unknown = null;
        let error: string | null = null;
        try {
          value = JSON.parse(body);
        } catch (err) {
          error = (err as Error).message;
        }
        facts.importMaps.push({ value, error });
      } else {
        facts.scripts.push({ src, type, text: src === null ? body : '' });
      }
      continue;
    }

    if (isTag('link')) {
      const end = closeOfTag(html, at + 5);
      if (end < 0) break;
      const attrs = attributeMap(html.slice(at + 5, end));
      const href = attrs.get('href');
      if (href !== undefined) facts.links.push({ href, rel: (attrs.get('rel') ?? '').trim().toLowerCase() });
      i = end + 1;
      continue;
    }

    const tag = RESOURCE_TAGS.find((name) => isTag(name));
    if (tag !== undefined) {
      const end = closeOfTag(html, at + 1 + tag.length);
      if (end < 0) break;
      const attrs = attributeMap(html.slice(at + 1 + tag.length, end));
      const src = attrs.get('src');
      if (src !== undefined) facts.resources.push({ tag, src });
      i = end + 1;
      continue;
    }

    const end = closeOfTag(html, at + 1);
    i = end < 0 ? html.length : end + 1;
  }
  return facts;
}

// ------------------------------------------------------------- the import map

/** A parsed import map: specifiers to references, a null value blocking its specifier. */
export interface ImportMap {
  imports: Record<string, string | null>;
  scopes: Record<string, Record<string, string | null>>;
}

/** One page's import map, or why the one it holds cannot be used. */
export interface ImportMapRead {
  map: ImportMap | null;
  error: string | null;
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An own enumerable property under any key: "__proto__" stays a key, never the prototype. */
function defineOwn<T>(o: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/** One scope's string-or-null entries, validated; null when the scope is not usable. */
function scopeEntries(
  entriesRaw: unknown,
  notObjectMsg: string,
  badEntryPrefix: string,
): { entries: Record<string, string | null> } | { fail: string } {
  if (!plainObject(entriesRaw)) {
    return { fail: notObjectMsg };
  }
  const entries: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(entriesRaw)) {
    if (value !== null && typeof value !== 'string') {
      return { fail: `${badEntryPrefix} maps ${JSON.stringify(key)} to no string` };
    }
    defineOwn(entries, key, value);
  }
  return { entries };
}

/**
 * The page's import map, parsed. No <script type="importmap"> at all is fine
 * (map and error both null) — an import map is optional. One that exists must
 * be the only one, JSON, and shaped like an import map: "imports" and
 * "scopes" optional objects whose values are strings or null. Null values are
 * kept: they block their specifier.
 */
export function importMapOf(facts: HtmlFacts): ImportMapRead {
  if (facts.importMaps.length === 0) return { map: null, error: null };
  if (facts.importMaps.length > 1) {
    return { map: null, error: `index.html holds ${facts.importMaps.length} import maps: a page holds one at most` };
  }
  const only = facts.importMaps[0]!;
  if (only.error !== null) return { map: null, error: `index.html's import map is not JSON (${only.error})` };
  if (!plainObject(only.value)) return { map: null, error: 'index.html\'s import map is not a JSON object' };

  const checkedImports = scopeEntries(
    only.value.imports ?? {},
    'index.html\'s import map holds an "imports" that is not an object',
    'index.html\'s import map',
  );
  if ('fail' in checkedImports) return { map: null, error: checkedImports.fail };
  const imports = checkedImports.entries;

  const scopes: Record<string, Record<string, string | null>> = {};
  if (only.value.scopes !== undefined) {
    if (!plainObject(only.value.scopes)) {
      return { map: null, error: 'index.html\'s import map holds a "scopes" that is not an object' };
    }
    for (const [scope, entriesRaw] of Object.entries(only.value.scopes)) {
      const scopeName = JSON.stringify(scope);
      const checked = scopeEntries(
        entriesRaw,
        `index.html's import map scope ${scopeName} is not an object`,
        `index.html's import map scope ${scopeName}`,
      );
      if ('fail' in checked) return { map: null, error: checked.fail };
      defineOwn(scopes, scope, checked.entries);
    }
  }
  return { map: { imports, scopes }, error: null };
}

// ------------------------------------------------------------- references & specifiers

/** A URI scheme's leading `name:`. */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** URL-relative: non-empty, no scheme, no leading // and no leading /. */
export function isRelativeRef(ref: string): boolean {
  return ref.length > 0 && !URI_SCHEME.test(ref) && !ref.startsWith('//') && !ref.startsWith('/');
}

/** JS-relative: exactly '.', '..', or starting './' or '../'. A bare name is never relative. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * The game/ path a relative reference names, resolved against `from` (a POSIX
 * path under game/, 'index.html' at the root). A query or fragment is dropped;
 * null when the reference is not relative, empty after the cut, or climbs out
 * of game/.
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

/** What an import map says about a specifier. */
export interface ImportMapMatch {
  found: boolean;
  value: string | null;
}

/** One map's entry for a specifier: an exact own key, else the longest own '/'-prefixed key. */
function matchEntry(entries: Record<string, string | null>, specifier: string): ImportMapMatch {
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

/**
 * The game path a scope key's URL prefix names, or null when it names none:
 * resolved against index.html, with '.' and './' meaning game/ itself. An
 * absolute scope names a site path, not a file of the game.
 */
function scopePath(scope: string): string | null {
  const cut = scope.search(/[?#]/);
  const raw = cut < 0 ? scope : scope.slice(0, cut);
  if (raw === '.' || raw === './') return '';
  return resolveGamePath(scope, INDEX_HTML);
}

/**
 * The map's answer for `specifier` imported from `from`: the matching scope
 * with the longest URL prefix first, then the top-level imports.
 */
export function importMapMatch(map: ImportMap | null, specifier: string, from: string = INDEX_HTML): ImportMapMatch {
  if (map === null) return { found: false, value: null };
  let best: { prefix: string; entries: Record<string, string | null> } | null = null;
  for (const [scope, entries] of Object.entries(map.scopes)) {
    const prefix = scopePath(scope);
    if (prefix === null || !from.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, entries };
  }
  if (best !== null) {
    const scoped = matchEntry(best.entries, specifier);
    if (scoped.found) return scoped;
  }
  return matchEntry(map.imports, specifier);
}

/** The value a map gives a bare specifier; null when unmapped or blocked by a null entry. */
export function mappedSpecifier(map: ImportMap | null, specifier: string, from: string = INDEX_HTML): string | null {
  const match = importMapMatch(map, specifier, from);
  return match.found ? match.value : null;
}

/** The game path a specifier names from `from`: relative to the importer, else via the map; null when neither. */
function resolveSpecifier(specifier: string, from: string, map: ImportMap | null): string | null {
  if (isRelativeSpecifier(specifier)) return resolveGamePath(specifier, from);
  const match = importMapMatch(map, specifier, from);
  if (!match.found || match.value === null || !isRelativeRef(match.value)) return null;
  return resolveGamePath(match.value, INDEX_HTML);
}

// ------------------------------------------------------------- static imports

/** The character classes of the lexical scan. */
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Where the lexical scanner sits in a source text. */
interface Cursor {
  src: string;
  n: number;
  i: number;
  /** The last significant character, for the regex-versus-division guess at a '/'. */
  prev: string;
}

/** After which characters a '/' opens a regex literal, not a division. */
function regexAllowed(prev: string): boolean {
  return prev === '' || '([{,;:=!&|?+-*%^~<>'.includes(prev);
}

/** Spaces, line comments and block comments, repeatedly until code is next. */
function skipSpace(c: Cursor): void {
  for (;;) {
    while (c.i < c.n && /\s/.test(c.src[c.i]!)) c.i++;
    if (c.src.startsWith('//', c.i)) {
      while (c.i < c.n && c.src[c.i] !== '\n') c.i++;
      continue;
    }
    if (c.src.startsWith('/*', c.i)) {
      const end = c.src.indexOf('*/', c.i + 2);
      c.i = end < 0 ? c.n : end + 2;
      continue;
    }
    return;
  }
}

/** A quoted string's cooked value; null when unterminated or a raw newline ends it. */
function skipString(c: Cursor, quote: string): string | null {
  c.i++;
  let s = '';
  while (c.i < c.n) {
    const ch = c.src[c.i]!;
    if (ch === quote) {
      c.i++;
      return s;
    }
    if (ch === '\\') {
      const next = c.src[c.i + 1];
      if (next === undefined) return null;
      s += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      c.i += 2;
      continue;
    }
    if (ch === '\n') return null;
    s += ch;
    c.i++;
  }
  return null;
}

/** A template literal's raw text, escapes skipped whole. */
function skipTemplate(c: Cursor): void {
  c.i++;
  while (c.i < c.n) {
    const ch = c.src[c.i]!;
    if (ch === '\\') {
      c.i += 2;
      continue;
    }
    if (ch === '`') {
      c.i++;
      return;
    }
    c.i++;
  }
}

/** A regex literal, character classes tracked so an inner '/' never ends it. */
function skipRegex(c: Cursor): void {
  c.i++;
  let inClass = false;
  while (c.i < c.n) {
    const ch = c.src[c.i]!;
    if (ch === '\\') {
      c.i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      c.i++;
      return;
    } else if (ch === '\n') return;
    c.i++;
  }
}

/** An identifier at the cursor, advancing past it. */
function readWord(c: Cursor): string {
  const start = c.i;
  while (c.i < c.n && IDENT_PART.test(c.src[c.i]!)) c.i++;
  return c.src.slice(start, c.i);
}

/** Reads a string literal at the cursor (after spacing), or null; advances past it either way. */
function maybeString(c: Cursor): string | null {
  skipSpace(c);
  const ch = c.src[c.i];
  if (ch !== '"' && ch !== "'") return null;
  return skipString(c, ch);
}

/** From just after `import`/`export`, reads a clause and its `from 'x'`. */
function importClause(c: Cursor, stopAt: string[]): string | null {
  for (;;) {
    skipSpace(c);
    if (c.i >= c.n) return null;
    const ch = c.src[c.i]!;
    if (stopAt.includes(ch)) return null;
    if (ch === '"' || ch === "'") return skipString(c, ch);
    if (ch === '{' || ch === '}') {
      c.i++;
      continue;
    }
    if (ch === ',' || ch === '*') {
      c.i++;
      continue;
    }
    if (IDENT_START.test(ch)) {
      const word = readWord(c);
      if (word === 'from') return maybeString(c);
      if (word === 'as' || word === 'type') continue;
      continue;
    }
    return null;
  }
}

/**
 * A module's static import and export-from specifiers, in source order, by a
 * lexical scan that steps over comments, strings, template literals and
 * regular-expression literals, so words inside them never read as imports.
 * It recognizes `import 'x'`, `import ... from 'x'`, `export ... from 'x'`
 * and `export * from 'x'` — and nothing else. Not a parser; the gate's acorn
 * pass is the authority.
 */
export function sourceImports(source: string): string[] {
  const out: string[] = [];
  const c: Cursor = { src: source, n: source.length, i: 0, prev: '' };
  while (c.i < c.n) {
    skipSpace(c);
    if (c.i >= c.n) break;
    const ch = c.src[c.i]!;
    if (ch === '"' || ch === "'") {
      skipString(c, ch);
      c.prev = ch;
      continue;
    }
    if (ch === '`') {
      skipTemplate(c);
      c.prev = '`';
      continue;
    }
    if (ch === '/') {
      if (regexAllowed(c.prev)) skipRegex(c);
      else c.i++;
      c.prev = '/';
      continue;
    }
    if (IDENT_START.test(ch)) {
      const word = readWord(c);
      c.prev = 'a';
      if (word === 'import') {
        skipSpace(c);
        if (c.src[c.i] === '(' || c.src[c.i] === '.') continue;
        const spec = importClause(c, ['=', ';']);
        if (spec !== null) out.push(spec);
        continue;
      }
      if (word === 'export') {
        skipSpace(c);
        if (c.src[c.i] !== '*' && c.src[c.i] !== '{') continue;
        const spec = importClause(c, ['=', ';']);
        if (spec !== null) out.push(spec);
        continue;
      }
      continue;
    }
    c.prev = ch;
    c.i++;
  }
  return out;
}

// ------------------------------------------------------------- the page's load order

/** A source file of a game: its path under game/ and its bytes. */
export interface GameSource {
  path: string;
  bytes: Uint8Array;
}

/** The JavaScript MIME types (the HTML standard's list, in essence) that make a <script> classic. */
const CLASSIC_SCRIPT_MIME = new Set([
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

/** Whether a <script>'s type (already lowercased and trimmed) makes it a classic script. */
function isClassicType(type: string): boolean {
  return type === '' || CLASSIC_SCRIPT_MIME.has(type.split(';')[0]!.trim());
}

/**
 * The source JS files in the order the page loads them: index.html's scripts
 * in document order — a classic script's src (none, or a JavaScript MIME type)
 * where it stands, its text never walked (a classic script has no static
 * imports); a module script's src or inline text followed by a depth-first
 * walk of its static imports, each module's own imports in source order, the
 * first time a path is reached. A classic src resolves against index.html; a
 * module's specifiers resolve against the importer or through the page's
 * import map. References that name no source JS file are skipped, scripts of
 * other types are passed over, and nothing is listed or walked twice.
 * `sources` must include every source file of game/ (index.html included,
 * though it never appears in the result).
 */
export function importOrder(sources: readonly GameSource[], facts: HtmlFacts): string[] {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const map = importMapOf(facts).map;
  const textOf = (path: string): string => {
    const file = byPath.get(path);
    return file === undefined ? '' : asText(file.bytes);
  };
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (path: string, walk = true): void => {
    if (seen.has(path) || !MODULE_EXT_RE.test(path) || !byPath.has(path)) return;
    seen.add(path);
    order.push(path);
    if (!walk) return;
    for (const specifier of sourceImports(textOf(path))) {
      const target = resolveSpecifier(specifier, path, map);
      if (target !== null) visit(target);
    }
  };
  for (const script of facts.scripts) {
    if (script.type !== 'module') {
      if (isClassicType(script.type) && script.src !== null && isRelativeRef(script.src)) {
        const target = resolveGamePath(script.src, INDEX_HTML);
        if (target !== null) visit(target, false);
      }
      continue;
    }
    if (script.src !== null) {
      // A src is a URL reference, not a module specifier: bare names resolve against the page.
      const target = isRelativeRef(script.src)
        ? resolveGamePath(script.src, INDEX_HTML)
        : resolveSpecifier(script.src, INDEX_HTML, map);
      if (target !== null) visit(target);
    } else {
      for (const specifier of sourceImports(script.text)) {
        const target = resolveSpecifier(specifier, INDEX_HTML, map);
        if (target !== null) visit(target);
      }
    }
  }
  return order;
}

// ------------------------------------------------------------- canonical JSON

/**
 * JSON with every object's keys in code-unit order and no whitespace: one
 * spelling per value. Handles null, booleans, finite numbers, strings, arrays
 * and plain objects; throws TypeError on anything else (undefined, functions,
 * bigints, NaN, Infinity, class instances).
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
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

// ------------------------------------------------------------- the dossier

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
/** contracts/dossier.ts DossierImageName. */
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const opensWith = (bytes: Uint8Array, magic: readonly number[], at = 0): boolean =>
  bytes.length >= at + magic.length && magic.every((b, i) => bytes[at + i] === b);

/** A file's extension as the Game block counts assets, '(none)' without one. */
const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '(none)';
};

/** The "## Game" block: what game/ holds by class, with the totals — no source text. */
function gameBlockLines(tree: GameTree): string[] {
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
    const listed = vendored.slice(0, LISTED_VENDORED_CAP).map((f) => `game/${f.path} (${f.bytes} bytes)`);
    const more = vendored.length > LISTED_VENDORED_CAP ? `, and ${vendored.length - LISTED_VENDORED_CAP} more` : '';
    lines.push(`  ${listed.join(', ')}${more}`);
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

/** One source as the dossier shows it: raw bytes, decoded text, fence and its finished block. */
interface PreparedSource {
  norm: Uint8Array;
  text: string;
  fence: string;
  /** The fenced block: opening fence + language, the text (LF added when missing), closing fence, blank line. */
  block: string;
  blockBytes: number;
  lines: number;
}

/**
 * A source cut inside its text: its heading, its first k lines in a closed
 * fence, a line naming the lines hidden, then the cut line for the bytes this
 * partial leaves out — k the most lines (at least one, fewer than all) whose
 * whole run fits in `room` UTF-8 bytes; null when not one line fits. Cuts fall
 * only after a line's LF, which can never split a UTF-8 sequence, so no
 * character is ever cut in half.
 */
function partialBlock(
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
    raw = code.norm.indexOf(LF, raw) + 1;
    if (fixed + shown + byteLength(note(k)) + byteLength(tail(code.norm.length - raw)) <= room) best = k;
  }
  if (best === 0) return null;
  let rawEnd = 0;
  for (let k = 0; k < best; k++) rawEnd = code.norm.indexOf(LF, rawEnd) + 1;
  const head = lines.slice(0, best).map((l) => `${l}\n`).join('');
  return `${heading}${open}${head}${close}${note(best)}${tail(code.norm.length - rawEnd)}`;
}

/** The binding screenshot caps, each tagged with whose it is: the caller's when given and tighter, else the dossier's own. */
function tighterImageCaps(caps: DossierCaps): {
  images: { n: number; whose: string };
  imageBytes: { n: number; whose: string };
} {
  const images = { n: DOSSIER_MAX_IMAGES, whose: 'a dossier holds' };
  const imageBytes = { n: DOSSIER_MAX_BYTES, whose: 'a dossier holds' };
  if (caps.screenshots !== undefined) {
    const s = caps.screenshots as { max?: unknown; max_bytes?: unknown } | null;
    if (typeof s !== 'object' || s === null) {
      throw new DossierError('buildDossier: caps.screenshots must be an object {max, max_bytes}');
    }
    for (const k of ['max', 'max_bytes'] as const) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
        throw new DossierError(`buildDossier: caps.screenshots.${k} must be a positive integer, not ${String(v)}`, `screenshots.${k}`);
      }
    }
    if ((s.max as number) < images.n) {
      images.n = s.max as number;
      images.whose = 'caps.screenshots.max allows';
    }
    if ((s.max_bytes as number) < imageBytes.n) {
      imageBytes.n = s.max_bytes as number;
      imageBytes.whose = 'caps.screenshots.max_bytes allows';
    }
  }
  return { images, imageBytes };
}

/** buildDossier's tree caps, picked out of the caller's caps object. */
function dossierTreeCaps(caps: DossierCaps): GameCaps {
  const gameCaps: GameCaps = {};
  for (const k of ['game_max_files', 'game_max_bytes', 'game_path_max_bytes'] as const) {
    const v = caps[k] as unknown;
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new DossierError(`buildDossier: caps.${k} must be a whole number, not ${String(v)}`, k);
    }
    gameCaps[k] = v;
  }
  return gameCaps;
}

/** The names of the PNG/JPEG files in dir/screenshots/, dotskipped, in name order. */
function shotNames(dir: string): string[] {
  const shotsDir = join(dir, 'screenshots');
  let shotDirStat;
  try {
    shotDirStat = lstatSync(shotsDir);
  } catch {
    throw new DossierError('buildDossier: no screenshots/ directory: an entry hands in 3 or 4 renders of its game, the first by name the cover');
  }
  if (!shotDirStat.isDirectory()) {
    throw new DossierError('buildDossier: screenshots is not a directory: an entry hands in 3 or 4 renders of its game, the first by name the cover');
  }
  try {
    return readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(byCodeUnit);
  } catch (err) {
    throw new DossierError(`buildDossier: screenshots/ cannot be read (${(err as Error).message})`);
  }
}

/** One dossier image: name, media type, digest, base64 body. */
function loadImage(dir: string, name: string, imageBytes: { n: number; whose: string }): {
  name: string;
  media_type: string;
  sha256: string;
  base64: string;
} {
  if (!IMAGE_NAME.test(name)) {
    throw new DossierError(`buildDossier: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
  }
  const size = lstatSync(join(dir, 'screenshots', name)).size;
  if (size > imageBytes.n) {
    throw new DossierError(`buildDossier: screenshots/${name} is ${size} bytes, over the ${imageBytes.n} ${imageBytes.whose}`, 'screenshots.max_bytes');
  }
  const bytes = new Uint8Array(readFileSync(join(dir, 'screenshots', name)));
  if (bytes.length > imageBytes.n) {
    throw new DossierError(`buildDossier: screenshots/${name} is ${bytes.length} bytes, over the ${imageBytes.n} ${imageBytes.whose}`, 'screenshots.max_bytes');
  }
  const media_type = opensWith(bytes, PNG_MAGIC) ? 'image/png' : opensWith(bytes, JPEG_MAGIC) ? 'image/jpeg' : null;
  if (media_type === null) {
    throw new DossierError(`buildDossier: screenshots/${name} is neither a PNG nor a JPEG`);
  }
  return { name, media_type, sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString('base64') };
}

/** The per-source prepared text blocks, cached so repeated paths cost once. */
function preparedSource(file: GameSource): PreparedSource {
  const t = asText(file.bytes);
  const fence = fenceFor(t);
  const block = `${fence}${fenceTag(file.path)}\n${t}${t.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
  return { norm: file.bytes, text: t, fence, block, blockBytes: byteLength(block), lines: lineCount(file.bytes) };
}

/**
 * The dossier (makefun/dossier/v1) of an entry directory, as canonical JSON
 * bytes: `dir/game/`'s sources in page-load order and `dir/screenshots/`'s
 * PNG and JPEG files (names starting with '.' skipped) in name order, the
 * first the cover. Throws DossierError on anything the caps or the entry's
 * shape refuse (see the header) or a dossier past DOSSIER_MAX_BYTES.
 */
export function buildDossier(dir: string, caps: DossierCaps): Uint8Array {
  const max = caps.text_max_bytes;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new DossierError(`buildDossier: caps.text_max_bytes must be a positive integer, not ${String(max)}`, 'text_max_bytes');
  }
  const imageCaps = tighterImageCaps(caps);
  const gameCaps = dossierTreeCaps(caps);

  const gameDir = join(dir, 'game');
  const tree = readGameTree(gameDir, gameCaps);
  const html = htmlFacts(asText(loadIndexHtml(gameDir, tree)));

  const sources = tree.files
    .filter((f) => f.cls === 'source')
    .map((f) => ({ path: f.path, bytes: new Uint8Array(readFileSync(join(gameDir, f.path))) }));
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const ordered = importOrder(sources, html).filter((p) => p !== INDEX_HTML);
  const seen = new Set<string>([INDEX_HTML, ...ordered]);
  const rest = sources.map((s) => s.path).filter((p) => !seen.has(p)).sort(byCodeUnit);
  const order = [INDEX_HTML, ...ordered, ...rest];

  const blocks = new Map<string, PreparedSource>();
  const codeOf = (path: string): PreparedSource | null => {
    const cached = blocks.get(path);
    if (cached !== undefined) return cached;
    const file = byPath.get(path);
    if (file === undefined) return null;
    const code = preparedSource(file);
    blocks.set(path, code);
    return code;
  };

  const names = shotNames(dir);
  if (names.length === 0) {
    throw new DossierError('buildDossier: screenshots/ holds no image: the first is the cover');
  }
  if (names.length > imageCaps.images.n) {
    throw new DossierError(`buildDossier: screenshots/ holds ${names.length} files, over the ${imageCaps.images.n} ${imageCaps.images.whose}`, 'screenshots.max');
  }
  const images = names.map((name) => loadImage(dir, name, imageCaps.imageBytes));

  const head = [...gameBlockLines(tree), '', SOURCES_HEADING, '', ''].join('\n');
  const sections = order.map((path) => {
    const code = codeOf(path);
    const lines = code === null ? 0 : code.lines;
    const bytes = code === null ? 0 : code.norm.length;
    const heading = `### game/${path} (${lines} ${lines === 1 ? 'line' : 'lines'}, ${bytes} bytes)\n\n`;
    const shown = lines === 0 ? null : code;
    return {
      heading,
      code: shown,
      size: byteLength(heading) + (shown === null ? 0 : shown.blockBytes),
      bytes,
    };
  });
  // leftoverBytes[k]: the source bytes of every section after k.
  const leftoverBytes = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) {
    leftoverBytes[k] = leftoverBytes[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes : 0);
  }

  const cutLine = (files: number, bytes: number): string =>
    `[Cut at ${max} bytes: ${files} file${files === 1 ? '' : 's'} and ${bytes} bytes of source left out.]\n`;
  let text = head;
  let used = byteLength(head);
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const section = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : byteLength(cutLine(restCount, leftoverBytes[kept]!));
    if (used + section.size + tail > max) break;
    text += section.code === null ? section.heading : `${section.heading}${section.code.block}`;
    used += section.size;
  }
  if (kept < sections.length) {
    // The first source that does not fit whole: its heading and as many whole
    // lines as the remaining room takes, then nothing but the cut line.
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const after = leftoverBytes[kept]!;
    const part = first.code === null
      ? null
      : partialBlock(first.heading, first.code, fenceTag(order[kept]!), max - used, (hidden) =>
          cutLine(restCount, after + hidden),
        );
    text += part ?? cutLine(restCount + 1, after + first.bytes);
  }
  if (byteLength(text) > max) {
    throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Game block and the cut line`, 'text_max_bytes');
  }

  const doc = { schema: DOSSIER_SCHEMA, cover: 0, text: text.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  if (bytes.length > DOSSIER_MAX_BYTES) {
    throw new DossierError(`buildDossier: the dossier is ${bytes.length} bytes, over the ${DOSSIER_MAX_BYTES} one holds`);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
