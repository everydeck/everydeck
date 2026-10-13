/**
 * Verification helper for bridges: everydeck signs every call to a read bridge or app bridge (like Stripe).
 *   X-Everydeck-Timestamp (Unix seconds), X-Everydeck-Request-Id (UUID), X-Everydeck-Signature (v1=<hex>[,v1=<hex>], one per valid key).
 *   Signature = HMAC-SHA256(key, "EVERYDECK-V1\n" + METHOD + "\n" + path from /everydeck/ with query + "\n" + timestamp + "\n" + request_id + "\n" + SHA-256(body) hex).
 * The app rejects a call when the timestamp is older (or newer) than 5 minutes or the request_id was already seen within that time.
 * The signature's request_id (X-Everydeck-Request-Id) is new for every HTTP call, even when everydeck retries the same job; the
 * replay protection only catches a literally repeated request. The idempotency of an action is carried by `request_id` in the body and `Idempotency-Key`;
 * the door answers a retry with the recorded result, never with 401.
 * Runs in Node >= 20, Deno (Supabase Edge Functions) and browsers: Web Crypto only, no `node:` module.
 *
 * One line in the app's door:
 *   const v = await verifyEverydeckRequest({ method: req.method, url: req.url, headers: req.headers, body }, { keys: [process.env.EVERYDECK_BRIDGE_KEY] });
 *   if (!v.ok) return 401;
 */
export interface VerifyInput { method: string; /** full path or full URL as the app sees it; the part from /everydeck/ including the query counts */ url: string; headers: HeadersLike; /** raw body (text or bytes); empty for GET */ body?: string | Uint8Array | null | undefined }
export type HeadersLike = { get(name: string): string | null } | Record<string, string | string[] | undefined>;
export interface VerifyOptions {
  /** the app's valid keys; during a key rotation the new and the old one */
  keys: (string | undefined | null)[];
  /** allowed timestamp skew in seconds (default 300) */
  maxSkewSeconds?: number;
  /** Replay protection: true when the request_id was already seen in the last 5 minutes. Default: memory of this process (several instances: your own check, e.g. Redis/Postgres) */
  seen?: (requestId: string, timestamp: number) => boolean | Promise<boolean>;
  now?: () => number;
}
export type VerifyResult = { ok: true; requestId: string; timestamp: number } | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale' | 'no_signature_matches' | 'replay' | 'no_keys' };

export const SIGNATURE_WINDOW_SECONDS = 300;
const enc = new TextEncoder();
const header = (h: HeadersLike, name: string): string | null => {
  if (typeof (h as { get?: unknown }).get === 'function') return (h as { get(n: string): string | null }).get(name);
  const r = h as Record<string, string | string[] | undefined>; const v = r[name] ?? r[name.toLowerCase()] ?? r[name.toUpperCase()];
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
};
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
export function bridgePath(urlOrPath: string): string {
  const i = urlOrPath.indexOf('/everydeck/');
  if (i >= 0) return urlOrPath.slice(i);
  try { const u = new URL(urlOrPath, 'http://bridge'); return u.pathname + u.search; } catch { return urlOrPath; }
}
export async function canonicalString(method: string, urlOrPath: string, timestamp: number | string, requestId: string, body: string | Uint8Array | null | undefined): Promise<string> {
  const bytes = typeof body === 'string' ? enc.encode(body) : body ?? new Uint8Array(0);
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
  return `EVERYDECK-V1\n${method.toUpperCase()}\n${bridgePath(urlOrPath)}\n${timestamp}\n${requestId}\n${bodyHash}`;
}
export async function signatureFor(key: string, canonical: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(canonical)));
}
const sameHex = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/** Replay store per process: request_id → timestamp, cleaned up after the window. */
export function memorySeen(windowSeconds = SIGNATURE_WINDOW_SECONDS, now: () => number = () => Date.now() / 1000) {
  const m = new Map<string, number>();
  return (id: string, ts: number): boolean => {
    const t = now(); for (const [k, v] of m) if (v < t - windowSeconds) m.delete(k);
    if (m.has(id)) return true;
    m.set(id, ts); return false;
  };
}
const defaultSeen = memorySeen();

export async function verifyEverydeckRequest(req: VerifyInput, o: VerifyOptions): Promise<VerifyResult> {
  const keys = o.keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
  if (!keys.length) return { ok: false, reason: 'no_keys' };
  const ts = header(req.headers, 'x-everydeck-timestamp'); const id = header(req.headers, 'x-everydeck-request-id'); const sig = header(req.headers, 'x-everydeck-signature');
  if (!ts || !id || !sig) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(ts) || id.length > 128) return { ok: false, reason: 'bad_timestamp' };
  const timestamp = Number(ts); const now = (o.now ?? (() => Date.now() / 1000))();
  if (Math.abs(now - timestamp) > (o.maxSkewSeconds ?? SIGNATURE_WINDOW_SECONDS)) return { ok: false, reason: 'stale' };
  const given = sig.split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3).toLowerCase());
  const canonical = await canonicalString(req.method, req.url, timestamp, id, req.body);
  let matched = false;
  for (const key of keys) { const expected = await signatureFor(key, canonical); for (const g of given) if (sameHex(g, expected)) matched = true; }
  if (!matched) return { ok: false, reason: 'no_signature_matches' };
  if (await (o.seen ?? defaultSeen)(id, timestamp)) return { ok: false, reason: 'replay' };
  return { ok: true, requestId: id, timestamp };
}

/** Counterpart for the app's tests and check scripts: headers as everydeck sends them (`keys[0]` current, further ones previous). In production only everydeck signs. */
export async function signEverydeckRequest(input: { keys: string[]; method: string; url: string; body?: string | Uint8Array | null | undefined; requestId?: string | undefined; now?: number | undefined }): Promise<Record<string, string>> {
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000);
  const requestId = input.requestId ?? (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
  const canonical = await canonicalString(input.method, input.url, timestamp, requestId, input.body);
  const sigs: string[] = []; for (const k of input.keys.filter((k, i, a) => !!k && a.indexOf(k) === i)) sigs.push(`v1=${await signatureFor(k, canonical)}`);
  return { 'x-everydeck-timestamp': String(timestamp), 'x-everydeck-request-id': requestId, 'x-everydeck-signature': sigs.join(',') };
}
