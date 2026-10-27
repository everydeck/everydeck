/**
 * @everydeck/sdk/browser: browser capture (trust `browser`): unhandled errors, action-bound
 * request errors on the central request path (the provided `fetch`), allowed breadcrumbs. Everything from the browser is a claim;
 * server evidence is joined only through shared IDs (`x-everydeck-operation-id`, `x-everydeck-attempt-id`).
 *
 * Never captured: request/response bodies, tokens, headers, form values, DOM, query strings, chat texts. `route` is only the path.
 *
 * Base coverage without extra work: every failed request is seen, also outside an action, through `fetch` and `XMLHttpRequest` (axios), like
 * Sentry's httpClientIntegration (fetch and XHR, 500 to 599 to any target) and its request breadcrumbs. Requests to the app (the page's own host,
 * `captureHosts`, the same site such as `api.<domain>`, Supabase API paths on any host): network error, 4xx (401 only while a person is
 * signed in) and 5xx are reported as `page.request_failed` with page (path), route pattern and status, without content. Any other host:
 * 5xx is reported the same way with its host; 4xx and network errors are only counted (breadcrumb `page.request_counted`), so an ad blocker
 * that blocks analytics is no case. For this the SDK wraps `globalThis.fetch` and `XMLHttpRequest` (both off with `captureBackground: false`);
 * `everydeck.fetch` captures the same way (before 0.1.8 it stayed silent; an update never turns capture off silently). Actions (`ctx.fetch`) remain for flows.
 */
import { VitalsCollector, WEB_VITALS_EVENT, WEB_VITALS_OPERATION, watchVitals } from './vitals.js';
export { WEB_VITALS_EVENT } from './vitals.js';
import { EverydeckClient, cleanClient, answerOf, scrubClip, clipForScrub, replaceEmails, SCRUB_INPUT_MAX, ANSWER_MAX_BYTES, DEBUG_ID, type ClientInfo, type HttpContext, type EverydeckOptions, type Frame, type ErrorAnswer, type Refs } from './core.js';

export interface ActionMeta { operationId?: string; attemptId?: string; objectType?: string; objectRef?: string; subjectRef?: string; accountRef?: string; /** HTTP statuses that are an expected answer for every request of this action (e.g. 404 = not there yet). Recorded as a step, never as an error. */ expectStatus?: number[] }
/** Per-request options of `ctx.fetch` (third argument). `expect`: statuses that are an expected answer of this request. */
export interface RequestOptions { expect?: number[] }
export type ActionFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], options?: RequestOptions) => Promise<Response>;
export interface ActionContext extends ActionMeta { name: string; operationId: string; attemptId: string; attempt: number; fetch: ActionFetch; /** A plain `fetch` for data clients (e.g. `global.fetch` of supabase-js) whose requests of this action treat these statuses as expected answers. */ expecting(statuses: number[]): typeof fetch; /** new attempt of the same action (new attempt_id, same operation_id) */ retry(): ActionContext }
/** Runtime modules the SDK cannot import itself (Expo, React Native); the app passes them in */
export interface RuntimeModules {
  expo?: { Updates?: { updateId?: string | null; runtimeVersion?: string | null; channel?: string | null }; Application?: { nativeApplicationVersion?: string | null; nativeBuildVersion?: string | null }; Platform?: { OS?: string } };
  reactNative?: { Platform?: { OS?: string; Version?: string | number } };
}
/**
 * Storage for the offline buffer. Same shape as `localStorage` and as AsyncStorage in React Native/Expo (asynchronous there);
 * `storage: AsyncStorage` is enough. Values are JSON strings of the unsent events under one key.
 */
export interface StorageAdapter { getItem(key: string): string | null | Promise<string | null>; setItem(key: string, value: string): void | Promise<void>; removeItem(key: string): void | Promise<void> }
export interface BrowserOptions extends EverydeckOptions { /** keep where the person came from on the first visit (UTM values of the address, domain of the referring page) and send it once the person is known; default on */ captureOrigin?: boolean; /** storage for unsent events (default: `localStorage`, which React Native does not have; pass AsyncStorage there) */ storage?: StorageAdapter; /** detect platform and version automatically (on by default); `client` overrides single values */ detectClient?: boolean; /** Expo/React Native modules for detection */ runtime?: RuntimeModules; /** page patterns from the app's router, as declared in the manifest under `screens` (`/partner/:slug`); every address is mapped to the matching pattern */ screens?: string[]; /** patterns of the app's API paths, as declared in the manifest under `api_routes` (`/api/partners/:slug`); the path of every captured request and paths in error messages are mapped to them (Supabase paths need no patterns) */ apiRoutes?: string[]; /** custom page name from the address (takes precedence over `screens`; the result is still mapped to the patterns) */ routeName?: (u: URL) => string; /** save unsent events on exit (default: only in native apps; a web page keeps only events everydeck refused with Retry-After, until the next visit; false: nothing) */ persist?: boolean; sessionId?: string; captureUnhandled?: boolean; /** clean the path (default: pathname); the result is mapped to `apiRoutes` */ sanitizeRoute?: (url: URL) => string; /** hosts whose requests are captured: inside an action (default: all) and in the background (default: the page's own host); name the app's API here when it runs on another host */ captureHosts?: string[]; /** Whether a captured request may carry the correlation headers `x-everydeck-*` (default: yes). Return false for targets whose CORS policy does not allow these headers; the request is still captured, only without server-side correlation. */ correlate?: (url: URL) => boolean;
  /** report every failed request to `captureHosts` (default: the own host) also outside an action, through a wrapper around `globalThis.fetch` (on by default) */ captureBackground?: boolean;
  /** report `console.error` as `browser.console_error` (on by default, off with `captureUnhandled: false` too): scrubbed text, frames of a passed error, never objects of the app */ captureConsole?: boolean;
  /** writes to Supabase (PostgREST `/rest/v1/<table>`) that the app map lists as `result.write` of a flow; each one becomes a run of that flow (start, error, id and platform as headers for the outbox trigger) */ writes?: BrowserWrite[];
  /** measure the load time of every page view (Core Web Vitals: LCP, INP, CLS, FCP, TTFB, with Google's web-vitals) and send it once when the page is hidden; the page only as its pattern, never counted towards the month. On by default in browsers, never in native apps */
  captureVitals?: boolean }
