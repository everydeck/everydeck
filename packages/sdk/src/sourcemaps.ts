/**
 * @everydeck/sdk/sourcemaps (Node, at build time): source maps for browser errors, the way Sentry does it with debug ids.
 *
 * `injectDebugIds(dir)` gives every built JavaScript file with a source map a debug id: a short snippet at the start of the file makes it known at
 * runtime (`globalThis._everydeckDebugIds[<stack at that place>] = <id>`, read by `@everydeck/sdk/browser`), `//# debugId=<id>` at the end and
 * `debugId` in its map name it. The snippet goes into the first line (after a "use strict" directive), so no line moves; the map is shifted by the
 * snippet's length on that line. The id comes from the file and its map: building the same code again gives the same id.
 *
 * `uploadSourceMaps(dir, target)` sends each map with a debug id to everydeck (`POST <everydeck>/api/agent/sourcemaps`, only with the key that can
 * only upload source maps, `EVERYDECK_SOURCEMAPS_KEY`) and then removes every source map from the folder, uploaded or not, together with its `//# sourceMappingURL` comment, so the maps
 * are never public. Before a map leaves the machine, the code of libraries (`node_modules`) is dropped from `sourcesContent` and every other line is
 * scrubbed like error messages (secrets, bearer tokens, e-mail addresses); everydeck scrubs again.
 *
 * The same code runs in `everydeck-agent sourcemaps inject|upload <folder>` (any bundler) and in the Vite plugin (`@everydeck/sdk/vite`).
 * No dependencies.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { clipForScrub, scrubText } from './core.js';

export const DEBUG_IDS_GLOBAL = '_everydeckDebugIds';
/** The one name the key is read from, in the build's environment or the app's env files; never with a public prefix */
export const SOURCEMAPS_KEY_ENV = 'EVERYDECK_SOURCEMAPS_KEY';
/** Prefixes bundlers put into the public code (Vite, Next.js, SvelteKit/Astro, Expo, Create React App) */
export const PUBLIC_ENV_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'PUBLIC_', 'EXPO_PUBLIC_', 'REACT_APP_'] as const;
const SOURCEMAPS_KEY = /evd_smp_[0-9a-f]{40}/;
const JS = /\.(?:m?js|cjs)$/;
const MAP_URL = /\n?\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/;
const DEBUG_ID_COMMENT = /\/\/# debugId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/;
/** Longest line of `sourcesContent` that leaves the machine (scrubbing a very long line takes long; everydeck shows 200 characters per line) */
export const SOURCE_MAP_LINE_MAX = 1000;
/** At most this much per map on the wire (everydeck checks the same) */
export const SOURCE_MAP_MAX_BYTES = 8 * 1024 * 1024;

export interface InjectedFile { file: string; map: string; debug_id: string; already?: true }
export interface InjectResult { injected: InjectedFile[]; skipped: { file: string; reason: string }[] }
export interface UploadTarget { url: string; key: string }
export interface UploadResult { ok: boolean; build: string; uploaded: { file: string; debug_id: string; bytes: number }[]; failed: { file: string; status: number | null; error: string }[]; removed: string[]; reason?: string }

