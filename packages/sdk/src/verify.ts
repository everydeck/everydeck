/**
 * B30 Schnitt E – Prüfhilfe für Brücken: everydeck signiert jeden Aufruf an eine Lese- oder App-Brücke (wie Stripe).
 *   X-Everydeck-Timestamp (Unix-Sekunden), X-Everydeck-Request-Id (UUID), X-Everydeck-Signature (v1=<hex>[,v1=<hex>] – eine je gültigem Schlüssel).
 *   Signatur = HMAC-SHA256(Schlüssel, "EVERYDECK-V1\n" + METHOD + "\n" + Pfad ab /everydeck/ mit Query + "\n" + Zeitstempel + "\n" + request_id + "\n" + SHA-256(Körper) hex).
 * Die App lehnt ab, wenn der Zeitstempel älter (oder jünger) als 5 Minuten ist oder die request_id in dieser Zeit schon gesehen wurde.
 * B31 Abnahme (A8): Die request_id der Signatur (X-Everydeck-Request-Id) ist je HTTP-Aufruf neu, auch wenn everydeck denselben Auftrag wiederholt – der
 * Replay-Schutz trifft nur eine wörtlich wiederholte Anfrage. Die Idempotenz einer Aktion trägt `request_id` im Körper und `Idempotency-Key`;
 * eine Wiederholung beantwortet die Tür mit dem festgehaltenen Ergebnis, nie mit 401.
 * Läuft in Node ≥ 20, Deno (Supabase Edge Functions) und Browsern: nur Web Crypto, kein `node:`-Modul.
 *
 * Eine Zeile in der Tür der App:
 *   const v = await verifyEverydeckRequest({ method: req.method, url: req.url, headers: req.headers, body }, { keys: [process.env.EVERYDECK_BRIDGE_KEY] });
 *   if (!v.ok) return 401;
 */
export interface VerifyInput { method: string; /** voller Pfad oder volle URL, wie die App ihn sieht; es zählt der Teil ab /everydeck/ mit Query */ url: string; headers: HeadersLike; /** roher Körper (Text oder Bytes); bei GET leer */ body?: string | Uint8Array | null | undefined }
export type HeadersLike = { get(name: string): string | null } | Record<string, string | string[] | undefined>;
export interface VerifyOptions {
  /** die gültigen Schlüssel der App – während eines Schlüsseltauschs der neue und der alte */
  keys: (string | undefined | null)[];
  /** erlaubter Abstand des Zeitstempels in Sekunden (Standard 300) */
  maxSkewSeconds?: number;
  /** Replay-Schutz: true, wenn die request_id in den letzten 5 Minuten schon gesehen wurde. Standard: Speicher dieses Prozesses (mehrere Instanzen: eigene Prüfung, z. B. Redis/Postgres) */
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

/** Replay-Speicher je Prozess: request_id → Zeitstempel, aufgeräumt nach dem Fenster. */
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

/** Gegenstück für Tests und Prüfskripte der App: Kopfzeilen, wie everydeck sie schickt (`keys[0]` aktuell, weitere vorige). Im Produkt signiert nur everydeck. */
export async function signEverydeckRequest(input: { keys: string[]; method: string; url: string; body?: string | Uint8Array | null | undefined; requestId?: string | undefined; now?: number | undefined }): Promise<Record<string, string>> {
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000);
  const requestId = input.requestId ?? (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
  const canonical = await canonicalString(input.method, input.url, timestamp, requestId, input.body);
  const sigs: string[] = []; for (const k of input.keys.filter((k, i, a) => !!k && a.indexOf(k) === i)) sigs.push(`v1=${await signatureFor(k, canonical)}`);
  return { 'x-everydeck-timestamp': String(timestamp), 'x-everydeck-request-id': requestId, 'x-everydeck-signature': sigs.join(',') };
}
