/**
 * @everydeck/sdk core (transport contract 1.1-r0). Runs in Node >= 22, Deno (Supabase Edge Functions) and browsers; no
 * dependencies, only `fetch`, `setTimeout`, `AbortController`, `crypto.randomUUID`.
 *
 * Guarantees (like the Python SDK, without threads):
 * - `signal()/error()/log()/breadcrumb()/identify()` never throw and never block: O(1) enqueue into a bounded buffer (default 500).
 * - Delivery in batches (<= 50 events, <= 64 KiB) with three outcomes: accepted (202) · retry (429, 5xx, timeout,
 *   network; the same batch with the same batch_id, bounded backoff) · finally rejected (400/401/403/409/413/422: batch dropped and
 *   counted; 401/403 pause sending). Rejected batches never count as sent.
 * - Buffer overflow is reported as a `gap` event (buffer_overflow, dropped n): a visible data gap, not a silent one.
 * - No background thread: sending is triggered by a timer while events are pending. In short-lived runtimes (Edge Function)
 *   the caller awaits `flush()` before responding; without that wait the runtime can cut sending off unnoticed; use the durable outbox separately. The SDK knows no everydeck database and makes no engine judgements.
 */
export const SCHEMA_VERSION = '1.4-r0';
export const BATCH_MAX = 50;
export const BATCH_MAX_BYTES = 64 * 1024;
export const EVENT_MAX_BYTES = 8 * 1024;
const REJECT = new Set([400, 401, 403, 409, 413, 422]);
const AUTH = new Set([401, 403]);