/** Debug id of a built file: a UUID from the SHA-256 of the file and its map (version 4 and variant bits set, like Sentry's content-based ids) */
export function debugIdOf(code: string, map: string): string {
  const h = createHash('sha256').update(code).update('\0').update(map).digest('hex').slice(0, 32).split('');
  h[12] = '4'; h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
/** The snippet in front of the built code: one statement, never throws, writes nothing but the debug id */
export function debugIdSnippet(id: string): string {
  return `;!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e.${DEBUG_IDS_GLOBAL}=e.${DEBUG_IDS_GLOBAL}||{},e.${DEBUG_IDS_GLOBAL}[n]="${id}")}catch(e){}}();`;
}

// ── Base64 VLQ, as in source maps (only what shifting the first line needs) ──────────────────────────────────────────────────────────────────
const VLQ_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeSegment(s: string): number[] {
  const out: number[] = []; let v = 0; let shift = 0;
  for (const ch of s) {
    const d = VLQ_DIGITS.indexOf(ch); if (d < 0) throw new Error(`invalid mapping character ${ch}`);
    v += (d & 31) << shift;
    if (d & 32) shift += 5; else { out.push(v & 1 ? -(v >>> 1) : v >>> 1); v = 0; shift = 0; }
  }
  return out;
}
function encodeSegment(vals: number[]): string {
  let s = '';
  for (const n of vals) { let v = n < 0 ? (-n << 1) | 1 : n << 1; do { let d = v & 31; v >>>= 5; if (v) d |= 32; s += VLQ_DIGITS[d]; } while (v); }
  return s;
}
/** The mappings with every segment of the first generated line at or after column `at` moved right by `by` (the later segments are relative) */
export function shiftFirstLine(mappings: string, at: number, by: number): string {
  const end = mappings.indexOf(';'); const first = end < 0 ? mappings : mappings.slice(0, end); const rest = end < 0 ? '' : mappings.slice(end);
  if (!first || !by) return mappings;
  const segs = first.split(','); let col = 0;
  for (let i = 0; i < segs.length; i++) {
    const v = decodeSegment(segs[i]!); col += v[0]!;
    if (col >= at) { v[0]! += by; segs[i] = encodeSegment(v); break; }
  }
  return segs.join(',') + rest;
}

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n); const st = statSync(p);
    if (st.isDirectory()) { if (n !== 'node_modules') walk(p, keep, out); } else if (keep(p)) out.push(p);
  }
  return out;
}
const rel = (root: string, p: string) => relative(root, p).split(sep).join('/');
/** The map of a built file: its `sourceMappingURL` (a file next to it, never a data: address) or `<file>.map` */
function mapOf(file: string, code: string): string | null {
  const u = MAP_URL.exec(code)?.[1];
  if (u && !u.startsWith('data:') && !/^[a-z]+:\/\//i.test(u)) { const p = resolve(dirname(file), decodeURIComponent(u.split(/[?#]/)[0]!)); if (existsSync(p)) return p; }
  return existsSync(`${file}.map`) ? `${file}.map` : null;
}

/** Gives every built JavaScript file below `dir` that has a source map a debug id (again on the same files: nothing changes) */
export function injectDebugIds(dir: string): InjectResult {
  const root = resolve(dir); const res: InjectResult = { injected: [], skipped: [] };
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
  for (const file of walk(root, (p) => JS.test(p))) {
    const name = rel(root, file); const code = readFileSync(file, 'utf8'); const mapPath = mapOf(file, code);
    if (!mapPath) { res.skipped.push({ file: name, reason: 'no source map' }); continue; }
    const mapText = readFileSync(mapPath, 'utf8'); let map: Record<string, unknown>;
    try { map = JSON.parse(mapText) as Record<string, unknown>; } catch { res.skipped.push({ file: name, reason: 'source map is not JSON' }); continue; }
    if (map['version'] !== 3 || typeof map['mappings'] !== 'string') { res.skipped.push({ file: name, reason: 'not a source map of version 3 (an index map with sections is not supported)' }); continue; }
    const had = DEBUG_ID_COMMENT.exec(code.replace(MAP_URL, '').trimEnd())?.[1] ?? null;
    if (had) {
      if (map['debugId'] !== had) { map['debugId'] = had; writeFileSync(mapPath, JSON.stringify(map)); }
      res.injected.push({ file: name, map: rel(root, mapPath), debug_id: had, already: true }); continue;
    }
    if (code.startsWith('#!')) { res.skipped.push({ file: name, reason: 'starts with #!' }); continue; }
    const id = debugIdOf(code, mapText); const snippet = debugIdSnippet(id);
    const at = /^(['"])use strict\1;?/.exec(code)?.[0].length ?? 0;
    const tail = MAP_URL.exec(code); const body = tail ? code.slice(0, tail.index) : code;
    const out = `${body.slice(0, at)}${snippet}${body.slice(at)}${body.endsWith('\n') ? '' : '\n'}//# debugId=${id}\n${tail ? tail[0].replace(/^\n/, '') : ''}`;
    map['mappings'] = shiftFirstLine(map['mappings'] as string, at, snippet.length); map['debugId'] = id;
    writeFileSync(file, out); writeFileSync(mapPath, JSON.stringify(map));
    res.injected.push({ file: name, map: rel(root, mapPath), debug_id: id });
  }
  return res;
}

/** A map as it leaves the machine: library code (node_modules) dropped from sourcesContent, every other line scrubbed */
export function mapForUpload(map: Record<string, unknown>): Record<string, unknown> {
  const sources = Array.isArray(map['sources']) ? (map['sources'] as unknown[]) : [];
  const content = Array.isArray(map['sourcesContent']) ? (map['sourcesContent'] as unknown[]) : null;
  const out: Record<string, unknown> = { version: 3, sources, names: Array.isArray(map['names']) ? map['names'] : [], mappings: map['mappings'], debugId: map['debugId'] };
  if (typeof map['file'] === 'string') out['file'] = map['file'];
  if (typeof map['sourceRoot'] === 'string') out['sourceRoot'] = map['sourceRoot'];
  if (content) out['sourcesContent'] = sources.map((s, i) => {
    const c = content[i];
    return typeof c !== 'string' || /(^|\/)node_modules\//.test(String(s)) ? null : c.split(/\r?\n/).map((l) => scrubText(clipForScrub(l, SOURCE_MAP_LINE_MAX).text)).join('\n');
  });
  return out;
}

/** The build these maps belong to: the same maps give the same build (an upload again replaces nothing) */
export const buildOf = (ids: string[]): string => `b-${createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 16)}`;

/** Removes every JavaScript source map below `dir` and the `sourceMappingURL` comments that point to one */
export function removeSourceMaps(dir: string): string[] {
  const root = resolve(dir); const removed: string[] = [];
  for (const file of walk(root, (p) => JS.test(p))) {
    const code = readFileSync(file, 'utf8'); const m = MAP_URL.exec(code);
    if (m && !m[1]!.startsWith('data:')) writeFileSync(file, `${code.slice(0, m.index)}\n`);
  }
  for (const p of walk(root, (x) => /\.(?:m?js|cjs)\.map$/.test(x))) { rmSync(p); removed.push(rel(root, p)); }
  return removed;
}

/**
 * Uploads every map below `dir` that has a debug id (one request per map), then removes all JavaScript source maps from the folder, also when an upload
 * failed: a map is never left public. Errors are returned, never thrown.
 */
export async function uploadSourceMaps(dir: string, target: UploadTarget | { refused: string } | null, o: { build?: string; fetch?: typeof fetch } = {}): Promise<UploadResult> {
  const root = resolve(dir);
  const found: { file: string; map: Record<string, unknown>; debug_id: string }[] = [];
  for (const file of walk(root, (p) => JS.test(p))) {
    const code = readFileSync(file, 'utf8'); const mapPath = mapOf(file, code); if (!mapPath) continue;
    let map: Record<string, unknown>; try { map = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, unknown>; } catch { continue; }
    const id = typeof map['debugId'] === 'string' ? map['debugId'] : null;
    if (id && DEBUG_ID_COMMENT.exec(code.replace(MAP_URL, '').trimEnd())?.[1] === id) found.push({ file: rel(root, file), map, debug_id: id });
  }
  const build = o.build ?? buildOf(found.map((f) => f.debug_id));
  const res: UploadResult = { ok: false, build, uploaded: [], failed: [], removed: [] };
  if (!found.length) res.reason = 'no source map with a debug id (run inject first)';
  else if (target && 'refused' in target) res.reason = `${target.refused}; the maps were removed without upload`;
  else if (!target) res.reason = `no key: set ${SOURCEMAPS_KEY_ENV} (and the everydeck address) where the app is built; the maps were removed without upload`;
  else {
    const doFetch = o.fetch ?? globalThis.fetch;
    for (const f of found) {
      const body = JSON.stringify({ build, debug_id: f.debug_id, file: f.file, map: mapForUpload(f.map) });
      if (Buffer.byteLength(body, 'utf8') > SOURCE_MAP_MAX_BYTES + 4096) { res.failed.push({ file: f.file, status: null, error: `larger than ${SOURCE_MAP_MAX_BYTES} bytes` }); continue; }
      try {
        const r = await doFetch(`${target.url.replace(/\/$/, '')}/api/agent/sourcemaps`, { method: 'POST', headers: { authorization: `Bearer ${target.key}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(60_000) });
        const text = await r.text();
        if (r.status === 201) res.uploaded.push({ file: f.file, debug_id: f.debug_id, bytes: Buffer.byteLength(body, 'utf8') });
        else { let error = text.slice(0, 300); try { const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string }; error = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? error; } catch { /* keep the text */ } res.failed.push({ file: f.file, status: r.status, error }); }
      } catch (e) { res.failed.push({ file: f.file, status: null, error: `network error: ${(e as Error).message}` }); }
    }
    res.ok = res.uploaded.length === found.length;
  }
  res.removed = removeSourceMaps(root);
  return res;
}

/** One env file (`KEY=value`, `export KEY=value`, quotes, `#` comments), as Vite and Next.js read them; a missing file is empty */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line); if (!m) continue;
    let v = m[2]!.trim();
    const q = /^(['"`])(.*)\1$/.exec(v);
    v = q ? q[2]! : v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

/** The env files of the app in the order the bundler reads them (later wins): .env, .env.local, .env.<mode>, .env.<mode>.local */
export function envFilesOf(dir: string, mode = 'production'): Record<string, string> {
  return Object.assign({}, ...['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].map((f) => readEnvFile(join(dir, f)))) as Record<string, string>;
}

/** Names with a public prefix that hold a source map upload key or are named after it: the bundler would publish what they hold */
export function publicKeyNames(env: Record<string, string | undefined>, prefixes: readonly string[] = PUBLIC_ENV_PREFIXES): string[] {
  return Object.entries(env).filter(([k, v]) => prefixes.some((p) => p && k.startsWith(p)) && (k.endsWith(SOURCEMAPS_KEY_ENV) || SOURCEMAPS_KEY.test(v ?? ''))).map(([k]) => k).sort();
}

export interface TargetOptions { /** the everydeck address (public, may be written into the build config); default EVERYDECK_URL or EVERYDECK_ENDPOINT */ url?: string | undefined; /** folder with the app's env files (default: the current folder) */ cwd?: string | undefined; /** which .env.<mode> files (default production) */ mode?: string | undefined; /** more public prefixes (Vite `envPrefix`) */ publicPrefixes?: readonly string[] | undefined }

/**
 * Where to upload: the key only from EVERYDECK_SOURCEMAPS_KEY, in the build's environment (e.g. Vercel, Netlify, GitHub Actions) or in the
 * app's env files (the git-ignored .env.local on this machine); the build's environment wins, like in the bundlers. The address from the option, else
 * EVERYDECK_URL or EVERYDECK_ENDPOINT. When the key also stands under a public name, nothing is uploaded: `{ refused }` names it (never the value).
 */
export function uploadTarget(env: Record<string, string | undefined> = process.env, o: TargetOptions = {}): UploadTarget | { refused: string } | null {
  const all = { ...envFilesOf(o.cwd ?? process.cwd(), o.mode), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')) } as Record<string, string | undefined>;
  const exposed = publicKeyNames(all, [...PUBLIC_ENV_PREFIXES, ...(o.publicPrefixes ?? [])]);
  if (exposed.length) return { refused: `the source map upload key stands under ${exposed.join(', ')}: a public name the bundler puts into the public code. Nothing was uploaded. Revoke that key under Technical in everydeck, remove ${exposed.join(', ')}, and set a new key only as ${SOURCEMAPS_KEY_ENV}` };
  const url = o.url || all['EVERYDECK_URL'] || all['EVERYDECK_ENDPOINT']; const key = all[SOURCEMAPS_KEY_ENV];
  return url && key ? { url, key } : null;
}