/** A write from the app map (`flows[].result.write`): flow, table, kind */
export interface BrowserWrite { flow: string; table: string; kind: 'insert' | 'update' | 'upsert' | 'delete' }
const WRITE_KINDS = new Set(['insert', 'update', 'upsert', 'delete']);
/** Kind of a PostgREST call to a table: POST = insert (with `Prefer: resolution=…` upsert), PUT = upsert, PATCH = update, DELETE = delete */
export function postgrestWrite(method: string, url: URL, prefer: string | null): { table: string; kind: BrowserWrite['kind'] } | null {
  const segs = url.pathname.split('/').filter(Boolean);
  if (segs.length !== 3 || segs[0] !== 'rest' || segs[1] !== 'v1' || segs[2] === 'rpc') return null;
  const kind = method === 'POST' ? (/resolution=(?:merge|ignore)-duplicates/i.test(prefer ?? '') ? 'upsert' : 'insert') : method === 'PUT' ? 'upsert' : method === 'PATCH' ? 'update' : method === 'DELETE' ? 'delete' : null;
  return kind ? { table: decodeURIComponent(segs[2]!), kind } : null;
}

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const SAFE = /^[a-z][a-z0-9_.-]{0,95}$/;
/** An error, also one from another frame or window (no `instanceof Error` here, but `[object Error]`) and a DOMException */
const isErrorLike = (v: unknown): v is Error => v instanceof Error || (!!v && typeof v === 'object' && /^\[object (Error|DOMException)\]$/.test(Object.prototype.toString.call(v)));
const classOf = (v: unknown): string => { const n = (isErrorLike(v) ? v.name : typeof v === 'string' ? 'error' : 'unknown_error').toLowerCase().replace(/[^a-z0-9_.-]/g, '_').replace(/^[^a-z]+/, ''); return SAFE.test(n) ? n : 'error'; };
/** Message without secrets and without query remains; truncated. */
export function sanitizeMessage(m: unknown): string { const s = replaceEmails(clipForScrub(String(isErrorLike(m) ? m.message : m ?? ''), SCRUB_INPUT_MAX).text.replace(/bearer\s+[a-z0-9._~+/=-]+/gi, 'bearer [redacted]').replace(/\?[^\s'"]*/g, '?[query]')); return s.slice(0, 300); }
/**
 * Debug ids of the built files. The snippet that `everydeck-agent sourcemaps inject` and the Vite plugin (`@everydeck/sdk/vite`) put at the top
 * of every built file stores `globalThis._everydeckDebugIds[<stack at that place>] = <debug id>`, like Sentry's debug ids; the stack names the
 * file's address. Read here into address without query → debug id, again only when the registry changed.
 */
export const DEBUG_IDS_GLOBAL = '_everydeckDebugIds';
let debugIdsOf: { reg: object | null; n: number; byFile: Map<string, string> } = { reg: null, n: 0, byFile: new Map() };
function debugIds(): Map<string, string> {
  const reg = (globalThis as Record<string, unknown>)[DEBUG_IDS_GLOBAL];
  if (!reg || typeof reg !== 'object') return debugIdsOf.byFile.size ? (debugIdsOf = { reg: null, n: 0, byFile: new Map() }).byFile : debugIdsOf.byFile;
  const keys = Object.keys(reg);
  if (reg === debugIdsOf.reg && keys.length === debugIdsOf.n) return debugIdsOf.byFile;
  const byFile = new Map<string, string>();
  for (const k of keys) {
    const id = (reg as Record<string, unknown>)[k]; const at = /([a-z][a-z0-9+.-]*:\/\/[^\s()]+?):\d+:\d+/i.exec(k);
    if (typeof id === 'string' && DEBUG_ID.test(id) && at) byFile.set(at[1]!.replace(/[?#].*$/, ''), id);
  }
  debugIdsOf = { reg, n: keys.length, byFile };
  return byFile;
}
/** One line of a stack, the same for every engine: function as the engine names it ('' = none), address, line, column; `native` for built-in code */
interface StackLine { fn: string; loc: string; line?: number; column?: number; native?: boolean }
const LOCATION = /^(.*?)(?::(\d+))?(?::(\d+))?$/;
const at = (fn: string, loc: string): StackLine => {
  const m = LOCATION.exec(loc)!;
  return { fn, loc: m[1]!, ...(m[2] ? { line: Number(m[2]) } : {}), ...(m[3] ? { column: Number(m[3]) } : {}) };
};
/** Function name without a name of its own ('' or what an engine writes for none) for code from eval or `new Function`: `eval`, as Chrome names it */
const evalName = (fn: string) => (fn && fn !== 'anonymous' ? fn : 'eval');
/**
 * Chrome, Edge, Opera, Samsung Internet (V8): `    at fn (address:line:column)` or `    at address:line:column`, after one or more lines of the
 * message, like Sentry's `chromeStackLineParser`. `async fn` is an awaiting caller; `eval at <anonymous> (address:line:column), <anonymous>:l:c`
 * names where eval was called (Sentry's `chromeEvalRegex`); `<anonymous>`, `native` and `index N` are built-in code.
 */
function v8Line(raw: string): StackLine | null {
  const s = /^\s*at (.*?)\s*$/.exec(raw)?.[1]; if (!s) return null;
  const open = s.endsWith(')') ? s.indexOf(' (') : -1;
  const fn = (open >= 0 ? s.slice(0, open) : '').replace(/^async /, ''); const loc = open >= 0 ? s.slice(open + 2, -1) : s;
  if (loc.startsWith('eval at ')) { const e = /\((\S*?):(\d+):(\d+)\)/.exec(loc); return e ? { fn: evalName(fn), loc: e[1]!, line: Number(e[2]) } : { fn: evalName(fn), loc: '' }; }
  if (/^(<anonymous>|native|index \d+)$/.test(loc)) return { fn, loc: '', native: true };
  return at(fn, loc);
}
/**
 * Firefox (SpiderMonkey) and Safari (JavaScriptCore, every browser on iPhone and iPad): `fn@address:line:column` without a message line, like
 * Sentry's `geckoStackLineParser`. The function ends at the first `@` (an address may hold one, e.g. Vite's `/@fs/`). Firefox: `async*fn`,
 * `promise callback*`, `setTimeout handler*` mark the caller across an asynchronous step; `outer/<` is an anonymous function inside `outer`,
 * `outer/inner` the function `inner`; `address line N > eval:l:c` (or `> Function`) is code from eval, called on line N (Sentry's
 * `geckoEvalRegex`). Safari: `global code` and `module code` are the top level of a script; `eval code@` and `fn@` without an address are code
 * from eval; `[native code]` is built-in code; extensions as `safari-extension:(//…)` (Sentry's `extractSafariExtensionDetails`).
 */
function geckoLine(raw: string): StackLine | null {
  const s = raw.trim(); if (!s) return null;
  if (s === '[native code]') return { fn: '', loc: '', native: true };
  const i = s.indexOf('@');
  if (i < 0) return /^[a-z][a-z0-9+.-]*:\S*:\d+(?::\d+)?\)?$/i.test(s) ? geckoLine(`@${s}`) : null;
  let fn = s.slice(0, i); let loc = s.slice(i + 1);
  fn = fn.slice(fn.lastIndexOf('*') + 1);
  if (fn.includes('/')) { const last = fn.slice(fn.lastIndexOf('/') + 1); fn = last.endsWith('<') ? '' : last; }
  if (fn === 'global code' || fn === 'module code') fn = '';
  if (fn === 'eval code') fn = 'eval';
  if (loc === '[native code]') return { fn, loc: '', native: true };
  loc = loc.replace(/^(safari(?:-web)?-extension:)\((.*)\)$/, '$1$2');
  const ev = /^(.*?) line (\d+)(?: > (?:eval|Function)(?: line \d+)?)* > (?:eval|Function):\d+(?::\d+)?$/.exec(loc);
  if (ev) return { fn: evalName(fn), loc: ev[1]!, line: Number(ev[2]) };
  if (!loc) return { fn: evalName(fn), loc: '' };
  return /:\d+$/.test(loc) ? at(fn, loc) : null;   // a frame names its line; `Error: mail a@b.example` (a message line in a stack set by hand) does not
}
/**
 * Frames of a stack (innermost first), the same for Chrome, Firefox and Safari. A frame in a file with a known debug id carries the full path
 * of the file without query, the column and the debug id: everydeck resolves it with the uploaded source map to the source file, line and function.
 * Without a debug id: the last two path parts and the line (a built file says nothing more without its map). Built-in code (`[native code]`,
 * `<anonymous>`) is left out, as Firefox never lists it, unless the stack holds nothing else. Any object with a stack counts (an error from another
 * frame or window is no `instanceof Error` here); no stack, no frames.
 */
export function framesOf(err: unknown, max = 8): Frame[] | undefined {
  const st = err && typeof err === 'object' ? (err as { stack?: unknown }).stack : undefined; if (typeof st !== 'string' || !st) return undefined;
  const lines = st.split('\n'); const v8 = lines.some((l) => /^\s*at /.test(l));
  const parsed = lines.map((l) => (v8 ? v8Line(l) : geckoLine(l))).filter((x): x is StackLine => !!x);
  const own = parsed.filter((x) => !x.native);
  const out: Frame[] = []; const ids = debugIds();
  for (const p of (own.length ? own : parsed).slice(0, max)) {
    const fn = (p.fn || 'anonymous').slice(0, 128);
    const addr = p.loc.replace(/[?#].*$/, ''); const id = ids.size && addr ? ids.get(addr) : undefined;
    if (id && p.line && p.column) {
      let path = addr; try { path = new URL(addr).pathname; } catch { /* not an address: keep it */ }
      out.push({ function: fn, file: path.slice(0, 240), line: p.line, column: p.column, debug_id: id });
    } else {
      const file = p.loc.replace(/\?.*$/, '').split('/').slice(-2).join('/');
      out.push({ function: fn, ...(file ? { file: file.slice(0, 240) } : {}), ...(p.line ? { line: p.line } : {}) });
    }
  }
  return out.length ? out : undefined;
}
/** Path of a request without declared patterns: Supabase paths as they are, otherwise only the first segment */
export const defaultRoute = (u: URL): string => apiRouteOf(u.pathname, []);

// ── Platform, version per platform, rough device class, path before the error ─────────────────────────────────────────────────────────────
type G = Record<string, unknown> & { navigator?: { userAgent?: string; product?: string; userAgentData?: { platform?: string; mobile?: boolean } }; location?: { href?: string } };
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z0-9_-]{20,})$/i;
// ── Page and API patterns: the same rules as screenOf/apiRouteOf/scrubPaths in everydeck (the SDK has no dependencies; a test checks they are equal)
/** Most specific matching pattern (fixed segment before `:param` before `*`) or null */
function bestPattern(segs: string[], patterns: readonly string[]): string | null {
  let best: { p: string; score: number[] } | null = null;
  for (const p of patterns) {
    const ps = p.split('/').filter(Boolean); const wild = ps.at(-1) === '*'; const fixed = wild ? ps.slice(0, -1) : ps;
    if (wild ? segs.length < fixed.length : segs.length !== fixed.length) continue;
    if (!fixed.every((x, i) => x.startsWith(':') || x === segs[i])) continue;
    const score = [...fixed.map((x) => (x.startsWith(':') ? 2 : 3)), ...(wild ? [1] : [])];
    const better = !best || (() => { for (let i = 0; i < Math.max(score.length, best.score.length); i++) { const a = score[i] ?? 0; const b = best.score[i] ?? 0; if (a !== b) return a > b; } return false; })();
    if (better) best = { p: p === '/*' || p === '/' ? p : `/${ps.join('/')}`, score };
  }
  return best?.p ?? null;
}
const segsOf = (address: string) => String(address).replace(/[?#].*$/, '').split('/').filter(Boolean);
/** Without a matching pattern: the first segment; with declared patterns only a fixed first segment of a pattern (otherwise `/*`), without patterns only if it is not an identifier (otherwise `/:id`) */
function firstSegment(segs: string[], patterns: readonly string[]): string {
  const first = segs[0]!;
  if (patterns.length) return patterns.some((p) => p.split('/').filter(Boolean)[0] === first) ? `/${first}` : '/*';
  return ID_SEGMENT.test(first) ? '/:id' : `/${first}`.slice(0, 80);
}
/**
 * Address → the app's page pattern. The most specific matching pattern wins (fixed segment before `:param` before `*`); without a matching pattern
 * only the first segment remains (see firstSegment). That way no slug, name or identifier leaves the browser. Same rule in the SDK.
 */
export function screenOf(address: string, patterns: readonly string[]): string {
  const segs = segsOf(address);
  if (!segs.length) return '/';
  return bestPattern(segs, patterns) ?? firstSegment(segs, patterns);
}
/**
 * Paths that carry no names by themselves: Supabase REST (`/rest/v1/<table>`, `/rest/v1/rpc/<function>`), Edge Functions
 * (`/functions/v1/<name>`), Auth (`/auth/v1/<action>`), Storage up to the bucket (the file path becomes `*`), Realtime, GraphQL. Deeper → `/*`.
 */
export function supabaseRouteOf(segs: readonly string[]): string | null {
  const [a, v] = segs;
  if (v !== 'v1' || !a) return null;
  const keep = (n: number) => `/${segs.slice(0, n).join('/')}${segs.length > n ? '/*' : ''}`;
  if (a === 'rest') return segs[2] === 'rpc' ? keep(4) : keep(3);
  if (a === 'functions' || a === 'auth') return keep(3);
  if (a === 'storage') { if (segs[2] !== 'object') return keep(4); const kind = ['public', 'sign', 'authenticated', 'list', 'info', 'upload', 'move', 'copy', 'render'].includes(segs[3] ?? '') ? 1 : 0; return keep(4 + kind); }
  if (a === 'realtime' || a === 'graphql') return keep(2);
  return null;
}
/** API path of a request → declared pattern (`api_routes`), otherwise built-in Supabase paths, otherwise only the first segment */
export function apiRouteOf(path: string, patterns: readonly string[]): string {
  const segs = segsOf(path);
  if (!segs.length) return '/';
  return bestPattern(segs, patterns) ?? supabaseRouteOf(segs) ?? firstSegment(segs, patterns);
}
/**
 * Treats addresses and paths in an error message like API paths (`https://app.example/partner/jane-doe` → `https://app.example/partner/:slug`,
 * `GET /api/partners/jane-doe` → `GET /api/partners/:slug`); query and fragment are dropped. Patterns: pages and API paths together. Paths to code files
 * (`/assets/Profile-7f2c91.js`) stay, free text without a path stays unchanged.
 */
const CODE_FILE = /\.(?:m?js|cjs|jsx|ts|tsx|css|map|vue|svelte|wasm|html?)$/i;
export function scrubPaths(text: string, patterns: readonly string[]): string {
  const path = (p: string) => (CODE_FILE.test(p.replace(/:\d+(?::\d+)?$/, '')) ? p : apiRouteOf(p, patterns));   // files of the app's code (chunks, sources) are not user data
  return String(text)
    .replace(/\bhttps?:\/\/[^\s'"<>()]+/g, (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname === '/' ? '' : path(x.pathname)}`; } catch { return u; } })
    .replace(/(^|[\s'"(=:,])(\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%:@-]+)+)(?:[?#][^\s'"]*)?/g, (_m, pre: string, p: string) => `${pre}${path(p)}`);
}
/** Path of an address, also with hash routers (`/#/partner/x` → `/partner/x`) */
const pathOf = (u: URL): string => (u.pathname === '/' && u.hash.startsWith('#/') ? u.hash.slice(1) : u.pathname);
/** Page name without declared patterns: only the first segment (/partner/jane-doe → /partner, /123 → /:id) */
export const defaultRouteName = (u: URL): string => screenOf(pathOf(u), []);
/** Operating system with major version and device class from the user agent: rough, never model or identifier */
type Device = Pick<ClientInfo, 'os' | 'os_major' | 'device_class'>;
export function deviceOf(ua: string, uaData?: { platform?: string; mobile?: boolean }): Device {
  const r = rawDevice(ua, uaData) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as Device;
}
function rawDevice(ua: string, uaData?: { platform?: string; mobile?: boolean }): { os: NonNullable<ClientInfo['os']>; os_major?: number | undefined; device_class?: ClientInfo['device_class'] } {
  const m = (re: RegExp) => { const x = re.exec(ua); return x ? Number(x[1]) : undefined; };
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) return { os: 'ios', os_major: m(/OS (\d+)[_.]/) ?? m(/Version\/(\d+)/), device_class: 'tablet' };
  if (/iPhone|iPod/.test(ua)) return { os: 'ios', os_major: m(/OS (\d+)[_.]/), device_class: 'phone' };
  if (/Android/.test(ua)) return { os: 'android', os_major: m(/Android (\d+)/), device_class: /Mobile/.test(ua) ? 'phone' : 'tablet' };
  if (/CrOS/.test(ua)) return { os: 'chromeos', device_class: 'desktop' };
  if (/Windows NT/.test(ua)) return { os: 'windows', os_major: m(/Windows NT (\d+)/), device_class: 'desktop' };
  if (/Mac OS X|Macintosh/.test(ua)) return { os: 'macos', os_major: m(/Mac OS X (\d+)[_.]/), device_class: 'desktop' };
  if (/Linux/.test(ua)) return { os: 'linux', device_class: uaData?.mobile ? 'phone' : 'desktop' };
  return { os: 'other', ...(uaData?.mobile ? { device_class: 'phone' as const } : {}) };
}
const asPlatform = (os: string | undefined): ClientInfo['platform'] | null => (os === 'ios' || os === 'android' ? os : os === 'web' ? 'web' : os === 'windows' || os === 'macos' ? 'desktop' : null);
/**
 * Detects the origin: Chrome extension, Capacitor (App.getInfo for version and build, Capgo for live updates), Expo (Updates, Application),
 * React Native, Electron, Tauri, Flutter web, otherwise web. `later` returns what can only be queried asynchronously (native app version).
 */
export function detectClient(g: G = globalThis as unknown as G, mods: RuntimeModules = {}): { client: ClientInfo; later: Promise<Partial<ClientInfo>> | null } {
  const ua = g.navigator?.userAgent ?? ''; const dev = deviceOf(ua, g.navigator?.userAgentData);
  const chrome = g['chrome'] as { runtime?: { id?: string; getManifest?: () => { version?: string; manifest_version?: number } } } | undefined;
  if (chrome?.runtime?.id && typeof chrome.runtime.getManifest === 'function') {
    const mf = chrome.runtime.getManifest();
    return { client: { platform: 'extension', runtime: mf.manifest_version === 3 ? 'chrome_mv3' : 'other', ...(mf.version ? { app_version: mf.version } : {}), ...dev }, later: null };
  }
  if (mods.expo) {
    const os = asPlatform(mods.expo.Platform?.OS) ?? 'web'; const up = mods.expo.Updates ?? {}; const ap = mods.expo.Application ?? {};
    const version = ap.nativeApplicationVersion ?? up.runtimeVersion ?? undefined;
    return { client: { platform: os, runtime: 'expo', ...(version ? { app_version: version } : {}), ...(ap.nativeBuildVersion ? { build: ap.nativeBuildVersion } : {}), ...(up.updateId ? { update_id: up.updateId } : {}), ...(up.channel ? { channel: up.channel } : {}), ...dev, ...(os === 'ios' || os === 'android' ? { os } : {}) }, later: null };
  }
  if (mods.reactNative || g.navigator?.product === 'ReactNative') {
    const os = asPlatform(mods.reactNative?.Platform?.OS) ?? 'android';
    const v = mods.reactNative?.Platform?.Version;
    return { client: { platform: os, runtime: 'react_native', os: os === 'ios' ? 'ios' : 'android', ...(v !== undefined && Number.isFinite(parseInt(String(v), 10)) ? { os_major: parseInt(String(v), 10) } : {}), ...(dev.device_class ? { device_class: dev.device_class } : {}) }, later: null };
  }
  const cap = g['Capacitor'] as { getPlatform?: () => string; Plugins?: { App?: { getInfo?: () => Promise<{ version?: string; build?: string }> }; CapacitorUpdater?: { current?: () => Promise<{ bundle?: { id?: string; version?: string } }> } } } | undefined;
  if (cap?.getPlatform) {
    const os = asPlatform(cap.getPlatform()) ?? 'web';
    const native = os === 'ios' || os === 'android';
    const later = native ? (async () => {
      const out: Partial<ClientInfo> = {};
      try { const info = await cap.Plugins?.App?.getInfo?.(); if (info?.version) out.app_version = info.version; if (info?.build) out.build = info.build; } catch { /* plugin missing: version stays open */ }
      try { const cur = await cap.Plugins?.CapacitorUpdater?.current?.(); const id = cur?.bundle?.version ?? cur?.bundle?.id; if (id && id !== 'builtin') out.update_id = id; } catch { /* no live update */ }
      return out;
    })() : null;
    return { client: { platform: os, runtime: native ? 'capacitor' : 'browser', ...dev }, later };
  }
  const proc = g['process'] as { versions?: { electron?: string } } | undefined;
  if (proc?.versions?.electron) return { client: { platform: 'desktop', runtime: 'electron', ...dev }, later: null };
  if (g['__TAURI__'] || g['__TAURI_INTERNALS__']) return { client: { platform: 'desktop', runtime: 'tauri', ...dev }, later: null };
  if (g['_flutter']) return { client: { platform: 'web', runtime: 'flutter', ...dev }, later: null };
  return { client: { platform: 'web', runtime: 'browser', ...dev }, later: null };
}
const PENDING_KEY = 'everydeck.pending.v1';
/** end of a wait everydeck asked for (milliseconds since 1970), kept with the refused events */
const WAIT_KEY = 'everydeck.wait.v1';
/** A page that matches no declared pattern: only a fingerprint of its shape and depth, never the address */
export const UNKNOWN_SCREEN = 'everydeck.sdk.unknown_screen';
/** Shape of an address: identifiers (numbers, UUIDs, long strings) become `:p`; from that a fingerprint (2 × FNV-1a 32, 16 hex characters) */
export function screenShape(address: string): { shape: string; depth: number } | null {
  const segs = segsOf(address); if (!segs.length) return null;
  const form = `/${segs.map((x) => (ID_SEGMENT.test(x) ? ':p' : x)).join('/')}`;
  const fnv = (seed: number) => { let h = seed >>> 0; for (let i = 0; i < form.length; i++) { h ^= form.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
  return { shape: fnv(0x811c9dc5) + fnv(0x01234567), depth: segs.length };
}
/** Origin of the page (scheme, host, port, no path): http(s) only; an app in a native shell (capacitor://) has no domain */
export function originOf(g: G): { origin?: string } {
  try { const u = new URL(String(g.location?.href ?? '')); return /^https?:$/.test(u.protocol) ? { origin: u.origin.toLowerCase() } : {}; } catch { return {}; }
}
const PATCHED = Symbol.for('everydeck.fetch.patched'); const ORIGINAL = Symbol.for('everydeck.fetch.original');
const XHR_PATCHED = Symbol.for('everydeck.xhr.patched'); const XHR_INFO = Symbol.for('everydeck.xhr.info');
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/**
 * a request of a running flow without an answer for this long is a hang (measured, not interpreted): reported after this time and again when the
 * person leaves the page. Like Sentry's final timeout of an idle transaction (30 s, then `deadline_exceeded`).
 */
export const HANG_AFTER_MS = 30_000;
/** at most this many hang steps per page life (a hung request at most twice: after HANG_AFTER_MS and at leaving); the rest arrives as a gap */
export const HANG_REPORTS_MAX = 50;
/** a request of a flow that has not answered yet */
interface Inflight { ctx: ActionContext; method: string; url: URL; started: number; frames: Frame[] | undefined; timer: ReturnType<typeof setTimeout> | null; left: boolean }
const noop = () => {};
/** Hosting domains shared by many apps: a sibling subdomain there is another app, not the same site */
const SHARED_HOSTING = /(?:^|\.)(?:vercel\.app|netlify\.app|onrender\.com|pages\.dev|workers\.dev|github\.io|herokuapp\.com|fly\.dev|railway\.app|web\.app|firebaseapp\.com|azurewebsites\.net|azurestaticapps\.net|amplifyapp\.com|lovable\.app|lovableproject\.com|replit\.app|repl\.co|supabase\.co|ngrok-free\.app|ngrok\.io|trycloudflare\.com|glitch\.me|surge\.sh|deno\.dev|webcontainer\.io)$/;
/**
 * The same site as the page, roughly: the same host on another port, or a subdomain of the page's registrable domain (app.example.com and
 * api.example.com; two-letter country domains with a second level such as co.uk keep three labels). Never on shared hosting domains, IP
 * addresses or localhost, where a neighbour is another app.
 */
export function sameSite(host: string, pageHost: string): boolean {
  const h = host.replace(/:\d+$/, '').toLowerCase(); const p = pageHost.replace(/:\d+$/, '').toLowerCase();
  if (!h || !p) return false;
  if (h === p) return true;
  if (/^[\d.]+$/.test(p) || p === 'localhost' || p.startsWith('[') || SHARED_HOSTING.test(p)) return false;
  const labels = p.split('.');
  const keep = labels.length >= 3 && /^[a-z]{2}$/.test(labels.at(-1)!) && /^(?:co|com|org|net|gov|ac|edu|or|ne|go)$/.test(labels.at(-2)!) ? 3 : 2;
  if (labels.length < keep) return false;
  const base = labels.slice(-keep).join('.');
  return h === base || h.endsWith(`.${base}`);
}
/** Path of a request to a foreign host: Supabase paths as they are, otherwise only the first segment (`/v1/*`); never the app's patterns */
export function foreignRoute(path: string): string {
  const segs = segsOf(path); if (!segs.length) return '/';
  const sb = supabaseRouteOf(segs); if (sb) return sb;
  return `${ID_SEGMENT.test(segs[0]!) ? '/:id' : `/${segs[0]!.slice(0, 80)}`}${segs.length > 1 ? '/*' : ''}`;
}
interface XhrLike { status: number; responseType?: string; responseText?: string; response?: unknown; getResponseHeader?(name: string): string | null; addEventListener(type: string, fn: () => void): void; [XHR_INFO]?: { method: string; url: string } }


/** Step with the origin of a person's first visit (like PostHog $initial_utm_* and $initial_referring_domain), sent once per person and device */
export const ORIGIN_EVENT = 'everydeck.sdk.origin';
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
const ORIGIN_KEY = 'everydeck.initial_origin'; const ORIGIN_SENT_KEY = 'everydeck.origin_sent';
/** Origin of a visit: the UTM values of the address and the host of the referring page (never its path or query); nothing from the same site */
export function initialOriginOf(href: string, referrer: string): Partial<Record<(typeof UTM_KEYS)[number] | 'referring_domain', string>> {
  const out: Partial<Record<(typeof UTM_KEYS)[number] | 'referring_domain', string>> = {};
  let page: URL | null = null; try { page = new URL(href); } catch { page = null; }
  if (page && /^https?:$/.test(page.protocol)) for (const k of UTM_KEYS) { const v = page.searchParams.get(k)?.trim(); if (v) out[k] = v.slice(0, 100); }
  try {
    const r = new URL(referrer);
    if (/^https?:$/.test(r.protocol) && r.host && !(page && (r.host.toLowerCase() === page.host.toLowerCase() || sameSite(r.host, page.host)))) out.referring_domain = r.hostname.toLowerCase().slice(0, 100);
  } catch { /* no referring page */ }
  return out;
}

export class EverydeckBrowser {
  readonly client: EverydeckClient;
  readonly sessionId: string;
  private subject: { subjectRef?: string; accountRef?: string } = {};
  private readonly baseFetch: typeof fetch;
  private readonly route: (u: URL) => string;
  private readonly hosts: string[] | null;
  private readonly correlate: (u: URL) => boolean;
  /** recent screens/routes (names), oldest first */
  private readonly trailList: string[] = [];
  private readonly unknownSeen = new Set<string>();
  private readonly routeName: (u: URL) => string;
  /** detection finished (native version added) */
  readonly ready: Promise<void>;
  /**
   * Reported request failures, keyed by the exact object the app receives (the failed Response or the thrown network error).
   * A later throw counts as the *same* failure only if it is that object or carries it as `cause`, `context` or `response`;
   * a shared attempt id alone proves nothing about the cause.
   */
  private readonly reported = new WeakMap<object, { attemptId: string; errorClass: string }>();
  /** Number of reported request failures per running attempt (for the "after a failed request" hint on independent errors). */
  private readonly failedInAttempt = new Map<string, number>();
  private markFailed(attemptId: string, obj: unknown, errorClass: string): void {
    if (obj && (typeof obj === 'object' || typeof obj === 'function')) this.reported.set(obj as object, { attemptId, errorClass });
    if (this.failedInAttempt.size >= 1000) this.failedInAttempt.clear();
    this.failedInAttempt.set(attemptId, (this.failedInAttempt.get(attemptId) ?? 0) + 1);
  }
  /** The reported request failure this thrown value provably is or wraps, within the same attempt; otherwise null. */
  private propagated(e: unknown, attemptId: string): { errorClass: string } | null {
    const candidates: unknown[] = [e];
    if (e && typeof e === 'object') for (const k of ['cause', 'context', 'response'] as const) { try { candidates.push((e as Record<string, unknown>)[k]); } catch { /* getter threw */ } }
    for (const c of candidates) {
      if (!c || (typeof c !== 'object' && typeof c !== 'function')) continue;
      const hit = this.reported.get(c as object);
      if (hit && hit.attemptId === attemptId) return { errorClass: hit.errorClass };
    }
    return null;
  }
  constructor(o: BrowserOptions) {
    const { sessionId, captureUnhandled, sanitizeRoute, captureHosts, correlate, detectClient: detect, runtime, routeName, persist, screens, apiRoutes, storage, captureBackground, captureConsole, writes, captureOrigin, captureVitals, ...core } = o;
    // valid entries only (flow like a signal name, known kind)
    this.writes = (writes ?? []).filter((w) => w && SAFE.test(String(w.flow)) && typeof w.table === 'string' && w.table.length > 0 && WRITE_KINDS.has(w.kind)).slice(0, 200);
    // the original fetch: for the app's requests through the SDK and for the SDK's own sending (never through the wrapper)
    const g0 = globalThis as unknown as { fetch?: typeof fetch & { [PATCHED]?: boolean; [ORIGINAL]?: typeof fetch } };
    const orig: typeof fetch | null = typeof g0.fetch === 'function' ? (g0.fetch[ORIGINAL] ?? g0.fetch.bind(globalThis)) : null;
    // detect the origin; explicit values from the app (`client`) take precedence
    const found = detect === false ? { client: undefined, later: null } : detectClient(globalThis as unknown as G, runtime ?? {});
    this.store = storage ?? null;
    // save the buffer after a failed send (offline), remove the saved copy after a successful drain
    this.client = new EverydeckClient({ ...core, ...(core.fetch ? {} : orig ? { fetch: orig } : {}), keepalive: true, client: { platform: 'web', ...(found.client ?? {}), ...originOf(globalThis as unknown as G), ...(o.client ?? {}) } as Partial<ClientInfo>,
      onSendResult: (r, pending) => { if (r === 'retry') this.savePending(); else if (r === 'accepted' && (pending === 0 || (!this.persistOn && this.stored))) this.clearPending(); } });
    const detected = found.later ? found.later.then((x) => { this.client.setClient({ ...x, ...(o.client ?? {}) }); }).catch(() => undefined) : Promise.resolve();
    this.screens = (screens ?? []).filter((x) => typeof x === 'string' && x.startsWith('/')).slice(0, 300);
    this.routeName = routeName ?? ((u: URL) => screenOf(pathOf(u), this.screens));
    this.trackRoutes();
    // offline on the phone: save unsent events on exit and send them on the next start (everydeck deduplicates)
    const native = ['ios', 'android'].includes(this.client.getClient()?.platform ?? '');
    this.persistOn = (persist ?? (native || !!storage)) && this.client.opts.enabled;
    // a web page keeps only what everydeck refused (429 or 503 with Retry-After) and the visitor left before the wait ended; the next visit sends it
    this.keepRefused = !this.persistOn && persist !== false && this.client.opts.enabled;
    // restoring can be asynchronous (AsyncStorage): `ready` waits for it, and the first flush after that also sends the old events
    this.ready = Promise.all([detected, this.persistOn || this.keepRefused ? this.restorePending() : Promise.resolve()]).then(() => undefined);
    this.sessionId = sessionId ?? uuid();
    this.baseFetch = (o.fetch ?? orig ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)));
    this.apiRoutes = (apiRoutes ?? []).filter((x) => typeof x === 'string' && x.startsWith('/')).slice(0, 500);
    // the path of a request only as a pattern, also the result of a custom sanitizeRoute function
    this.route = (u: URL) => apiRouteOf(sanitizeRoute ? sanitizeRoute(u) : u.pathname, this.apiRoutes);
    this.hosts = captureHosts ?? null;
    this.endpoint = this.client.opts.endpoint;
    // wrapper around globalThis.fetch: every app request to its own hosts goes through the central path (without an action: no headers, only errors reported)
    if (captureBackground !== false && this.client.opts.enabled && orig && g0.fetch && !g0.fetch[PATCHED]) {
      const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => this.fetchWithContext(null, input, init, undefined, orig)) as typeof fetch & { [PATCHED]?: boolean; [ORIGINAL]?: typeof fetch };
      wrapped[PATCHED] = true; wrapped[ORIGINAL] = orig; g0.fetch = wrapped;
      this.uninstall = () => { if (g0.fetch === wrapped) g0.fetch = orig; };
    }
    // XMLHttpRequest (axios and older clients): the same background path, from the request's own events; the app's request stays unchanged
    const X = (globalThis as unknown as { XMLHttpRequest?: { prototype: Record<string | symbol, unknown> } }).XMLHttpRequest;
    if (captureBackground !== false && this.client.opts.enabled && X?.prototype && typeof X.prototype['open'] === 'function' && typeof X.prototype['send'] === 'function' && !X.prototype[XHR_PATCHED]) {
      const proto = X.prototype; const open = proto['open'] as (this: XhrLike, ...a: unknown[]) => unknown; const send = proto['send'] as (this: XhrLike, ...a: unknown[]) => unknown; const self = this;
      proto['open'] = function (this: XhrLike, ...a: unknown[]) { try { this[XHR_INFO] = { method: String(a[0] ?? 'GET').toUpperCase(), url: String(a[1] ?? '') }; } catch { /* never disturb the request */ } return open.apply(this, a); };
      proto['send'] = function (this: XhrLike, ...a: unknown[]) { try { const info = this[XHR_INFO]; if (info) self.watchXhr(this, info); } catch { /* never disturb the request */ } return send.apply(this, a); };
      proto[XHR_PATCHED] = true;
      const before = this.uninstall;
      this.uninstall = () => { before(); if (proto[XHR_PATCHED]) { proto['open'] = open; proto['send'] = send; delete proto[XHR_PATCHED]; } };
    }
    this.correlate = correlate ?? (() => true);
    // keep where the person came from on the first visit (once; later visits do not overwrite it)
    this.origin = captureOrigin !== false && this.client.opts.enabled ? this.rememberOrigin() : Promise.resolve(null);
    if (captureUnhandled !== false && captureConsole !== false && this.client.opts.enabled) this.patchConsole();
    // load times of every page view, only in a browser page (not React Native, Expo or Capacitor) that can observe them
    this.vitals = captureVitals !== false && this.client.opts.enabled && measuresVitals(this.client.getClient()) ? this.startVitals() : null;
    if (captureUnhandled !== false && typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('error', (e: unknown) => { const ev = e as { error?: unknown; message?: string; filename?: string; lineno?: number; colno?: number }; this.captureUnhandled('browser.unhandled_error', ev.error ?? ev.message, ev); });
      globalThis.addEventListener('unhandledrejection', (e: unknown) => { this.captureUnhandled('browser.unhandled_rejection', (e as { reason?: unknown }).reason); });
    }
    if ((captureUnhandled !== false || this.vitals || this.client.opts.enabled) && typeof globalThis.addEventListener === 'function') {
      // web-vitals reports CLS and INP in its own (capturing) listener just before this one; the collected page views go out in the same batch
      // hung requests of running flows go out with them
      const hidden = () => { this.reportHangs(); this.vitals?.drain(); void this.savePending(); this.client.flushKeepalive(); };
      globalThis.addEventListener('pagehide', hidden);
      globalThis.addEventListener('visibilitychange', () => { if ((globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden') hidden(); });
    }
  }
  private persistOn = false;
  private keepRefused = false;
  /** something of this page lies in the storage (a web page clears it after the next accepted send, without touching the storage otherwise) */
  private stored = false;
  private readonly vitals: VitalsCollector | null;
  /** page of a measurement: the address of its navigation (soft navigations), otherwise the page that was loaded, only as its pattern */
  private startVitals(): VitalsCollector {
    const landing = (globalThis as { location?: { href?: string } }).location?.href;
    const c = new VitalsCollector((url) => {
      try { const raw = this.routeName(new URL(url ?? landing ?? '')); return (raw.startsWith('/') ? screenOf(raw, this.screens) : raw.replace(/[?#\s].*$/, '')).slice(0, 200); } catch { return ''; }
    }, (fields) => this.client.signal(WEB_VITALS_EVENT, WEB_VITALS_OPERATION, { fields }), (limit, n) => this.client.noteLoss(limit, n));
    watchVitals(c);
    return c;
  }
  private readonly writes: BrowserWrite[];
  /** running actions, newest last; a request without its own action belongs to the newest one (a browser has no async context) */
  private readonly running: ActionContext[] = [];
  /** requests of running flows without an answer yet */
  private readonly inflight = new Set<Inflight>();
  private hangReports = 0;
  /**
   * a request starts. Its action, otherwise the newest running action; without one it is no request of a flow and not watched (no hangs
   * of background requests). Returns the end. The app's request is never touched: no signal, no abort, no timeout.
   */
  private watchRequest(ctx: ActionContext | null, method: string, url: URL): () => void {
    const owner = ctx ?? this.running.at(-1);
    if (!owner || !this.client.opts.enabled || !METHODS.has(method)) return noop;
    const r: Inflight = { ctx: owner, method, url, started: Date.now(), frames: framesOf(new Error('request started'), 10), timer: null, left: false };
    this.inflight.add(r);
    r.timer = setTimeout(() => { r.timer = null; if (this.inflight.has(r)) this.reportHang(r); }, HANG_AFTER_MS);
    (r.timer as { unref?: () => void }).unref?.();
    return () => { this.inflight.delete(r); if (r.timer) clearTimeout(r.timer); };
  }
  /** the person leaves the page: every request of a flow without an answer for at least HANG_AFTER_MS, once per request at leaving */
  private reportHangs(): void {
    const now = Date.now();
    for (const r of this.inflight) if (!r.left && now - r.started >= HANG_AFTER_MS) { r.left = true; this.reportHang(r); }
  }
  /** step `<flow>.request_hung`: method, host, address pattern (like failed requests), how long without an answer, where it started in the code */
  private reportHang(r: Inflight): void {
    if (this.hangReports >= HANG_REPORTS_MAX) { this.client.noteLoss('sdk_hang_reports'); return; }
    this.hangReports++;
    const own = (globalThis as { location?: { host?: string } }).location?.host ?? null;
    const cross = !!own && r.url.host !== own;
    const http: HttpContext = { method: r.method as HttpContext['method'], route: this.appHost(r.url) ? this.route(r.url) : foreignRoute(r.url.pathname), durationMs: Date.now() - r.started, ...(cross ? { crossOrigin: true, host: r.url.host.toLowerCase() } : {}) };
    const { sessionId, ...refs } = this.ctxRefs(r.ctx);
    this.client.breadcrumb(`${r.ctx.name}.request_hung`, sessionId, { ...refs, http, ...(r.frames ? { at: { class: 'request_hung', frames: r.frames } } : {}) });
  }
  /** Removes the wrapper around globalThis.fetch again (tests, shutting the SDK down) */
  uninstall: () => void = () => {};
  private readonly endpoint: string;
  /** the same failed background request (method, route, status, page) at most every 30 s */
  private readonly lastBackground = new Map<string, number>();
  /**
   * Facts from the body of a failed response (error code, message): from a copy, only for JSON up to ANSWER_MAX_BYTES and for at most
   * 2 s; the app gets its response immediately and unchanged. The message additionally has paths only as patterns (like error messages).
   */
  private answer(res: Response): Promise<ErrorAnswer | undefined> {
    const ct = res.headers?.get?.('content-type') ?? ''; const len = Number(res.headers?.get?.('content-length') ?? 0);
    if (!/json/i.test(ct) || len > ANSWER_MAX_BYTES) return Promise.resolve(undefined);
    let copy: Response; try { copy = res.clone(); } catch { return Promise.resolve(undefined); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 2000);
      copy.text().then((body) => {
        const a = answerOf(body, ct);
        resolve(a ? { ...a, ...(a.message ? { message: scrubPaths(a.message, [...this.apiRoutes, ...this.screens]).slice(0, 300) } : {}) } : undefined);
      }, () => resolve(undefined)).finally(() => clearTimeout(timer));
    });
  }
  private backgroundFailure(http: HttpContext, cls: string, message: string, response?: ErrorAnswer): void {
    const page = this.trailList.at(-1) ?? '';
    const key = `${http.method} ${http.host ?? ''}${http.route} ${http.status ?? cls} ${page}`; const now = Date.now();
    if ((this.lastBackground.get(key) ?? 0) > now - 30_000) return;
    if (this.lastBackground.size > 200) this.lastBackground.clear();
    this.lastBackground.set(key, now);
    const { sessionId, ...r } = this.ctxRefs(null);
    this.client.error('page.request_failed', cls, { ...r, sessionId, trail: this.trail(), http, message, ...(response ? { response } : {}) });
  }
  /** A request to the app: the page's own host, `captureHosts`, Supabase API paths on any host, the same site (api.<domain>) */
  private appHost(url: URL): boolean {
    const own = (globalThis as { location?: { host?: string } }).location?.host ?? null;
    if (own && url.host === own) return true;
    if (this.hosts?.includes(url.host)) return true;
    if (supabaseRouteOf(segsOf(url.pathname))) return true;
    return !!own && sameSite(url.host, own);
  }
  /**
   * A finished request without an action (fetch or XMLHttpRequest): status null = no answer (`network_error` or `timeout`). Requests to the app
   * report 4xx (401 only while a person is signed in), 5xx and no answer; any other host reports 5xx and only counts 4xx and no answer.
   */
  private backgroundAnswer(method: string, url: URL, status: number | null, durationMs: number, answer: (() => Promise<ErrorAnswer | undefined>) | null, noAnswer: 'network_error' | 'timeout' = 'network_error'): void {
    if (!METHODS.has(method) || (status !== null && status < 400)) return;
    const app = this.appHost(url);
    const own = (globalThis as { location?: { host?: string } }).location?.host ?? null;
    const cross = !!own && url.host !== own;
    const http: HttpContext = { method: method as HttpContext['method'], route: app ? this.route(url) : foreignRoute(url.pathname), durationMs, ...(status !== null ? { status } : {}), ...(cross ? { crossOrigin: true, host: url.host.toLowerCase() } : {}) };
    const cls = status === null ? noAnswer : `http_${status}`;
    if (status === 401 && app && !this.subject.subjectRef) return;   // signed out: an expected answer
    const report = status === null ? app : status >= 500 || app;
    if (!report) { this.counted(http, cls); return; }
    const where = `${method} ${cross ? url.host.toLowerCase() : ''}${http.route}`;
    const message = status === null ? `${noAnswer === 'timeout' ? 'timeout' : 'network error'} at ${where}` : `HTTP ${status} at ${where}`;
    if (answer) void answer().then((response) => this.backgroundFailure(http, cls, message, response), () => this.backgroundFailure(http, cls, message));
    else this.backgroundFailure(http, cls, message);
  }
  /** 4xx or no answer from a foreign host: a counted step (like Sentry's request breadcrumbs), no case; the same one at most every 30 s */
  private counted(http: HttpContext, cls: string): void {
    const key = `counted ${http.method} ${http.host ?? ''}${http.route} ${http.status ?? cls}`; const now = Date.now();
    if ((this.lastBackground.get(key) ?? 0) > now - 30_000) return;
    if (this.lastBackground.size > 200) this.lastBackground.clear();
    this.lastBackground.set(key, now);
    const { sessionId, ...r } = this.ctxRefs(null);
    this.client.breadcrumb('page.request_counted', sessionId, { ...r, http, fields: { error_class: cls } });
  }
  /** XMLHttpRequest without an action: the outcome from the request's own events (load, error, timeout; abort is not an error) */
  private watchXhr(x: XhrLike, info: { method: string; url: string }): void {
    let url: URL; try { url = new URL(info.url, (globalThis as { location?: { href?: string } }).location?.href ?? 'http://localhost/'); } catch { return; }
    if (this.endpoint && url.href.startsWith(this.endpoint)) return;
    x.addEventListener('loadend', this.watchRequest(null, info.method, url));
    const started = Date.now(); let done = false;
    const finish = (status: number | null, noAnswer: 'network_error' | 'timeout' = 'network_error') => {
      if (done) return; done = true;
      this.backgroundAnswer(info.method, url, status, Date.now() - started, status !== null && status >= 400 ? () => Promise.resolve(this.xhrAnswer(x)) : null, noAnswer);
    };
    x.addEventListener('abort', () => { done = true; });
    x.addEventListener('timeout', () => finish(null, 'timeout'));
    x.addEventListener('error', () => finish(null));
    x.addEventListener('load', () => finish(x.status > 0 ? x.status : null));
  }
  /** Facts from the body of a failed XMLHttpRequest answer (JSON only, like `answer`) */
  private xhrAnswer(x: XhrLike): ErrorAnswer | undefined {
    try {
      const ct = x.getResponseHeader?.('content-type') ?? '';
      const body = !x.responseType || x.responseType === 'text' ? x.responseText ?? '' : x.responseType === 'json' && x.response !== null ? JSON.stringify(x.response) : '';
      const a = answerOf(body, x.responseType === 'json' ? 'application/json' : ct);
      return a ? { ...a, ...(a.message ? { message: scrubPaths(a.message, [...this.apiRoutes, ...this.screens]).slice(0, 300) } : {}) } : undefined;
    } catch { return undefined; }
  }
  private readonly store: StorageAdapter | null;
  private screens: string[] = [];
  private apiRoutes: string[] = [];
  /** Error message without token, query, e-mail and with paths only as patterns (pages and API) */
  private msg(e: unknown): string { return scrubPaths(sanitizeMessage(e), [...this.apiRoutes, ...this.screens]).slice(0, 300); }
  /** Screen change in an app without an address bar (React Navigation, native screens): only the name, never parameters; an address (`/partner/jane-doe`, e.g. from Expo Router's usePathname) is mapped to the patterns */
  /** Pages the app map does not know: once per shape per page life, at most 20; only with declared patterns (otherwise everything is unknown) */
  private unknownScreen(address: string): void {
    if (!this.screens.length) return;
    const segs = segsOf(address); if (!segs.length || bestPattern(segs, this.screens)) return;
    const s = screenShape(address); if (!s || this.unknownSeen.has(s.shape)) return;
    if (this.unknownSeen.size >= 20) { this.client.noteLoss('sdk_unknown_pages'); return; }
    this.unknownSeen.add(s.shape); this.breadcrumb(UNKNOWN_SCREEN, { shape: s.shape, depth: s.depth });
  }
  screen(name: string): void { const raw = String(name); if (raw.startsWith('/')) this.unknownScreen(raw); this.pushTrail(raw); }
  private pushTrail(raw: string): void { const n = (raw.startsWith('/') ? screenOf(raw, this.screens) : raw.replace(/[?#\s].*$/, '')).slice(0, 80); if (!n || this.trailList.at(-1) === n) return; this.trailList.push(n); if (this.trailList.length > 10) this.trailList.shift(); }
  /** Path before the error (copy) */
  trail(): string[] { return [...this.trailList]; }
  private trackRoutes(): void {
    const g = globalThis as unknown as { location?: { href?: string }; history?: { pushState?: (...a: unknown[]) => void; replaceState?: (...a: unknown[]) => void }; addEventListener?: (t: string, f: () => void) => void };
    const note = () => { try { if (g.location?.href) { const u = new URL(g.location.href); this.unknownScreen(pathOf(u)); this.pushTrail(this.routeName(u)); } } catch { /* no address */ } };
    note();
    if (g.history && typeof g.history.pushState === 'function') {
      for (const k of ['pushState', 'replaceState'] as const) {
        const orig = g.history[k]!.bind(g.history);
        g.history[k] = (...a: unknown[]) => { const r = orig(...a); note(); return r; };
      }
    }
    if (typeof g.addEventListener === 'function') { g.addEventListener('popstate', note); g.addEventListener('hashchange', note); }
  }
  private storage(): StorageAdapter | null { if (this.store) return this.store; try { return (globalThis as unknown as { localStorage?: StorageAdapter }).localStorage ?? null; } catch { return null; } }
  /** Saves unsent events now; in Expo/React Native call it when moving to the background (`AppState` → `background`) */
  persist(): Promise<void> { return this.savePending(); }
  private async savePending(): Promise<void> {
    const wait = this.client.refusedUntilMs;
    if (!this.persistOn && !(this.keepRefused && wait)) return;
    try {
      const ev = this.client.exportPending(300); const st = this.storage(); if (!st) return;
      if (ev.length) await st.setItem(PENDING_KEY, JSON.stringify(ev)); else await st.removeItem(PENDING_KEY);
      if (ev.length && wait) await st.setItem(WAIT_KEY, String(wait)); else await st.removeItem(WAIT_KEY);
      this.stored = ev.length > 0;
    } catch { /* storage full or blocked */ }
  }
  private async clearPending(): Promise<void> { if (!this.persistOn && !this.keepRefused) return; this.stored = false; try { const st = this.storage(); if (!st) return; const a = st.removeItem(PENDING_KEY); if (a instanceof Promise) await a; const b = st.removeItem(WAIT_KEY); if (b instanceof Promise) await b; } catch { /* ignore */ } }
  /** synchronous storage (localStorage) is restored in the constructor, asynchronous storage (AsyncStorage) by `ready` */
  private async restorePending(): Promise<void> {
    try {
      const st = this.storage(); if (!st) return;
      const got = st.getItem(PENDING_KEY); const raw = got instanceof Promise ? await got : got;
      if (!raw) return;
      const w = st.getItem(WAIT_KEY); const wait = w instanceof Promise ? await w : w;
      const rm = st.removeItem(PENDING_KEY); if (rm instanceof Promise) await rm;
      const rw = st.removeItem(WAIT_KEY); if (rw instanceof Promise) await rw;
      // the wait of the last visit first, so the restored events are not sent before it ends
      if (wait) this.client.waitUntil(Number(wait));
      this.client.importPending(JSON.parse(raw));
    } catch { /* corrupt: discard */ }
  }
  /** Known person/organization of this session (a claim; it only becomes authoritative through the server's identity source). */
  setSubject(subjectRef: string | null, accountRef?: string | null): void {
    this.subject = { ...(subjectRef ? { subjectRef } : {}), ...(accountRef ? { accountRef } : {}) };
    if (subjectRef) void this.sendOrigin(subjectRef);
  }
  /** Origin of the first visit on this device (null: not kept) */
  private readonly origin: Promise<Record<string, string> | null>;
  private async rememberOrigin(): Promise<Record<string, string> | null> {
    try {
      const st = this.storage(); if (!st) return null;
      const got = st.getItem(ORIGIN_KEY); const raw = got instanceof Promise ? await got : got;
      if (raw) return JSON.parse(raw) as Record<string, string>;
      const g = globalThis as unknown as { location?: { href?: string }; document?: { referrer?: string } };
      const o = initialOriginOf(String(g.location?.href ?? ''), String(g.document?.referrer ?? '')) as Record<string, string>;
      // only when there is an origin: a page opened directly writes nothing to the page's storage
      if (Object.keys(o).length) { const w = st.setItem(ORIGIN_KEY, JSON.stringify(o)); if (w instanceof Promise) await w; }
      return o;
    } catch { return null; }
  }
  private async sendOrigin(subjectRef: string): Promise<void> {
    try {
      const o = await this.origin; if (!o || !Object.keys(o).length) return;
      const st = this.storage(); if (!st) return;
      const got = st.getItem(ORIGIN_SENT_KEY); const raw = got instanceof Promise ? await got : got;
      const sent = raw ? (JSON.parse(raw) as string[]) : [];
      if (sent.includes(subjectRef)) return;
      const w = st.setItem(ORIGIN_SENT_KEY, JSON.stringify([...sent, subjectRef].slice(-20))); if (w instanceof Promise) await w;
      this.client.breadcrumb(ORIGIN_EVENT, this.sessionId, { subjectRef, fields: o });
    } catch { /* storage blocked: nothing sent */ }
  }
  /** No ambient async context: use the context passed to action(). */
  currentAction(): ActionContext | null { return null; }
  private ctxRefs(ctx: ActionContext | null) { return { sessionId: this.sessionId, ...(ctx ? { operationId: ctx.operationId, attemptId: ctx.attemptId, ...(ctx.objectType ? { objectType: ctx.objectType } : {}), ...(ctx.objectRef ? { objectRef: ctx.objectRef } : {}), ...(ctx.subjectRef ? { subjectRef: ctx.subjectRef } : {}), ...(ctx.accountRef ? { accountRef: ctx.accountRef } : {}) } : this.subject) }; }
  /** Errors already reported (unhandled or through the console): React logs an error and rethrows it, that is one error, not two */
  private readonly reportedErrors = new WeakSet<object>();
  private readonly consoleSeen = new Map<string, number>();
  private inConsole = false;
  /** Wraps `console.error`: the app's console prints as before, everydeck gets a scrubbed copy (like Sentry captureConsoleIntegration for `error`) */
  private patchConsole(): void {
    const con = (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console;
    if (!con || typeof con.error !== 'function') return;
    const orig = con.error; const self = this;
    const patched = function (this: unknown, ...a: unknown[]) { if (!self.inConsole) { self.inConsole = true; try { self.captureConsole(a); } catch { /* never disturb the console */ } finally { self.inConsole = false; } } return orig.apply(this, a); };
    con.error = patched;
    const before = this.uninstall;
    this.uninstall = () => { before(); if (con.error === patched) con.error = orig; };
  }
  /** Text of a console call: strings and errors as text, numbers and booleans as they are, anything else only as `[object]` (never the app's data) */
  private captureConsole(args: unknown[]): void {
    const err = args.find(isErrorLike);
    if (err && this.reportedErrors.has(err)) return;
    const text = args.map((x) => (typeof x === 'string' ? x : isErrorLike(x) ? `${x.name}: ${x.message}` : typeof x === 'number' || typeof x === 'boolean' || x === null || x === undefined ? String(x) : '[object]')).join(' ');
    const message = scrubClip(this.msg(text), 300);
    const cls = err ? classOf(err) : 'console_error';
    const key = `${cls} ${message}`; const now = Date.now();
    if ((this.consoleSeen.get(key) ?? 0) > now - 30_000) return;
    if (!this.consoleSeen.has(key) && this.consoleSeen.size >= 50) { this.client.noteLoss('sdk_console_errors'); return; }   // at most 50 different console errors per page life, the rest arrives as a gap
    this.consoleSeen.set(key, now);
    if (err) this.reportedErrors.add(err);
    const { sessionId, ...r } = this.ctxRefs(null);
    this.client.error('browser.console_error', cls, { ...r, sessionId, trail: this.trail(), message, ...(err && framesOf(err) ? { frames: framesOf(err)!, contextStatus: 'browser_no_source_maps' as const } : {}) });
  }
  /**
   * `at`: the error event's place (file, line, column). A thrown value without a stack (`throw 'text'`) still has it; it becomes the one frame, like
   * Sentry's first frame from the event. Without a stack and without a place (a rejection with a text, "Script error." from a foreign script) no frames.
   */
  private captureUnhandled(name: string, err: unknown, at?: { filename?: string; lineno?: number; colno?: number }): void {
    if (err && typeof err === 'object') { if (this.reportedErrors.has(err)) return; this.reportedErrors.add(err); }
    const { sessionId, ...r } = this.ctxRefs(null);
    const frames = framesOf(err) ?? (at?.filename && at.lineno ? framesOf({ stack: `@${at.filename}:${at.lineno}${at.colno ? `:${at.colno}` : ''}` }) : undefined);
    this.client.error(name, classOf(err), { ...r, sessionId, trail: this.trail(), message: this.msg(err), ...(frames ? { frames, contextStatus: 'browser_no_source_maps' as const } : {}) });
  }
  /**
   * the result of a flow that happens in the browser (no server of the app in between), like PostHog `capture` and Sentry `captureEvent` in the
   * browser, with the same name and form as the server SDK: `everydeck.signal('order.submitted', ctx.operationId)` inside the action of the flow. Inside an
   * action it carries that action's attempt, person and object, always the browser session; `r` adds or overrides them. everydeck accepts it only for
   * signals the app map marks `source: "browser"` and keeps it as the browser's claim (a server signal of the same run wins).
   */
  signal(name: string, operationId: string, r: Omit<Refs, 'operationId' | 'sessionId'> = {}): void {
    const ctx = [...this.running].reverse().find((x) => x.operationId === operationId) ?? null;
    const { sessionId, ...own } = this.ctxRefs(ctx);
    this.client.signal(name, operationId, { ...own, ...r, sessionId });
  }
  breadcrumb(name: string, fields?: Record<string, string | number | boolean>): void { const { sessionId, ...r } = this.ctxRefs(null); this.client.breadcrumb(name, sessionId, { ...r, ...(fields ? { fields } : {}) }); }
  /**
   * A user action: operation_id/attempt_id, breadcrumbs for start/end, request errors through `ctx.fetch`, thrown errors as `error`
   * (and rethrown). No business success is claimed by the action itself; the result comes from the server or, for a flow that ends in the browser, from `signal()`.
   */
  async action<T>(name: string, fn: (ctx: ActionContext) => PromiseLike<T> | T, meta: ActionMeta = {}): Promise<T> {
    const ctx = this.newContext(name, { ...this.subject, ...meta }, meta.operationId ?? uuid(), 1);
    return this.runAction(ctx, fn);
  }
  private newContext(name: string, meta: ActionMeta, operationId: string, attempt: number): ActionContext {
    const self = this;
    const ctx: ActionContext = { ...meta, name, operationId, attemptId: meta.attemptId ?? uuid(), attempt, fetch: (input, init, options) => self.fetchWithContext(ctx, input, init, options), expecting: (statuses) => (input, init) => self.fetchWithContext(ctx, input, init, { expect: statuses }), retry() { const { attemptId: _old, ...nextMeta } = meta; return self.newContext(name, nextMeta, operationId, attempt + 1); } };
    return Object.freeze(ctx);
  }
  async runAction<T>(ctx: ActionContext, fn: (ctx: ActionContext) => PromiseLike<T> | T): Promise<T> {
    const { sessionId, ...r } = this.ctxRefs(ctx);
    this.client.breadcrumb(`${ctx.name}.started`, sessionId, r);
    const started = Date.now();
    this.running.push(ctx); if (this.running.length > 100) this.running.shift();
    try {
      const out = await fn(ctx);
      this.client.breadcrumb(`${ctx.name}.finished`, sessionId, { ...r, fields: { duration_ms: Date.now() - started } });
      return out;
    } catch (e) {
      const same = this.propagated(e, ctx.attemptId);
      // Provably the same failure passed on: a step of the already reported error, no second case.
      if (same) this.client.breadcrumb(`${ctx.name}.failed`, sessionId, { ...r, fields: { error_class: classOf(e), propagated_request_failure: true, request_error_class: same.errorClass, duration_ms: Date.now() - started } });
      // Anything else keeps its own sanitized message and frames; an earlier failed request is only a hint, not a cause.
      else this.client.error(`${ctx.name}.failed`, classOf(e), { ...r, sessionId, trail: this.trail(), message: this.msg(e), ...(framesOf(e) ? { frames: framesOf(e)!, contextStatus: 'browser_no_source_maps' as const } : {}), ...(this.failedInAttempt.get(ctx.attemptId) ? { fields: { after_request_failure: true } } : {}) });
      throw e;
    } finally { this.failedInAttempt.delete(ctx.attemptId); const i = this.running.lastIndexOf(ctx); if (i >= 0) this.running.splice(i, 1); }
  }
  /** The central request path: correlation headers inside an action, failures (non-2xx except expected statuses, network, timeout) as `error` with scrubbed context; a passed-on request failure (the same object or as cause/context/response) is a step, every other error stays an error of its own. */
  readonly fetch: typeof fetch = (input, init) => this.fetchWithContext(null, input, init);
  private async fetchWithContext(ctx: ActionContext | null, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], options?: RequestOptions, via?: typeof fetch): Promise<Response> {
    const req = input instanceof Request ? input : null;
    const urlStr = req ? req.url : typeof input === 'string' ? input : (input as URL).toString();
    let url: URL | null = null; try { url = new URL(urlStr, (globalThis as { location?: { href?: string } }).location?.href ?? 'http://localhost/'); } catch { url = null; }
    const method = ((init?.method ?? req?.method ?? 'GET').toUpperCase()) as HttpContext['method'];
    const ownHost = (globalThis as { location?: { host?: string } }).location?.host ?? null;
    const everydeckOwn = !!url && !!this.endpoint && url.href.startsWith(this.endpoint);
    // a declared write without an action becomes a run of its flow: start now, result from the database (outbox), error from the response
    let implicit = false;
    if (!ctx && this.writes.length && this.client.opts.enabled && url && !everydeckOwn) {
      const pw = postgrestWrite(method, url, new Headers(init?.headers ?? req?.headers ?? undefined).get('prefer'));
      const w = pw ? this.writes.find((x) => x.table === pw.table && x.kind === pw.kind) : undefined;
      if (w) { ctx = this.newContext(w.flow, { ...this.subject }, uuid(), 1); implicit = true; const { sessionId, ...r } = this.ctxRefs(ctx); this.client.breadcrumb(`${w.flow}.started`, sessionId, r); }
    }
    // without an action every host (the app's fully, others only 5xx; backgroundAnswer); never everydeck's own sending
    const background = !ctx && this.client.opts.enabled && !!url && !everydeckOwn;
    const capture = this.client.opts.enabled && !!ctx && !!url && (implicit || !this.hosts || this.hosts.includes(url.host));
    let headers: Headers | undefined;
    // Disabled everydeck or an excluded target: the app request stays byte-identical (no extra headers, no CORS preflight caused by everydeck).
    if (capture && this.correlate(url!)) { headers = new Headers(init?.headers ?? req?.headers ?? undefined); headers.set('x-everydeck-operation-id', ctx!.operationId); headers.set('x-everydeck-attempt-id', ctx!.attemptId); headers.set('x-everydeck-session-id', this.sessionId); const pf = this.client.getClient()?.platform; if (pf) headers.set('x-everydeck-platform', pf); }
    const started = Date.now();
    const end = url && !everydeckOwn ? this.watchRequest(ctx, method, url) : noop;
    try {
      const res = await (via ?? this.baseFetch)(input, headers ? { ...init, headers } : init);
      if (background && url && res.status >= 400 && !(options?.expect ?? []).includes(res.status)) this.backgroundAnswer(method, url, res.status, Date.now() - started, () => this.answer(res));
      if (capture && url) {
        const http: HttpContext = { method, route: this.route(url), status: res.status, durationMs: Date.now() - started };
        const { sessionId, ...r } = this.ctxRefs(ctx);
        const expected = res.status >= 400 && ((options?.expect ?? []).includes(res.status) || (ctx!.expectStatus ?? []).includes(res.status));
        if (expected) this.client.breadcrumb(`${ctx!.name}.request`, sessionId, { ...r, http, fields: { expected: true } });
        else if (res.status >= 400) {
          this.markFailed(ctx!.attemptId, res, `http_${res.status}`);
          const base = { ...r, sessionId, trail: this.trail(), http, message: `HTTP ${res.status} at ${http.route}` };
          void this.answer(res).then((response) => this.client.error(`${ctx!.name}.request_failed`, `http_${res.status}`, { ...base, ...(response ? { response } : {}) }));
        }
        else if (implicit) this.client.breadcrumb(`${ctx!.name}.finished`, sessionId, { ...r, http, fields: { duration_ms: http.durationMs ?? 0 } });   // the write is the whole browser part of the run
        else if (method !== 'GET' && method !== 'HEAD') this.client.breadcrumb(`${ctx!.name}.request`, sessionId, { ...r, http });
      }
      return res;
    } catch (e) {
      // an aborted background request (page change, AbortController) is not an error the user sees
      // no response for a request to another host: the browser hides a response without CORS headers from the app (a fact for everydeck)
      const crossOrigin = !!url && !!ownHost && url.host !== ownHost;
      if (background && url && (e as Error)?.name !== 'AbortError') this.backgroundAnswer(method, url, null, Date.now() - started, null, (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network_error');
      if (capture && url) {
        const { sessionId, ...r } = this.ctxRefs(ctx);
        const aborted = (e as Error).name === 'AbortError';
        this.markFailed(ctx!.attemptId, e, aborted ? 'timeout' : 'network_error');
        this.client.error(`${ctx!.name}.request_failed`, aborted ? 'timeout' : 'network_error', { ...r, sessionId, trail: this.trail(), http: { method, route: this.route(url), durationMs: Date.now() - started, ...(crossOrigin ? { crossOrigin } : {}) }, message: this.msg(e) });
      }
      throw e;
    } finally { end(); }
  };
  flush(timeoutMs?: number): Promise<boolean> { return this.client.flush(timeoutMs); }
}

export function initEverydeckBrowser(o: BrowserOptions): EverydeckBrowser { return new EverydeckBrowser(o); }

/** a page in a browser (also a phone's browser) with PerformanceObserver; native apps and their web views measure nothing (their start time is not among these load times) */
function measuresVitals(c: ClientInfo | undefined): boolean {
  const g = globalThis as { PerformanceObserver?: unknown; document?: unknown };
  if (typeof g.PerformanceObserver !== 'function' || !g.document) return false;
  return c?.runtime === undefined ? (c?.platform ?? 'web') === 'web' : c.runtime === 'browser';
}
export type { ClientInfo, HttpContext, EverydeckOptions } from './core.js';
