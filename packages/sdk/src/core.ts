/**
 * @everydeck/sdk – Kern (Transportvertrag 1.1-r0, docs/03/04/05). Läuft in Node ≥ 22, Deno (Supabase Edge Functions) und Browsern; keine
 * Abhängigkeiten, nur `fetch`, `setTimeout`, `AbortController`, `crypto.randomUUID`.
 *
 * Zusagen (wie das Python-SDK, ohne Threads):
 * - `signal()/error()/log()/breadcrumb()/identify()` werfen nie und blockieren nie: O(1) Einreihen in einen begrenzten Puffer (Standard 500).
 * - Übertragung in Batches (≤ 50 Ereignisse, ≤ 64 KiB) mit drei Ergebnissen: angenommen (202) · erneut versuchen (429, 5xx, Timeout,
 *   Netz; derselbe Batch mit derselben batch_id, begrenzter Backoff) · endgültig abgewiesen (400/401/403/409/413/422: Batch verworfen und
 *   gezählt; 401/403 pausieren den Versand). Abgewiesene Batches zählen nie als gesendet.
 * - Pufferüberlauf wird als Ereignis `gap` (buffer_overflow, dropped n) gemeldet – eine erkennbare Datenlücke, keine stille.
 * - Kein Hintergrundthread: der Versand wird per Timer angestoßen, solange Ereignisse anstehen. In kurzlebigen Laufzeiten (Edge Function)
 *   wartet der Aufrufer vor der Antwort auf `flush()`; ohne dieses Warten kann die Laufzeit den Versand unbemerkt abbrechen; dauerhafte Outbox separat verwenden. Das SDK kennt keine Datenbank von everydeck und fällt keine Engine-Urteile.
 */
export const SCHEMA_VERSION = '1.4-r0';
export const BATCH_MAX = 50;
export const BATCH_MAX_BYTES = 64 * 1024;
export const EVENT_MAX_BYTES = 8 * 1024;
const REJECT = new Set([400, 401, 403, 409, 413, 422]);
const AUTH = new Set([401, 403]);

