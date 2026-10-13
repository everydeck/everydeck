/**
 * @everydeck/sdk/browser: browser capture (trust `browser`): unhandled errors, action-bound
 * request errors on the central request path (the provided `fetch`), allowed breadcrumbs. Everything from the browser is a claim;
 * server evidence is joined only through shared IDs (`x-everydeck-operation-id`, `x-everydeck-attempt-id`).
 *
 * Never captured: request/response bodies, tokens, headers, form values, DOM, query strings, chat texts. `route` is only the path.
 *
 * Base coverage without extra work: every failed request to `captureHosts` (default: the page's own host) is reported,
 * also outside an action (network error, 4xx, 5xx; 401 only while a person is signed in): as `page.request_failed` with page (path),
 * route pattern and status, without content. For this the SDK wraps `globalThis.fetch` (can be turned off with `captureBackground: false`);
 * `everydeck.fetch` captures the same way (before 0.1.8 it stayed silent; an update never turns capture off silently). Actions (`ctx.fetch`) remain for flows.
 */
import { EverydeckClient, cleanClient, answerOf, ANSWER_MAX_BYTES, type ClientInfo, type HttpContext, type EverydeckOptions, type Frame, type ErrorAnswer } from './core.js';

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
export interface BrowserOptions extends EverydeckOptions { /** storage for unsent events (default: `localStorage`, which React Native does not have; pass AsyncStorage there) */ storage?: StorageAdapter; /** detect platform and version automatically (on by default); `client` overrides single values */ detectClient?: boolean; /** Expo/React Native modules for detection */ runtime?: RuntimeModules; /** page patterns from the app's router, as declared in the manifest under `screens` (`/partner/:slug`); every address is mapped to the matching pattern */ screens?: string[]; /** patterns of the app's API paths, as declared in the manifest under `api_routes` (`/api/partners/:slug`); the path of every captured request and paths in error messages are mapped to them (Supabase paths need no patterns) */ apiRoutes?: string[]; /** custom page name from the address (takes precedence over `screens`; the result is still mapped to the patterns) */ routeName?: (u: URL) => string; /** save unsent events on exit (default: only in native apps) */ persist?: boolean; sessionId?: string; captureUnhandled?: boolean; /** clean the path (default: pathname); the result is mapped to `apiRoutes` */ sanitizeRoute?: (url: URL) => string; /** hosts whose requests are captured: inside an action (default: all) and in the background (default: the page's own host); name the app's API here when it runs on another host */ captureHosts?: string[]; /** Whether a captured request may carry the correlation headers `x-everydeck-*` (default: yes). Return false for targets whose CORS policy does not allow these headers; the request is still captured, only without server-side correlation. */ correlate?: (url: URL) => boolean;
  /** report every failed request to `captureHosts` (default: the own host) also outside an action, through a wrapper around `globalThis.fetch` (on by default) */ captureBackground?: boolean;
  /** writes to Supabase (PostgREST `/rest/v1/<table>`) that the app map lists as `result.write` of a flow; each one becomes a run of that flow (start, error, id and platform as headers for the outbox trigger) */ writes?: BrowserWrite[] }
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
const classOf = (v: unknown): string => { const n = (v instanceof Error ? v.name : typeof v === 'string' ? 'error' : 'unknown_error').toLowerCase().replace(/[^a-z0-9_.-]/g, '_').replace(/^[^a-z]+/, ''); return SAFE.test(n) ? n : 'error'; };
/** Message without secrets and without query remains; truncated. */
export function sanitizeMessage(m: unknown): string { const s = String(m instanceof Error ? m.message : m ?? '').replace(/bearer\s+[a-z0-9._~+/=-]+/gi, 'bearer [redacted]').replace(/\?[^\s'"]*/g, '?[query]').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'); return s.slice(0, 300); }
export function framesOf(err: unknown, max = 8): Frame[] | undefined {
  const st = err instanceof Error ? err.stack : undefined; if (!st) return undefined;
  const out: Frame[] = [];
  for (const line of st.split('\n').slice(1)) {
    const m = /at\s+(?:(.+?)\s+\()?([^()]+?)(?::(\d+))?(?::\d+)?\)?\s*$/.exec(line.trim()); if (!m) continue;
    const file = (m[2] ?? '').replace(/\?.*$/, '').split('/').slice(-2).join('/');
    out.push({ function: (m[1] ?? 'anonymous').slice(0, 128), ...(file ? { file: file.slice(0, 240) } : {}), ...(m[3] ? { line: Number(m[3]) } : {}) });
    if (out.length >= max) break;
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
    const { sessionId, captureUnhandled, sanitizeRoute, captureHosts, correlate, detectClient: detect, runtime, routeName, persist, screens, apiRoutes, storage, captureBackground, writes, ...core } = o;
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
      onSendResult: (r, pending) => { if (r === 'retry') this.savePending(); else if (r === 'accepted' && pending === 0) this.clearPending(); } });
    const detected = found.later ? found.later.then((x) => { this.client.setClient({ ...x, ...(o.client ?? {}) }); }).catch(() => undefined) : Promise.resolve();
    this.screens = (screens ?? []).filter((x) => typeof x === 'string' && x.startsWith('/')).slice(0, 300);
    this.routeName = routeName ?? ((u: URL) => screenOf(pathOf(u), this.screens));
    this.trackRoutes();
    // offline on the phone: save unsent events on exit and send them on the next start (everydeck deduplicates)
    const native = ['ios', 'android'].includes(this.client.getClient()?.platform ?? '');
    this.persistOn = (persist ?? (native || !!storage)) && this.client.opts.enabled;
    // restoring can be asynchronous (AsyncStorage): `ready` waits for it, and the first flush after that also sends the old events
    this.ready = Promise.all([detected, this.persistOn ? this.restorePending() : Promise.resolve()]).then(() => undefined);
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
    this.correlate = correlate ?? (() => true);
    if (captureUnhandled !== false && typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('error', (e: unknown) => { const ev = e as { error?: unknown; message?: string }; this.captureUnhandled('browser.unhandled_error', ev.error ?? ev.message); });
      globalThis.addEventListener('unhandledrejection', (e: unknown) => { this.captureUnhandled('browser.unhandled_rejection', (e as { reason?: unknown }).reason); });
      globalThis.addEventListener('pagehide', () => { void this.savePending(); this.client.flushKeepalive(); });
      globalThis.addEventListener('visibilitychange', () => { if ((globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden') { void this.savePending(); this.client.flushKeepalive(); } });
    }
  }
  private persistOn = false;
  private readonly writes: BrowserWrite[];
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
    const key = `${http.method} ${http.route} ${http.status ?? cls} ${page}`; const now = Date.now();
    if ((this.lastBackground.get(key) ?? 0) > now - 30_000) return;
    if (this.lastBackground.size > 200) this.lastBackground.clear();
    this.lastBackground.set(key, now);
    const { sessionId, ...r } = this.ctxRefs(null);
    this.client.error('page.request_failed', cls, { ...r, sessionId, trail: this.trail(), http, message, ...(response ? { response } : {}) });
  }
  private readonly store: StorageAdapter | null;
  private screens: string[] = [];
  private apiRoutes: string[] = [];
  /** Error message without token, query, e-mail and with paths only as patterns (pages and API) */
  private msg(e: unknown): string { return scrubPaths(sanitizeMessage(e), [...this.apiRoutes, ...this.screens]).slice(0, 300); }
  /** Screen change in an app without an address bar (React Navigation, native screens): only the name, never parameters; an address (`/partner/jane-doe`, e.g. from Expo Router's usePathname) is mapped to the patterns */
  /** Pages the app map does not know: once per shape per page life, at most 20; only with declared patterns (otherwise everything is unknown) */
  private unknownScreen(address: string): void {
    if (!this.screens.length || this.unknownSeen.size >= 20) return;
    const segs = segsOf(address); if (!segs.length || bestPattern(segs, this.screens)) return;
    const s = screenShape(address); if (!s || this.unknownSeen.has(s.shape)) return;
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
  private async savePending(): Promise<void> { if (!this.persistOn) return; try { const ev = this.client.exportPending(300); const st = this.storage(); if (!st) return; if (ev.length) await st.setItem(PENDING_KEY, JSON.stringify(ev)); else await st.removeItem(PENDING_KEY); } catch { /* storage full or blocked */ } }
  private async clearPending(): Promise<void> { if (!this.persistOn) return; try { await this.storage()?.removeItem(PENDING_KEY); } catch { /* ignore */ } }
  /** synchronous storage (localStorage) is restored in the constructor, asynchronous storage (AsyncStorage) by `ready` */
  private async restorePending(): Promise<void> {
    try {
      const st = this.storage(); if (!st) return;
      const got = st.getItem(PENDING_KEY); const raw = got instanceof Promise ? await got : got;
      if (!raw) return;
      const rm = st.removeItem(PENDING_KEY); if (rm instanceof Promise) await rm;
      this.client.importPending(JSON.parse(raw));
    } catch { /* corrupt: discard */ }
  }
  /** Known person/organization of this session (a claim; it only becomes authoritative through the server's identity source). */
  setSubject(subjectRef: string | null, accountRef?: string | null): void { this.subject = { ...(subjectRef ? { subjectRef } : {}), ...(accountRef ? { accountRef } : {}) }; }
  /** No ambient async context: use the context passed to action(). */
  currentAction(): ActionContext | null { return null; }
  private ctxRefs(ctx: ActionContext | null) { return { sessionId: this.sessionId, ...(ctx ? { operationId: ctx.operationId, attemptId: ctx.attemptId, ...(ctx.objectType ? { objectType: ctx.objectType } : {}), ...(ctx.objectRef ? { objectRef: ctx.objectRef } : {}), ...(ctx.subjectRef ? { subjectRef: ctx.subjectRef } : {}), ...(ctx.accountRef ? { accountRef: ctx.accountRef } : {}) } : this.subject) }; }
  private captureUnhandled(name: string, err: unknown): void {
    const { sessionId, ...r } = this.ctxRefs(null);
    this.client.error(name, classOf(err), { ...r, sessionId, trail: this.trail(), message: this.msg(err), ...(framesOf(err) ? { frames: framesOf(err)!, contextStatus: 'browser_no_source_maps' as const } : {}) });
  }
  breadcrumb(name: string, fields?: Record<string, string | number | boolean>): void { const { sessionId, ...r } = this.ctxRefs(null); this.client.breadcrumb(name, sessionId, { ...r, ...(fields ? { fields } : {}) }); }
  /**
   * A user action: operation_id/attempt_id, breadcrumbs for start/end, request errors through `ctx.fetch`, thrown errors as `error`
   * (and rethrown). No business success is claimed; that only comes from the server.
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
    } finally { this.failedInAttempt.delete(ctx.attemptId); }
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
    // without an action only the own hosts (captureHosts, otherwise the page's host); never everydeck's own sending
    const background = !ctx && this.client.opts.enabled && !!url && !everydeckOwn && (this.hosts ? this.hosts.includes(url.host) : !!ownHost && url.host === ownHost);
    const capture = this.client.opts.enabled && !!ctx && !!url && (implicit || !this.hosts || this.hosts.includes(url.host));
    let headers: Headers | undefined;
    // Disabled everydeck or an excluded target: the app request stays byte-identical (no extra headers, no CORS preflight caused by everydeck).
    if (capture && this.correlate(url!)) { headers = new Headers(init?.headers ?? req?.headers ?? undefined); headers.set('x-everydeck-operation-id', ctx!.operationId); headers.set('x-everydeck-attempt-id', ctx!.attemptId); headers.set('x-everydeck-session-id', this.sessionId); const pf = this.client.getClient()?.platform; if (pf) headers.set('x-everydeck-platform', pf); }
    const started = Date.now();
    try {
      const res = await (via ?? this.baseFetch)(input, headers ? { ...init, headers } : init);
      if (background && url && res.status >= 400 && !(options?.expect ?? []).includes(res.status) && !(res.status === 401 && !this.subject.subjectRef)) {
        const http: HttpContext = { method, route: this.route(url), status: res.status, durationMs: Date.now() - started };
        void this.answer(res).then((response) => this.backgroundFailure(http, `http_${res.status}`, `HTTP ${res.status} at ${method} ${http.route}`, response));
      }
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
      if (background && url && (e as Error)?.name !== 'AbortError') this.backgroundFailure({ method, route: this.route(url), durationMs: Date.now() - started, ...(crossOrigin ? { crossOrigin } : {}) }, 'network_error', `network error at ${method} ${this.route(url)}`);
      if (capture && url) {
        const { sessionId, ...r } = this.ctxRefs(ctx);
        const aborted = (e as Error).name === 'AbortError';
        this.markFailed(ctx!.attemptId, e, aborted ? 'timeout' : 'network_error');
        this.client.error(`${ctx!.name}.request_failed`, aborted ? 'timeout' : 'network_error', { ...r, sessionId, trail: this.trail(), http: { method, route: this.route(url), durationMs: Date.now() - started, ...(crossOrigin ? { crossOrigin } : {}) }, message: this.msg(e) });
      }
      throw e;
    }
  };
  flush(timeoutMs?: number): Promise<boolean> { return this.client.flush(timeoutMs); }
}

export function initEverydeckBrowser(o: BrowserOptions): EverydeckBrowser { return new EverydeckBrowser(o); }
export type { ClientInfo, HttpContext, EverydeckOptions } from './core.js';