export type LoginMethod = 'password' | 'sso' | 'magic_link';
export interface HttpContext { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'; route: string; status?: number; durationMs: number; /** 1.4-r0: request to a host other than the page */ crossOrigin?: boolean }
export interface Frame { function: string; file?: string; line?: number; /** 1.3-r0: in the app's code */ in_app?: boolean; /** 1.3-r0: code lines around the line */ context?: FrameContext }
export interface FrameContext { first_line: number; pre: string[]; line: string; post: string[] }
export type ContextStatus = 'sent' | 'partial' | 'disabled' | 'unreadable' | 'library_only' | 'frames_without_source' | 'browser_no_source_maps' | 'bundled_runtime';

// ── Code lines from the SDK (like Sentry). The same scrubbing as error messages in everydeck (scrubText; a test checks they are equal) ──
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bevd_[a-z]{3}_[0-9a-f]{40}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /((?:password|passwd|secret|token|api[_-]?key|service[_-]?role[_-]?key)\s*[:=]\s*["']?)(?!\[redacted\])[^\s"']{6,}/gi,
];
/** Removes secrets, Bearer tokens and e-mail addresses (error message or code line) */
export function scrubText(text: string): string {
  let out = String(text).replace(/\bbearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m: string, keep?: string) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}[redacted]` : '[redacted]'));
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
}
export const CONTEXT_FRAMES = 5; export const CONTEXT_LINES = 5; export const CONTEXT_LINE_MAX = 200;
/** Library, runtime or standard library: not the app's code */
/** Supabase Edge Functions run as a compiled bundle under this path; the source files are not readable at runtime (checked) */
const BUNDLED_RUNTIME = /^\/var\/tmp\/sb-compile-edge-runtime\//;
const LIBRARY = /(^|[\\/])node_modules[\\/]|^node:|^internal[\\/]|^ext:|^deno:|^https?:|^<anonymous>|^native$/;
/** Frames from an exception's stack (Node, Deno): innermost first; the full path stays internal only (`_abs`) for the code lines */
export function serverFramesOf(err: unknown, max = 20): (Frame & { _abs?: string })[] | undefined {
  const st = err instanceof Error ? err.stack : undefined; if (!st) return undefined;
  const out: (Frame & { _abs?: string })[] = [];
  for (const raw of st.split('\n').slice(1)) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?\s*$/.exec(raw); if (!m) continue;
    let path = m[2]!; if (path.startsWith('file://')) { try { path = decodeURIComponent(new URL(path).pathname); } catch { /* keep as is */ } }
    const inApp = !LIBRARY.test(path) && /^(\/|[A-Za-z]:[\\/])/.test(path);
    const file = path.replace(/\\/g, '/').split('/').slice(-2).join('/');
    out.push({ function: (m[1] ?? 'anonymous').replace(/^async\s+/, '').slice(0, 128) || 'anonymous', ...(file ? { file: file.slice(0, 240) } : {}), line: Number(m[3]), in_app: inApp, ...(inApp ? { _abs: path } : {}) });
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}
/** The line plus CONTEXT_LINES before and after it; null when the line is not in the file (no guessing) */
export function contextOf(text: string, line: number): FrameContext | null {
  const lines = text.split(/\r?\n/); if (line < 1 || line > lines.length) return null;
  const cut = (x: string) => scrubText(x.length > CONTEXT_LINE_MAX ? x.slice(0, CONTEXT_LINE_MAX) : x).slice(0, CONTEXT_LINE_MAX);
  const from = Math.max(1, line - CONTEXT_LINES);
  return { first_line: from, pre: lines.slice(from - 1, line - 1).map(cut), line: cut(lines[line - 1]!), post: lines.slice(line, line + CONTEXT_LINES).map(cut) };
}
/** Origin of every event: platform, runtime, version per platform, rough device class; never device model or identifiers */
export interface ClientInfo { platform: 'web' | 'ios' | 'android' | 'desktop' | 'extension' | 'server'; runtime?: 'browser' | 'capacitor' | 'expo' | 'react_native' | 'flutter' | 'chrome_mv3' | 'electron' | 'tauri' | 'node' | 'deno' | 'python' | 'other'; app_version?: string; build?: string; update_id?: string; channel?: string; os?: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'other'; os_major?: number; device_class?: 'phone' | 'tablet' | 'desktop'; /** origin in the browser (scheme, host, port, no path); everydeck derives the app's domain from it */ origin?: string }
const CLIENT_KEYS = ['platform', 'runtime', 'app_version', 'build', 'update_id', 'channel', 'os', 'os_major', 'device_class', 'origin'] as const;
const PATTERNS: Partial<Record<(typeof CLIENT_KEYS)[number], RegExp>> = { platform: /^(?:web|ios|android|desktop|extension|server)$/, runtime: /^(?:browser|capacitor|expo|react_native|flutter|chrome_mv3|electron|tauri|node|deno|python|other)$/, os: /^(?:ios|android|macos|windows|linux|chromeos|other)$/, device_class: /^(?:phone|tablet|desktop)$/, origin: /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/, app_version: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/, build: /^[A-Za-z0-9._-]{1,20}$/, update_id: /^[A-Za-z0-9._:-]{1,64}$/, channel: /^[a-z0-9][a-z0-9._-]{0,31}$/ };
/** Known keys and valid values only; anything else is dropped (better no value than a wrong one) */
export function cleanClient(c: Partial<ClientInfo> | null | undefined): ClientInfo | undefined {
  if (!c || !c.platform) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of CLIENT_KEYS) {
    const v = (c as Record<string, unknown>)[k]; if (v === undefined || v === null || v === '') continue;
    if (k === 'os_major') { const n = Math.floor(Number(v)); if (Number.isFinite(n) && n >= 0 && n <= 999) out[k] = n; continue; }
    const sv = String(v); const re = PATTERNS[k]; if (re && !re.test(sv)) continue; out[k] = sv;
  }
  return out['platform'] ? out as unknown as ClientInfo : undefined;
}
/** Screen or route names for the path before an error: no parameters, no input, at most 10 */
export function cleanTrail(t: string[] | undefined): string[] | undefined {
  const out = (t ?? []).map((x) => String(x).replace(/[?#\s].*$/, '').slice(0, 80)).filter(Boolean).slice(-10);
  return out.length ? out : undefined;
}
export interface Refs { /** path before the error */ trail?: string[]; eventId?: string; occurredAt?: string; operationId?: string; attemptId?: string; subjectRef?: string; accountRef?: string; sessionId?: string; requestId?: string; objectType?: string; objectRef?: string; businessKey?: string; fields?: Record<string, string | number | boolean> }
export interface EverydeckOptions {
  endpoint: string; credential: string; releaseKey: string; manifestDigest: string;
  /** setup check run: all batches of this client carry the id (only for verification scripts, never in app operation) */
  probeId?: string;
  /** usage counts (`usage()`, `search()`) without personal reference (default, cookieless and anonymous), or with personal reference only after the person's consent */
  usageConsent?: 'anonymous' | 'consented';
  enabled?: boolean; maxBuffer?: number; flushIntervalMs?: number; httpTimeoutMs?: number; maxBackoffMs?: number; authPauseMs?: number;
  /** send batches gzip-compressed where the runtime has `CompressionStream` (Node >= 18, Deno, modern browsers); on by default */
  compress?: boolean;
  onWarning?: (message: string) => void; fetch?: typeof fetch; /** browser: keepalive requests when leaving the page */ keepalive?: boolean;
  instanceId?: string;
  /** origin of the events (the browser SDK detects it itself; server default: platform `server`) */
  client?: Partial<ClientInfo>;
  /** result of every send (`retry` = network/5xx, events stay in the buffer); the browser SDK saves the buffer afterwards */
  onSendResult?: (result: 'accepted' | 'retry' | 'rejected' | 'paused' | 'idle', pending: number) => void;
  /** send code lines for frames in the app's code (on by default); `false` turns it off */
  sourceContext?: boolean;
  /** reads a file of the running app (Node: node:fs, Deno: Deno.readTextFile); null = not readable. Read when sending, never during the call */
  readSource?: (path: string) => Promise<string | null>;
}
export interface EverydeckStats { enqueued: number; accepted: number; retries: number; dropped_overflow: number; dropped_rejected: number; dropped_oversize: number; batches_accepted: number; batches_retried: number; batches_rejected: number; send_errors: number; unreported_loss: number; last_error: string | null; /** compression */ batches_compressed: number; bytes_raw: number; bytes_sent: number; retry_after_waits: number }
interface Event { event_id: string; kind: 'signal' | 'error' | 'breadcrumb' | 'log' | 'gap'; name: string; occurred_at: string; [k: string]: unknown }
interface Batch { schema_version: string; batch_id: string; release_key: string; manifest_digest: string; probe_id?: string; events: Event[] }

const now = () => new Date().toISOString();
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z0-9_.-]{0,95}$/;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** 1.4-r0: error code and message from the body of a failed response */
export interface ErrorAnswer { code?: string; message?: string }
const ANSWER_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Largest response whose body the SDK reads (beyond it, no facts from the body) */
export const ANSWER_MAX_BYTES = 65536;
/**
 * Facts from the body of a failed response, only from known error formats (the formats' field names, no interpretation of words):
 * PostgREST/Supabase `{code, message}`, Supabase Auth `{error_code, msg}`, `{error: {code, message}}`, RFC 9457 `{title, detail}`, FastAPI `{detail}`.
 * JSON only; the message is scrubbed like error messages (scrubText) and at most 300 characters. Nothing recognizable → undefined.
 */
export function answerOf(body: string, contentType: string | null | undefined): ErrorAnswer | undefined {
  if (!body || !/json/i.test(contentType ?? '') || body.length > ANSWER_MAX_BYTES) return undefined;
  let j: unknown; try { j = JSON.parse(body); } catch { return undefined; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const o = j as Record<string, unknown>;
  const nested = o['error'] && typeof o['error'] === 'object' && !Array.isArray(o['error']) ? (o['error'] as Record<string, unknown>) : null;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
  const code = [str(o['code']), str(o['error_code']), nested ? str(nested['code']) : undefined].find((c) => c !== undefined && ANSWER_CODE.test(c));
  const message = str(o['message']) ?? str(o['msg']) ?? (nested ? str(nested['message']) : undefined) ?? str(o['detail']) ?? str(o['title']) ?? (typeof o['error'] === 'string' ? str(o['error']) : undefined);
  const a = compact({ code, message: message ? clip(scrubText(message), 300) : undefined }) as ErrorAnswer;
  return a.code || a.message ? a : undefined;
}
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const utf8Length = (t: string) => new TextEncoder().encode(t).byteLength;
/** Backoff with full jitter (like Sentry/PostHog): uniformly distributed in [0, min(cap, 500 ms · 2^n)]. */
export function fullJitterMs(failures: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, 500 * 2 ** Math.max(0, Math.min(6, failures)));
  return Math.floor(random() * ceiling);
}
/** `Retry-After` as seconds or HTTP date → milliseconds, capped at one hour; null when missing or unreadable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else { const t = Date.parse(v); if (Number.isNaN(t)) return null; ms = t - nowMs; }
  return Math.max(0, Math.min(3_600_000, ms));
}
/** gzip via CompressionStream (Node >= 18, Deno, browsers); null when the runtime cannot do it or compression fails. */
export async function gzipText(text: string): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).CompressionStream;
  if (!CS) return null;
  try {
    const cs = new CS('gzip');
    const writer = cs.writable.getWriter();
    void writer.write(new TextEncoder().encode(text)).then(() => writer.close());
    const chunks: Uint8Array[] = []; let n = 0;
    const reader = cs.readable.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); n += value.byteLength; }
    const out = new Uint8Array(n); let off = 0; for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } catch { return null; }
}

function compact(obj: Record<string, unknown>): Record<string, unknown> { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') o[k] = v; return o; }
function refs(r: Refs | undefined): Record<string, unknown> {
  if (!r) return {};
  const fields = r.fields ? Object.fromEntries(Object.entries(r.fields).slice(0, 32).filter(([k]) => NAME.test(k)).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 256) : v])) : undefined;
  const trail = cleanTrail(r.trail);
  return { ...(trail ? { trail } : {}), ...(r.eventId !== undefined ? {event_id: r.eventId} : {}), ...(r.occurredAt !== undefined ? {occurred_at: r.occurredAt} : {}), ...compact({ operation_id: r.operationId, attempt_id: r.attemptId, subject_ref: r.subjectRef, account_ref: r.accountRef, session_id: r.sessionId, request_id: r.requestId, object_type: r.objectType, object_ref: r.objectRef, business_key: r.businessKey, fields: fields && Object.keys(fields).length ? fields : undefined }) };
}
export function httpField(h: HttpContext | undefined): Record<string, unknown> | undefined {
  if (!h) return undefined;
  return compact({ method: h.method, route: clip(h.route, 240), status: h.status, duration_ms: Math.max(0, Math.min(86_400_000, Math.round(h.durationMs))), cross_origin: h.crossOrigin === true ? true : undefined });
}

export class EverydeckClient {
  readonly opts: Required<Pick<EverydeckOptions, 'endpoint' | 'credential' | 'releaseKey' | 'manifestDigest' | 'enabled' | 'maxBuffer' | 'flushIntervalMs' | 'httpTimeoutMs' | 'maxBackoffMs' | 'authPauseMs' | 'keepalive' | 'compress'>> & { fetch: typeof fetch; onWarning: (m: string) => void; instanceId: string; usageConsent: 'anonymous' | 'consented' };
  readonly stats: EverydeckStats = { enqueued: 0, accepted: 0, retries: 0, dropped_overflow: 0, dropped_rejected: 0, dropped_oversize: 0, batches_accepted: 0, batches_retried: 0, batches_rejected: 0, send_errors: 0, unreported_loss: 0, last_error: null, batches_compressed: 0, bytes_raw: 0, bytes_sent: 0, retry_after_waits: 0 };
  private q: Event[] = [];
  private inflight: Batch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  private request: Promise<'accepted' | 'retry' | 'rejected' | 'paused' | 'idle'> | null = null;
  private readonly onSendResult: EverydeckOptions['onSendResult'];
  private pausedUntil = 0;
  private failures = 0;
  private closed = false;
  /** setup check run id */
  readonly probeId: string | undefined;
  /** origin of the events */
  private client: ClientInfo | undefined;
  /** Adds detected origin details (e.g. the app version once the native query answers); applies to all following events */
  setClient(c: Partial<ClientInfo>): void { this.client = cleanClient({ ...(this.client ?? {}), ...c }); }
  getClient(): ClientInfo | undefined { return this.client; }

  constructor(o: EverydeckOptions) {
    this.probeId = o.probeId && /^[0-9a-f-]{36}$/i.test(o.probeId) ? o.probeId : undefined;
    this.opts = { endpoint: (o.endpoint ?? '').replace(/\/$/, ''), credential: o.credential ?? '', releaseKey: o.releaseKey, manifestDigest: o.manifestDigest ?? '', enabled: o.enabled ?? true, maxBuffer: o.maxBuffer ?? 500, flushIntervalMs: o.flushIntervalMs ?? 1000, httpTimeoutMs: o.httpTimeoutMs ?? 2000, maxBackoffMs: o.maxBackoffMs ?? 30_000, authPauseMs: o.authPauseMs ?? 30_000, keepalive: o.keepalive ?? false, compress: o.compress ?? true, usageConsent: o.usageConsent ?? 'anonymous',
      fetch: o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)), onWarning: (m) => { try { if (o.onWarning) o.onWarning(m); else console.warn(`[everydeck] ${m}`); } catch { /* diagnostics never break delivery */ } }, instanceId: o.instanceId ?? `js-${uuid().slice(0, 8)}` };
    // if the address or key is missing (e.g. after an update with new variable names), the SDK turns itself off, but loudly, never silently
    if (this.opts.enabled && (!this.opts.endpoint || !this.opts.credential || !this.opts.manifestDigest)) { this.opts.enabled = false; this.opts.onWarning(`disabled: ${!this.opts.endpoint ? 'no endpoint' : !this.opts.credential ? 'no key' : 'no manifest digest'}; nothing is sent to everydeck until the app passes endpoint, key and manifest digest`); }
    // without a browser the sender is a server (Node or Deno); the browser SDK sets the detected app platform
    const g = globalThis as { document?: unknown; Deno?: unknown };
    this.client = cleanClient(o.client ?? (g.document ? undefined : { platform: 'server', runtime: g.Deno ? 'deno' : 'node' }));
    this.onSendResult = o.onSendResult;
    this.sourceContext = o.sourceContext !== false;
    const deno = (globalThis as { Deno?: { readTextFile?: (p: string) => Promise<string> } }).Deno;
    this.readSource = o.readSource ?? (deno?.readTextFile ? async (p: string) => { try { return await deno.readTextFile!(p); } catch { return null; } } : null);
  }
  private readonly sourceContext: boolean;
  private readonly readSource: ((path: string) => Promise<string | null>) | null;
  private readonly sourceCache = new Map<string, Promise<string | null>>();
  /**
   * Adds code lines when sending (never during the call). At most CONTEXT_FRAMES frames in the app's code; the event stays under
   * EVENT_MAX_BYTES (what does not fit stays without lines: partial). The full path (`_abs`) never leaves the SDK.
   */
  private async withSourceContext(events: Event[]): Promise<void> {
    for (const ev of events) {
      const err = ev['error'] as { frames?: (Frame & { _abs?: string })[]; context_status?: ContextStatus } | undefined;
      if (!err?.frames?.length || err.context_status) continue;
      const app = err.frames.filter((f) => f.in_app && f._abs && f.line).slice(0, CONTEXT_FRAMES);
      let read = 0; let cut = 0;
      if (!this.sourceContext) err.context_status = 'disabled';
      else if (!app.length) err.context_status = 'library_only';
      else if (app.every((f) => BUNDLED_RUNTIME.test(f._abs!))) err.context_status = 'bundled_runtime';
      else {
        for (const f of app) {
          const p = f._abs!; if (!this.sourceCache.has(p)) this.sourceCache.set(p, this.readSource ? this.readSource(p).catch(() => null) : Promise.resolve(null));
          const text = await this.sourceCache.get(p)!; const ctx = text === null ? null : contextOf(text, f.line!);
          if (!ctx) continue; read++;
          f.context = ctx; if (size(ev) > EVENT_MAX_BYTES - 256) { delete f.context; cut++; }
        }
        err.context_status = read === 0 ? 'unreadable' : cut ? 'partial' : 'sent';
      }
      for (const f of err.frames) delete f._abs;
    }
  }

  /** Business signal (server key only; the server rejects browser keys with 403). */
  signal(name: string, operationId: string, r: Omit<Refs, 'operationId'> = {}): void { this.enqueue({ event_id: uuid(), kind: 'signal', name, occurred_at: now(), ...refs({ ...r, operationId }) }); }
  /**
   * Error. With `exc` (the caught exception) the SDK builds the frames itself and, when sending, adds the code lines for up to 5 frames in the app's code
   * (read from the running file, scrubbed); `frames` passes them ready-made (then without code lines).
   */
  error(name: string, errorClass: string, o: Refs & { message?: string; http?: HttpContext; frames?: Frame[]; exc?: unknown; contextStatus?: ContextStatus; response?: ErrorAnswer } = {}): void {
    const { message, http, frames: given, exc, contextStatus, response, ...r } = o;
    const parsed = given ? undefined : exc !== undefined ? serverFramesOf(exc) : undefined;
    const frames = (given ?? parsed)?.slice(0, 20).map((f) => compact({ function: clip(f.function || 'anonymous', 128), file: f.file ? clip(f.file, 240) : undefined, line: f.line && f.line >= 1 ? Math.round(f.line) : undefined, in_app: typeof f.in_app === 'boolean' ? f.in_app : undefined, _abs: (f as { _abs?: string })._abs }));
    const status: ContextStatus | undefined = !frames?.length ? undefined : contextStatus ?? (!this.sourceContext ? 'disabled' : given ? 'frames_without_source' : undefined);
    // facts from the response (code only in the allowed pattern, message scrubbed), otherwise left out
    const answer = response ? compact({ code: response.code && ANSWER_CODE.test(response.code) ? response.code : undefined, message: response.message ? clip(scrubText(response.message), 300) : undefined }) : {};
    const err = compact({ class: NAME.test(errorClass) ? errorClass : 'error', message: message ? clip(message, 1024) : undefined, frames, context_status: status, response: Object.keys(answer).length ? answer : undefined });
    if (status) for (const f of frames ?? []) delete (f as { _abs?: string })._abs;
    this.enqueue({ event_id: uuid(), kind: 'error', name, occurred_at: now(), error: err, ...compact({ http: httpField(http) }), ...refs(r) });
  }
  log(templateId: string, name: string, r: Refs = {}): void { this.enqueue({ event_id: uuid(), kind: 'log', name, occurred_at: now(), template_id: templateId, ...refs(r) }); }
  /** Browser step (a claim): needs a session; never form values, tokens or texts in `fields`. */
  breadcrumb(name: string, sessionId: string, o: Omit<Refs, 'sessionId'> & { http?: HttpContext } = {}): void { const { http, ...r } = o; this.enqueue({ event_id: uuid(), kind: 'breadcrumb', name, occurred_at: now(), session_id: sessionId, ...compact({ http: httpField(http) }), ...refs(r) }); }
  /** Identity source (only meaningful on the server; only fields from `people.fields` of the approved manifest are stored). */
  identify(subjectRef: string, o: { accountRef?: string; displayName?: string; email?: string; loginMethod?: LoginMethod; providerUserId?: string; orgName?: string; phone?: string; whatsapp?: string } = {}): void {
    const fields = compact({ display_name: o.displayName, email: o.email, login_method: o.loginMethod, provider_user_id: o.providerUserId, org_name: o.orgName, phone: o.phone, whatsapp: o.whatsapp }) as Record<string, string>;
    this.enqueue({ event_id: uuid(), kind: 'signal', name: 'everydeck.sdk.identity', occurred_at: now(), operation_id: `everydeck.sdk:identity:${subjectRef}`, subject_ref: subjectRef, ...compact({ account_ref: o.accountRef }), ...(Object.keys(fields).length ? { fields } : {}) });
  }
  /**
   * Object usage: view, save, contact, appearing in search results, click from a search. everydeck counts daily numbers per object.
   * Without `usageConsent: 'consented'` no person is sent (anonymous, no cookie); even with consent never text or search terms.
   */
  usage(kind: 'view' | 'save' | 'contact' | 'impression' | 'click', objectType: string, objectRef: string, o: { subjectRef?: string } = {}): void {
    const who = this.opts.usageConsent === 'consented' && o.subjectRef ? { subjectRef: o.subjectRef } : {};
    this.enqueue({ event_id: uuid(), kind: 'signal', name: `everydeck.usage.${kind}`, occurred_at: now(), ...refs({ ...who, operationId: `everydeck.usage:${objectType}`, objectType, objectRef }) });
  }
  /** A search with its group (e.g. `area:downtown`, no free text) and the number of results; the basis for "searches without results". */
  search(group: string, results: number, o: { subjectRef?: string } = {}): void {
    const who = this.opts.usageConsent === 'consented' && o.subjectRef ? { subjectRef: o.subjectRef } : {};
    this.enqueue({ event_id: uuid(), kind: 'signal', name: 'everydeck.usage.search', occurred_at: now(), ...refs({ ...who, operationId: 'everydeck.usage:search', fields: { group: clip(group, 120), results: Math.max(0, Math.floor(results)) } }) });
  }
  /**
   * Moderation (server only): key facts of a sent message: who, in which conversation, whether it contains a number, link or payment request, and a
   * checksum of the text (to spot the same message sent to many). The text itself never leaves the app.
   */
  messageSent(o: { conversationType: string; conversationRef: string; senderRef: string; text: string; appHosts?: string[] }): void {
    const t = o.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const links = (o.text.match(/https?:\/\/[^\s]+/gi) ?? []).filter((u) => { try { const h = new URL(u).hostname; return !(o.appHosts ?? []).some((a) => h === a || h.endsWith(`.${a}`)); } catch { return false; } });
    this.enqueue({ event_id: uuid(), kind: 'signal', name: 'everydeck.message.sent', occurred_at: now(), ...refs({ operationId: `everydeck.message:${o.conversationType}:${o.conversationRef}`, subjectRef: o.senderRef, objectType: o.conversationType, objectRef: o.conversationRef,
      fields: { text_hash: textHash(t), has_phone: /(?:\+|00)\s?\d[\d\s.-]{8,}\d|\b0\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b|whats\s?app|wa\.me/i.test(o.text), has_link: links.length > 0,
        asks_payment: /\b(?:deposit|down\s?payment|advance payment|pay (?:first|upfront)|bank transfer|wire transfer|western union|uang muka|transfer dulu|tanda jadi|bayar dulu)\b|anzahlung|überweisung|vorkasse/i.test(o.text) } }) });
  }
  /**
   * Heartbeat. Without `job`: this process instance is running (instanceId). With `job` (1.9-r0, `jobs[].id` in the manifest): this job has run;
   * send it at the end of every successful run; everydeck reports a job that stays silent for two intervals. Job heartbeats do not count as an instance.
   */
  heartbeat(intervalSeconds: number, opts: { job?: string } = {}): void {
    if (opts.job !== undefined && !/^[a-z][a-z0-9_.-]{0,63}$/.test(opts.job)) { this.opts.onWarning(`heartbeat job id rejected: ${opts.job}`); return; }
    this.enqueue({ event_id: uuid(), kind: 'signal', name: 'everydeck.sdk.heartbeat', occurred_at: now(), operation_id: opts.job ? `everydeck.job:${opts.job}` : `everydeck.sdk:${this.opts.instanceId}`, fields: { instance_id: this.opts.instanceId, interval_seconds: intervalSeconds, ...(opts.job ? { job: opts.job } : {}) } });
  }

  /** Events not yet accepted (for saving when a mobile app is closed) */
  exportPending(max = 300): Record<string, unknown>[] { return [...(this.inflight?.events ?? []), ...this.q].slice(0, max).map((e) => ({ ...e })); }
  /** Re-enqueues saved events (with their original time and id; everydeck deduplicates by event_id) */
  importPending(events: unknown): number {
    if (!Array.isArray(events)) return 0; let n = 0;
    for (const e of events.slice(0, this.opts.maxBuffer)) if (e && typeof e === 'object' && typeof (e as Event).event_id === 'string' && typeof (e as Event).name === 'string') { this.enqueue(e as Event); n++; }
    return n;
  }
  get pending(): number { return this.q.length + (this.inflight?.events.length ?? 0) + (this.stats.unreported_loss ? 1 : 0); }

  private enqueue(ev: Event): void {
    if (!this.opts.enabled || this.closed) return;
    try {
      if (!UUID_RE.test(ev.event_id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(ev.occurred_at) || !Number.isFinite(Date.parse(ev.occurred_at))) { this.stats.dropped_oversize++; return; }
      if (!NAME.test(ev.name)) { this.stats.dropped_oversize++; this.opts.onWarning(`event name rejected: ${ev.name}`); return; }
      if (this.client && !ev['client']) ev['client'] = this.client;
      if (size(ev) > EVENT_MAX_BYTES) { this.stats.dropped_oversize++; this.opts.onWarning(`event too large: ${ev.name}`); return; }
      if (this.q.length >= this.opts.maxBuffer) { this.stats.dropped_overflow++; this.stats.unreported_loss++; return; }
      this.q.push(ev); this.stats.enqueued++;
      this.schedule(this.opts.flushIntervalMs);
    } catch (e) { this.stats.send_errors++; this.stats.last_error = String((e as Error).message); }
  }
  private schedule(ms: number): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, Math.max(0, ms));
    // Node: the timer must not keep the process from exiting
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private nextBatch(): Batch | null {
    if (this.inflight) return this.inflight;
    if (this.stats.unreported_loss && this.q.length < this.opts.maxBuffer) {
      this.q.push({event_id: uuid(), kind: 'gap', name: 'everydeck.sdk.loss', occurred_at: now(), gap: {cause: 'buffer_overflow', dropped: this.stats.unreported_loss}});
      this.stats.unreported_loss = 0;
    }
    if (!this.q.length) return null;
    const batch: Batch = {schema_version: SCHEMA_VERSION, batch_id: uuid(), release_key: this.opts.releaseKey, manifest_digest: this.opts.manifestDigest, ...(this.probeId ? { probe_id: this.probeId } : {}), events: []};
    while (this.q.length && batch.events.length < BATCH_MAX) {
      const ev = this.q[0]!;
      if (size({...batch, events: [...batch.events, ev]}) > BATCH_MAX_BYTES) {
        if (batch.events.length) break;
        this.q.shift(); this.stats.dropped_oversize++; continue;
      }
      batch.events.push(this.q.shift()!);
    }
    this.inflight = batch.events.length ? batch : null;
    return this.inflight;
  }
  /** One send; result: accepted | retry | rejected | paused | idle. */
  private sendOnce(keepalive = false, deadline = Infinity): Promise<'accepted' | 'retry' | 'rejected' | 'paused' | 'idle'> {
    if (this.request) return this.request;
    const request = this.transmit(keepalive, deadline).then((r) => { if (this.onSendResult && r !== 'idle') { try { this.onSendResult(r, this.q.length + (this.inflight?.events.length ?? 0)); } catch { /* never disturb delivery */ } } return r; }).finally(() => { if (this.request === request) this.request = null; });
    this.request = request;
    return request;
  }
  private async transmit(keepalive: boolean, deadline: number): Promise<'accepted' | 'retry' | 'rejected' | 'paused' | 'idle'> {
    if (Date.now() < this.pausedUntil) return 'paused';
    const batch = this.nextBatch();
    if (!batch) return 'idle';
    try { await this.withSourceContext(batch.events); } catch { /* code lines are never a reason not to send */ for (const ev of batch.events) { const e = ev['error'] as { frames?: { _abs?: string }[] } | undefined; for (const f of e?.frames ?? []) delete f._abs; } }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(1, Math.min(this.opts.httpTimeoutMs, deadline - Date.now())));
    let status: number | null = null;
    let retryAfterMs: number | null = null;
    try {
      // gzip where the runtime can (CompressionStream); otherwise plain JSON
      const text = JSON.stringify(batch);
      const gz = this.opts.compress ? await gzipText(text) : null;
      this.stats.bytes_raw += utf8Length(text); this.stats.bytes_sent += gz ? gz.byteLength : utf8Length(text);
      if (gz) this.stats.batches_compressed++;
      const res = await this.opts.fetch(`${this.opts.endpoint}/v1/events`, { method: 'POST', headers: { authorization: `Bearer ${this.opts.credential}`, 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}) }, body: (gz ?? text) as NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>, signal: ctl.signal, ...(keepalive ? { keepalive: true } : {}) });
      status = res.status;
      if (status === 429 || status === 503) retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      try { await res.arrayBuffer(); } catch { /* body does not matter */ }
    } catch (e) {
      this.stats.last_error = (e as Error).name === 'AbortError' ? 'timeout' : `network: ${(e as Error).message}`;
    } finally { clearTimeout(t); }
    if (status === 202) { this.stats.accepted += batch.events.length; this.stats.batches_accepted++; this.inflight = null; this.failures = 0; return 'accepted'; }
    if (status !== null && REJECT.has(status)) {
      this.stats.dropped_rejected += batch.events.length; this.stats.batches_rejected++; this.inflight = null; this.stats.last_error = `rejected ${status}`;
      this.opts.onWarning(`batch rejected by everydeck (${status}); ${batch.events.length} events dropped`);
      if (AUTH.has(status)) this.pausedUntil = Date.now() + this.opts.authPauseMs;
      return 'rejected';
    }
    this.stats.retries++; this.stats.batches_retried++; this.failures++;
    if (status !== null) this.stats.last_error = `retry after ${status}`;
    // Retry-After from everydeck (429 budget/quota, 503 protection) is honored: no attempt until then, not even from flush()
    if (retryAfterMs !== null) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + retryAfterMs); this.stats.retry_after_waits++; }
    return 'retry';
  }
  private async pump(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      for (;;) {
        const r = await this.sendOnce();
        if (r === 'accepted' || r === 'rejected') continue;
        if (r === 'retry') { this.schedule(Math.max(this.pausedUntil - Date.now(), fullJitterMs(this.failures, this.opts.maxBackoffMs))); break; }
        if (r === 'paused') { this.schedule(this.pausedUntil - Date.now()); break; }
        break;   // idle
      }
    })().finally(() => { this.sending = null; });
    return this.sending;
  }
  /** true: queued data drained with no rejection during this call. False: pending, deadline, or rejected data; inspect stats. */
  async flush(timeoutMs = 3000): Promise<boolean> {
    if (!this.opts.enabled) return true;
    const end = Date.now() + Math.max(0, timeoutMs);
    const rejected = this.stats.dropped_rejected + this.stats.dropped_oversize;
    while (this.pending > 0 && Date.now() < end) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([this.sendOnce(false, end), new Promise<'deadline'>(resolve => {timer = setTimeout(() => resolve('deadline'), Math.max(0, end - Date.now()));})]);
      if (timer) clearTimeout(timer);
      if (result === 'deadline') return false;
      if (result === 'retry' || result === 'paused') await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, end - Date.now()))));
    }
    return this.pending === 0 && rejected === this.stats.dropped_rejected + this.stats.dropped_oversize;
  }
  /** Browser: last attempt when leaving the page (keepalive, no waiting). */
  flushKeepalive(): void { if (this.pending > 0) void this.sendOnce(true); }
  async close(timeoutMs = 3000): Promise<boolean> { const ok = await this.flush(timeoutMs); this.closed = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } return ok; }
}

export function createEverydeck(o: EverydeckOptions): EverydeckClient { return new EverydeckClient(o); }

/** Checksum of a normalized text (FNV-1a, 2 × 32 bit, hex): spots identical messages without revealing the text in plain form */
export function textHash(t: string): string {
  let a = 0x811c9dc5; let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < t.length; i++) { const ch = t.charCodeAt(i); a = Math.imul(a ^ ch, 0x01000193) >>> 0; b = Math.imul(b ^ ch, 0x5bd1e995) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