export type LoginMethod = 'password' | 'sso' | 'magic_link';
export interface HttpContext { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'; route: string; status?: number; durationMs: number; /** 1.4-r0 (B33b): Anfrage an einen anderen Host als die Seite */ crossOrigin?: boolean }
export interface Frame { function: string; file?: string; line?: number; /** 1.3-r0: im Code der App */ in_app?: boolean; /** 1.3-r0 (B33): Code-Zeilen um die Zeile */ context?: FrameContext }
export interface FrameContext { first_line: number; pre: string[]; line: string; post: string[] }
export type ContextStatus = 'sent' | 'partial' | 'disabled' | 'unreadable' | 'library_only' | 'frames_without_source' | 'browser_no_source_maps' | 'bundled_runtime';

// ── B33: Code-Zeilen aus dem SDK (wie Sentry). Dieselbe Bereinigung wie Fehlermeldungen in everydeck (packages/contracts scrubText; ein Test prüft die Gleichheit) ──
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
/** Geheimnisse, Bearer-Token und E-Mail-Adressen entfernen (Fehlermeldung oder Code-Zeile) */
export function scrubText(text: string): string {
  let out = String(text).replace(/\bbearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m: string, keep?: string) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}[redacted]` : '[redacted]'));
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
}
export const CONTEXT_FRAMES = 5; export const CONTEXT_LINES = 5; export const CONTEXT_LINE_MAX = 200;
/** Bibliothek, Laufzeit oder Standardbibliothek – kein Code der App */
/** Supabase Edge Functions laufen als kompiliertes Bündel unter diesem Pfad; die Quelldateien sind zur Laufzeit nicht lesbar (B33 Teil E, geprüft) */
const BUNDLED_RUNTIME = /^\/var\/tmp\/sb-compile-edge-runtime\//;
const LIBRARY = /(^|[\\/])node_modules[\\/]|^node:|^internal[\\/]|^ext:|^deno:|^https?:|^<anonymous>|^native$/;
/** Frames aus dem Stack einer Ausnahme (Node, Deno): innerste zuerst; der volle Pfad bleibt nur intern (`_abs`) für die Code-Zeilen */
export function serverFramesOf(err: unknown, max = 20): (Frame & { _abs?: string })[] | undefined {
  const st = err instanceof Error ? err.stack : undefined; if (!st) return undefined;
  const out: (Frame & { _abs?: string })[] = [];
  for (const raw of st.split('\n').slice(1)) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?\s*$/.exec(raw); if (!m) continue;
    let path = m[2]!; if (path.startsWith('file://')) { try { path = decodeURIComponent(new URL(path).pathname); } catch { /* bleibt */ } }
    const inApp = !LIBRARY.test(path) && /^(\/|[A-Za-z]:[\\/])/.test(path);
    const file = path.replace(/\\/g, '/').split('/').slice(-2).join('/');
    out.push({ function: (m[1] ?? 'anonymous').replace(/^async\s+/, '').slice(0, 128) || 'anonymous', ...(file ? { file: file.slice(0, 240) } : {}), line: Number(m[3]), in_app: inApp, ...(inApp ? { _abs: path } : {}) });
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}
/** Fundzeile und je CONTEXT_LINES davor und danach; null, wenn die Zeile nicht in der Datei liegt (nichts raten) */
export function contextOf(text: string, line: number): FrameContext | null {
  const lines = text.split(/\r?\n/); if (line < 1 || line > lines.length) return null;
  const cut = (x: string) => scrubText(x.length > CONTEXT_LINE_MAX ? x.slice(0, CONTEXT_LINE_MAX) : x).slice(0, CONTEXT_LINE_MAX);
  const from = Math.max(1, line - CONTEXT_LINES);
  return { first_line: from, pre: lines.slice(from - 1, line - 1).map(cut), line: cut(lines[line - 1]!), post: lines.slice(line, line + CONTEXT_LINES).map(cut) };
}
/** B23: Herkunft jedes Ereignisses – Plattform, Laufzeit, Version je Plattform, grobes Gerät; nie Gerätemodell oder Kennungen */
export interface ClientInfo { platform: 'web' | 'ios' | 'android' | 'desktop' | 'extension' | 'server'; runtime?: 'browser' | 'capacitor' | 'expo' | 'react_native' | 'flutter' | 'chrome_mv3' | 'electron' | 'tauri' | 'node' | 'deno' | 'python' | 'other'; app_version?: string; build?: string; update_id?: string; channel?: string; os?: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'other'; os_major?: number; device_class?: 'phone' | 'tablet' | 'desktop'; /** B38: Herkunft im Browser (Schema, Host, Port, kein Pfad) – daraus nennt everydeck die Domain der App */ origin?: string }
const CLIENT_KEYS = ['platform', 'runtime', 'app_version', 'build', 'update_id', 'channel', 'os', 'os_major', 'device_class', 'origin'] as const;
const PATTERNS: Partial<Record<(typeof CLIENT_KEYS)[number], RegExp>> = { platform: /^(?:web|ios|android|desktop|extension|server)$/, runtime: /^(?:browser|capacitor|expo|react_native|flutter|chrome_mv3|electron|tauri|node|deno|python|other)$/, os: /^(?:ios|android|macos|windows|linux|chromeos|other)$/, device_class: /^(?:phone|tablet|desktop)$/, origin: /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/, app_version: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/, build: /^[A-Za-z0-9._-]{1,20}$/, update_id: /^[A-Za-z0-9._:-]{1,64}$/, channel: /^[a-z0-9][a-z0-9._-]{0,31}$/ };
/** Nur bekannte Schlüssel und gültige Werte – was nicht passt, fällt weg (lieber keine Angabe als eine falsche) */
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
/** B23: Bildschirm-/Routennamen für den Weg vor einem Fehler – ohne Parameter, ohne Eingaben, höchstens 10 */
export function cleanTrail(t: string[] | undefined): string[] | undefined {
  const out = (t ?? []).map((x) => String(x).replace(/[?#\s].*$/, '').slice(0, 80)).filter(Boolean).slice(-10);
  return out.length ? out : undefined;
}
export interface Refs { /** B23: Weg vor dem Fehler */ trail?: string[]; eventId?: string; occurredAt?: string; operationId?: string; attemptId?: string; subjectRef?: string; accountRef?: string; sessionId?: string; requestId?: string; objectType?: string; objectRef?: string; businessKey?: string; fields?: Record<string, string | number | boolean> }
export interface EverydeckOptions {
  endpoint: string; credential: string; releaseKey: string; manifestDigest: string;
  /** B15/C7: Prüflauf der Einrichtung – alle Batches dieses Clients tragen die Kennung (nur für Verifikationsskripte, nie im App-Betrieb) */
  probeId?: string;
  /** B19: Nutzungszahlen (`usage()`, `search()`) ohne Personenbezug (Standard, cookielos und anonym) oder mit Personenbezug nur nach Einwilligung der Person */
  usageConsent?: 'anonymous' | 'consented';
  enabled?: boolean; maxBuffer?: number; flushIntervalMs?: number; httpTimeoutMs?: number; maxBackoffMs?: number; authPauseMs?: number;
  /** B30 Schnitt D: Batches gzip-komprimiert senden, wo die Laufzeit `CompressionStream` hat (Node ≥ 18, Deno, moderne Browser); Standard an */
  compress?: boolean;
  onWarning?: (message: string) => void; fetch?: typeof fetch; /** Browser: keepalive-Requests beim Verlassen der Seite */ keepalive?: boolean;
  instanceId?: string;
  /** B23: Herkunft der Ereignisse (Browser-SDK erkennt sie selbst; Server-Standard: platform `server`) */
  client?: Partial<ClientInfo>;
  /** B23: Ergebnis jedes Sendevorgangs (`retry` = Netz/5xx, Ereignisse bleiben im Puffer) – das Browser-SDK sichert danach den Puffer */
  onSendResult?: (result: 'accepted' | 'retry' | 'rejected' | 'paused' | 'idle', pending: number) => void;
  /** B33: Code-Zeilen zu den Frames im Code der App mitschicken (Standard an); `false` schaltet es ab */
  sourceContext?: boolean;
  /** B33: liest eine Datei der laufenden App (Node: node:fs, Deno: Deno.readTextFile); null = nicht lesbar. Gelesen wird beim Senden, nie im Aufruf */
  readSource?: (path: string) => Promise<string | null>;
}
export interface EverydeckStats { enqueued: number; accepted: number; retries: number; dropped_overflow: number; dropped_rejected: number; dropped_oversize: number; batches_accepted: number; batches_retried: number; batches_rejected: number; send_errors: number; unreported_loss: number; last_error: string | null; /** B30 Schnitt D */ batches_compressed: number; bytes_raw: number; bytes_sent: number; retry_after_waits: number }
interface Event { event_id: string; kind: 'signal' | 'error' | 'breadcrumb' | 'log' | 'gap'; name: string; occurred_at: string; [k: string]: unknown }
interface Batch { schema_version: string; batch_id: string; release_key: string; manifest_digest: string; probe_id?: string; events: Event[] }

const now = () => new Date().toISOString();
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z0-9_.-]{0,95}$/;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** 1.4-r0 (B33b): Fehlercode und Meldung aus dem Körper einer fehlgeschlagenen Antwort */
export interface ErrorAnswer { code?: string; message?: string }
const ANSWER_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Größte Antwort, deren Körper das SDK liest (danach keine Fakten aus dem Körper) */
export const ANSWER_MAX_BYTES = 65536;
/**
 * B33b: Fakten aus dem Körper einer fehlgeschlagenen Antwort, nur aus bekannten Fehlerformaten (Feldnamen der Formate, keine Deutung von Wörtern):
 * PostgREST/Supabase `{code, message}`, Supabase Auth `{error_code, msg}`, `{error: {code, message}}`, RFC 9457 `{title, detail}`, FastAPI `{detail}`.
 * Nur JSON; die Meldung bereinigt wie Fehlermeldungen (scrubText) und höchstens 300 Zeichen. Nichts Erkennbares → undefined.
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
/** B30 Schnitt D: Backoff mit vollem Zufallsanteil („full jitter“, wie Sentry/PostHog): gleichverteilt in [0, min(cap, 500 ms · 2^n)]. */
export function fullJitterMs(failures: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, 500 * 2 ** Math.max(0, Math.min(6, failures)));
  return Math.floor(random() * ceiling);
}
/** `Retry-After` als Sekunden oder HTTP-Datum → Millisekunden, begrenzt auf eine Stunde; null, wenn fehlt oder unlesbar. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else { const t = Date.parse(v); if (Number.isNaN(t)) return null; ms = t - nowMs; }
  return Math.max(0, Math.min(3_600_000, ms));
}
/** gzip über CompressionStream (Node ≥ 18, Deno, Browser); null, wenn die Laufzeit es nicht kann oder die Kompression scheitert. */
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
  /** B15/C7 */
  readonly probeId: string | undefined;
  /** B23 */
  private client: ClientInfo | undefined;
  /** B23: erkannte Herkunft ergänzen (z. B. App-Version, sobald die native Abfrage antwortet); gilt für alle folgenden Ereignisse */
  setClient(c: Partial<ClientInfo>): void { this.client = cleanClient({ ...(this.client ?? {}), ...c }); }
  getClient(): ClientInfo | undefined { return this.client; }

  constructor(o: EverydeckOptions) {
    this.probeId = o.probeId && /^[0-9a-f-]{36}$/i.test(o.probeId) ? o.probeId : undefined;
    this.opts = { endpoint: (o.endpoint ?? '').replace(/\/$/, ''), credential: o.credential ?? '', releaseKey: o.releaseKey, manifestDigest: o.manifestDigest ?? '', enabled: o.enabled ?? true, maxBuffer: o.maxBuffer ?? 500, flushIntervalMs: o.flushIntervalMs ?? 1000, httpTimeoutMs: o.httpTimeoutMs ?? 2000, maxBackoffMs: o.maxBackoffMs ?? 30_000, authPauseMs: o.authPauseMs ?? 30_000, keepalive: o.keepalive ?? false, compress: o.compress ?? true, usageConsent: o.usageConsent ?? 'anonymous',
      fetch: o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)), onWarning: (m) => { try { if (o.onWarning) o.onWarning(m); else console.warn(`[everydeck] ${m}`); } catch { /* diagnostics never break delivery */ } }, instanceId: o.instanceId ?? `js-${uuid().slice(0, 8)}` };
    // B36: fehlt Adresse oder Schlüssel (z. B. nach einem Update mit neuen Variablennamen), schaltet das SDK ab – aber laut, nie still
    if (this.opts.enabled && (!this.opts.endpoint || !this.opts.credential || !this.opts.manifestDigest)) { this.opts.enabled = false; this.opts.onWarning(`disabled: ${!this.opts.endpoint ? 'no endpoint' : !this.opts.credential ? 'no key' : 'no manifest digest'} – nothing is sent to everydeck until the app passes endpoint, key and manifest digest`); }
    // B23: ohne Browser ist der Absender ein Server (Node oder Deno); das Browser-SDK setzt die erkannte App-Plattform
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
   * B33: Code-Zeilen beim Senden ergänzen (nie im Aufruf). Höchstens CONTEXT_FRAMES Frames im Code der App; das Ereignis bleibt unter
   * EVENT_MAX_BYTES (was nicht passt, bleibt ohne Zeilen: partial). Der volle Pfad (`_abs`) verlässt das SDK nie.
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

  /** Fachliches Signal (nur Server-Schlüssel; Browser-Schlüssel werden vom Server mit 403 abgewiesen). */
  signal(name: string, operationId: string, r: Omit<Refs, 'operationId'> = {}): void { this.enqueue({ event_id: uuid(), kind: 'signal', name, occurred_at: now(), ...refs({ ...r, operationId }) }); }
  /**
   * Fehler. B33: mit `exc` (die abgefangene Ausnahme) bildet das SDK die Frames selbst und schickt beim Senden zu bis zu 5 Frames im Code der App
   * die Code-Zeilen mit (gelesen aus der laufenden Datei, bereinigt); `frames` übergibt sie fertig (dann ohne Code-Zeilen).
   */
  error(name: string, errorClass: string, o: Refs & { message?: string; http?: HttpContext; frames?: Frame[]; exc?: unknown; contextStatus?: ContextStatus; response?: ErrorAnswer } = {}): void {
    const { message, http, frames: given, exc, contextStatus, response, ...r } = o;
    const parsed = given ? undefined : exc !== undefined ? serverFramesOf(exc) : undefined;
    const frames = (given ?? parsed)?.slice(0, 20).map((f) => compact({ function: clip(f.function || 'anonymous', 128), file: f.file ? clip(f.file, 240) : undefined, line: f.line && f.line >= 1 ? Math.round(f.line) : undefined, in_app: typeof f.in_app === 'boolean' ? f.in_app : undefined, _abs: (f as { _abs?: string })._abs }));
    const status: ContextStatus | undefined = !frames?.length ? undefined : contextStatus ?? (!this.sourceContext ? 'disabled' : given ? 'frames_without_source' : undefined);
    // B33b: Fakten aus der Antwort (Code nur im erlaubten Muster, Meldung bereinigt), sonst weggelassen
    const answer = response ? compact({ code: response.code && ANSWER_CODE.test(response.code) ? response.code : undefined, message: response.message ? clip(scrubText(response.message), 300) : undefined }) : {};
    const err = compact({ class: NAME.test(errorClass) ? errorClass : 'error', message: message ? clip(message, 1024) : undefined, frames, context_status: status, response: Object.keys(answer).length ? answer : undefined });
    if (status) for (const f of frames ?? []) delete (f as { _abs?: string })._abs;
    this.enqueue({ event_id: uuid(), kind: 'error', name, occurred_at: now(), error: err, ...compact({ http: httpField(http) }), ...refs(r) });
  }
  log(templateId: string, name: string, r: Refs = {}): void { this.enqueue({ event_id: uuid(), kind: 'log', name, occurred_at: now(), template_id: templateId, ...refs(r) }); }
  /** Browser-Schritt (Behauptung): braucht eine Sitzung; nie Formularwerte, Tokens oder Texte in `fields`. */
  breadcrumb(name: string, sessionId: string, o: Omit<Refs, 'sessionId'> & { http?: HttpContext } = {}): void { const { http, ...r } = o; this.enqueue({ event_id: uuid(), kind: 'breadcrumb', name, occurred_at: now(), session_id: sessionId, ...compact({ http: httpField(http) }), ...refs(r) }); }
  /** Identitätsquelle (nur serverseitig sinnvoll; nur Felder aus `people.fields` des freigegebenen Manifests werden gespeichert). */
  identify(subjectRef: string, o: { accountRef?: string; displayName?: string; email?: string; loginMethod?: LoginMethod; providerUserId?: string; orgName?: string; phone?: string; whatsapp?: string } = {}): void {
    const fields = compact({ display_name: o.displayName, email: o.email, login_method: o.loginMethod, provider_user_id: o.providerUserId, org_name: o.orgName, phone: o.phone, whatsapp: o.whatsapp }) as Record<string, string>;
    this.enqueue({ event_id: uuid(), kind: 'signal', name: 'everydeck.sdk.identity', occurred_at: now(), operation_id: `everydeck.sdk:identity:${subjectRef}`, subject_ref: subjectRef, ...compact({ account_ref: o.accountRef }), ...(Object.keys(fields).length ? { fields } : {}) });
  }
  /**
   * B19: objektbezogene Nutzung – Aufruf, Merken, Kontakt, Erscheinen in Suchergebnissen, Klick aus einer Suche. everydeck zählt Tageszahlen je Objekt.
   * Ohne `usageConsent: 'consented'` wird keine Person mitgeschickt (anonym, ohne Cookie); auch mit Einwilligung nie Text oder Suchbegriffe.
   */
  usage(kind: 'view' | 'save' | 'contact' | 'impression' | 'click', objectType: string, objectRef: string, o: { subjectRef?: string } = {}): void {
    const who = this.opts.usageConsent === 'consented' && o.subjectRef ? { subjectRef: o.subjectRef } : {};
    this.enqueue({ event_id: uuid(), kind: 'signal', name: `everydeck.usage.${kind}`, occurred_at: now(), ...refs({ ...who, operationId: `everydeck.usage:${objectType}`, objectType, objectRef }) });
  }
  /** B19: eine Suche mit ihrer Gruppe (z. B. `area:Sanur`, keine Freitexte) und der Zahl der Treffer – Grundlage für „Suchen ohne Treffer“. */
  search(group: string, results: number, o: { subjectRef?: string } = {}): void {
    const who = this.opts.usageConsent === 'consented' && o.subjectRef ? { subjectRef: o.subjectRef } : {};
    this.enqueue({ event_id: uuid(), kind: 'signal', name: 'everydeck.usage.search', occurred_at: now(), ...refs({ ...who, operationId: 'everydeck.usage:search', fields: { group: clip(group, 120), results: Math.max(0, Math.floor(results)) } }) });
  }
  /**
   * B19 (Moderation, nur Server): Eckdaten einer gesendeten Nachricht – wer, in welchem Gespräch, ob Nummer/Link/Zahlungsbitte enthalten und eine
   * Prüfsumme des Texts (gleiche Nachricht an viele erkennen). Der Text selbst verlässt die App nie.
   */
  messageSent(o: { conversationType: string; conversationRef: string; senderRef: string; text: string; appHosts?: string[] }): void {
    const t = o.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const links = (o.text.match(/https?:\/\/[^\s]+/gi) ?? []).filter((u) => { try { const h = new URL(u).hostname; return !(o.appHosts ?? []).some((a) => h === a || h.endsWith(`.${a}`)); } catch { return false; } });
    this.enqueue({ event_id: uuid(), kind: 'signal', name: 'everydeck.message.sent', occurred_at: now(), ...refs({ operationId: `everydeck.message:${o.conversationType}:${o.conversationRef}`, subjectRef: o.senderRef, objectType: o.conversationType, objectRef: o.conversationRef,
      fields: { text_hash: textHash(t), has_phone: /(?:\+|00)\s?\d[\d\s.-]{8,}\d|\b0\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b|whats\s?app|wa\.me/i.test(o.text), has_link: links.length > 0,
        asks_payment: /\b(?:deposit|down\s?payment|advance payment|pay (?:first|upfront)|bank transfer|wire transfer|western union|uang muka|transfer dulu|tanda jadi|bayar dulu)\b|anzahlung|überweisung|vorkasse/i.test(o.text) } }) });
  }
  /**
   * Lebenszeichen. Ohne `job`: diese Prozessinstanz läuft (instanceId). Mit `job` (1.9-r0, `jobs[].id` im Manifest): dieser Job ist gelaufen –
   * am Ende jedes erfolgreichen Laufs senden; everydeck meldet einen Job, der zwei Takte schweigt. Job-Schläge zählen nicht als Instanz.
   */
  heartbeat(intervalSeconds: number, opts: { job?: string } = {}): void {
    if (opts.job !== undefined && !/^[a-z][a-z0-9_.-]{0,63}$/.test(opts.job)) { this.opts.onWarning(`heartbeat job id rejected: ${opts.job}`); return; }
    this.enqueue({ event_id: uuid(), kind: 'signal', name: 'everydeck.sdk.heartbeat', occurred_at: now(), operation_id: opts.job ? `everydeck.job:${opts.job}` : `everydeck.sdk:${this.opts.instanceId}`, fields: { instance_id: this.opts.instanceId, interval_seconds: intervalSeconds, ...(opts.job ? { job: opts.job } : {}) } });
  }

  /** B23: noch nicht angenommene Ereignisse (zum Zwischenspeichern, wenn eine mobile App beendet wird) */
  exportPending(max = 300): Record<string, unknown>[] { return [...(this.inflight?.events ?? []), ...this.q].slice(0, max).map((e) => ({ ...e })); }
  /** B23: zwischengespeicherte Ereignisse wieder einreihen (mit ihrer ursprünglichen Zeit und Kennung; everydeck dedupliziert über event_id) */
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
    // Node: der Timer soll den Prozess nicht am Ende hindern
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
  /** Ein Sendevorgang; Ergebnis: accepted | retry | rejected | paused | idle. */
  private sendOnce(keepalive = false, deadline = Infinity): Promise<'accepted' | 'retry' | 'rejected' | 'paused' | 'idle'> {
    if (this.request) return this.request;
    const request = this.transmit(keepalive, deadline).then((r) => { if (this.onSendResult && r !== 'idle') { try { this.onSendResult(r, this.q.length + (this.inflight?.events.length ?? 0)); } catch { /* nie die Zustellung stören */ } } return r; }).finally(() => { if (this.request === request) this.request = null; });
    this.request = request;
    return request;
  }
  private async transmit(keepalive: boolean, deadline: number): Promise<'accepted' | 'retry' | 'rejected' | 'paused' | 'idle'> {
    if (Date.now() < this.pausedUntil) return 'paused';
    const batch = this.nextBatch();
    if (!batch) return 'idle';
    try { await this.withSourceContext(batch.events); } catch { /* Code-Zeilen sind nie ein Grund, nicht zu senden */ for (const ev of batch.events) { const e = ev['error'] as { frames?: { _abs?: string }[] } | undefined; for (const f of e?.frames ?? []) delete f._abs; } }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(1, Math.min(this.opts.httpTimeoutMs, deadline - Date.now())));
    let status: number | null = null;
    let retryAfterMs: number | null = null;
    try {
      // B30 Schnitt D: gzip, wo die Laufzeit es kann (CompressionStream); sonst unverändert JSON
      const text = JSON.stringify(batch);
      const gz = this.opts.compress ? await gzipText(text) : null;
      this.stats.bytes_raw += utf8Length(text); this.stats.bytes_sent += gz ? gz.byteLength : utf8Length(text);
      if (gz) this.stats.batches_compressed++;
      const res = await this.opts.fetch(`${this.opts.endpoint}/v1/events`, { method: 'POST', headers: { authorization: `Bearer ${this.opts.credential}`, 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}) }, body: (gz ?? text) as NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>, signal: ctl.signal, ...(keepalive ? { keepalive: true } : {}) });
      status = res.status;
      if (status === 429 || status === 503) retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      try { await res.arrayBuffer(); } catch { /* Körper egal */ }
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
    // B30 Schnitt D: Retry-After von everydeck (429 Budget/Kontingent, 503 Schutz) wird befolgt – bis dahin kein Versuch, auch nicht aus flush()
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
  /** Browser: letzter Versuch beim Verlassen der Seite (keepalive, ohne Warten). */
  flushKeepalive(): void { if (this.pending > 0) void this.sendOnce(true); }
  async close(timeoutMs = 3000): Promise<boolean> { const ok = await this.flush(timeoutMs); this.closed = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } return ok; }
}

export function createEverydeck(o: EverydeckOptions): EverydeckClient { return new EverydeckClient(o); }

/** B19: Prüfsumme eines normalisierten Texts (FNV-1a, 2 × 32 Bit, hex) – erkennt gleiche Nachrichten, verrät den Text nicht im Klartext */
export function textHash(t: string): string {
  let a = 0x811c9dc5; let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < t.length; i++) { const ch = t.charCodeAt(i); a = Math.imul(a ^ ch, 0x01000193) >>> 0; b = Math.imul(b ^ ch, 0x5bd1e995) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
