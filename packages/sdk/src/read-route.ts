/**
 * @everydeck/sdk/read-bridge – B46 (Entscheidung E2): die Lese-Brücke als fertige Route. Die App bindet sie mit ihrer eigenen Datenbankverbindung ein,
 * ohne Leserolle, ohne Sichten, ohne kopierte Dateien und ohne eine Datei mit dem Lese-Umfang im Repo:
 *
 *   import postgres from 'npm:postgres@3.4.5';
 *   import { everydeckReadBridge } from 'npm:@everydeck/sdk@<version>/read-bridge';
 *   const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2 });
 *   Deno.serve(everydeckReadBridge({ endpoint: Deno.env.get('EVERYDECK_URL') ?? '', key: Deno.env.get('EVERYDECK_READ_BRIDGE_TOKEN') ?? '', db: sql, prefix: '/everydeck-read-bridge' }).fetch);
 *
 * Was die Route tut:
 *  - Den Lese-Umfang holt sie bei everydeck (GET <endpoint>/v1/read-scope, Brückenschlüssel als Bearer). everydeck signiert ihn mit demselben Schlüssel
 *    (HMAC-SHA256 über "EVERYDECK-SCOPE-V1\n" + payload); ohne gültige Signatur liest die Route nichts (503). Sie hält ihn höchstens `scopeTtlSeconds`.
 *  - Jede Abfrage läuft in einer eigenen Nur-Lesen-Transaktion auf der Verbindung der App (postgres.js: sql.begin('read only'), pg-Pool: BEGIN READ ONLY):
 *    die Datenbank selbst lehnt darin jedes Schreiben ab (SQLSTATE 25006). Gelesen werden nur Tabellen und Spalten aus dem signierten Umfang.
 *  - Die Rechte meldet sie geprüft: die Rolle der Verbindung, ob sie Superuser ist, ob sie die Zeilenrechte der App umgeht (rolbypassrls), ob die
 *    Transaktion wirklich nur lesen darf (current_setting('transaction_read_only')) und auf welchen Tabellen die Rolle selbst schreiben dürfte.
 *  - Aufrufe von everydeck sind signiert (verify.ts); unsignierte Aufrufe und Schreibverben lehnt sie ab.
 * Läuft in Node ≥ 22, Deno (Supabase Edge Functions) und jeder fetch-Laufzeit: nur Web Crypto, kein `node:`-Modul.
 */
import { createReadBridge, pgMatch, pgOne, pgRights, pgRows, type QueryClient, type ReadBridgeRequest, type ReadBridgeResponse, type ReadRights, type ReadScope } from './read-bridge.js';
import { memorySeen, type VerifyOptions } from './verify.js';

export const SCOPE_SIGNATURE_PREFIX = 'EVERYDECK-SCOPE-V1\n';
/** Eine Spalte, die everydeck nie liest (B46 Punkt 2): Kontaktdaten und Nachrichten – nur ihr Name, nie ein Wert */
export interface WithheldColumn { table: string; column: string; kind: 'email' | 'phone' | 'ip' | 'message'; type?: string; label?: string }
/** Was everydeck signiert: der freigegebene Lese-Umfang dieser Brücke */
export interface SignedScopePayload { version: '1'; project_id: string; environment_id: string; revision_id: string; digest: string; issued_at: string; scope: ReadScope; withheld?: WithheldColumn[] }

/** Eine Datenbank, die eine Funktion in einer Nur-Lesen-Transaktion ausführt */
export interface ReadOnlyDb { readOnly<T>(fn: (q: QueryClient) => Promise<T>): Promise<T> }
/** postgres.js (`postgres(url)`) */
interface PostgresJsLike { begin: (options: string, fn: (tx: { unsafe: (text: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown> }
/** pg.Pool (`new Pool(…)`) – connect() liefert einen Client mit release() */
interface PgPoolLike { connect: () => Promise<{ query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; release: (err?: Error | boolean) => void }> }
export type AppDb = ReadOnlyDb | PostgresJsLike | PgPoolLike;

const hasFn = (x: unknown, name: string): boolean => (typeof x === 'object' || typeof x === 'function') && x !== null && typeof (x as Record<string, unknown>)[name] === 'function';
/** Die Verbindung der App als Nur-Lesen-Datenbank: postgres.js, ein pg-Pool oder etwas mit readOnly() */
export function readOnlyDb(db: AppDb): ReadOnlyDb {
  if (hasFn(db, 'readOnly')) return db as ReadOnlyDb;
  if (hasFn(db, 'begin')) {
    const sql = db as PostgresJsLike;
    return { readOnly: async <T>(fn: (q: QueryClient) => Promise<T>) => (await sql.begin('read only', (tx) => fn({ query: async (text, values = []) => ({ rows: (await tx.unsafe(text, values)) as Record<string, unknown>[] }) }))) as T };
  }
  if (hasFn(db, 'connect')) {
    const pool = db as PgPoolLike;
    return { readOnly: async <T>(fn: (q: QueryClient) => Promise<T>) => {
      const c = await pool.connect(); let failed: unknown = null;
      try { await c.query('BEGIN READ ONLY'); const out = await fn({ query: (text, values) => c.query(text, values ?? []) }); await c.query('COMMIT'); return out; }
      catch (e) { failed = e; try { await c.query('ROLLBACK'); } catch { /* Verbindung kaputt: der Pool verwirft sie */ } throw e; }
      finally { c.release(failed instanceof Error && !(failed as { code?: string }).code ? failed : undefined); } } };
  }
  throw new Error('everydeck read bridge: db must be a postgres.js connection, a pg Pool or an object with readOnly(fn)');
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}
const sameHex = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
/** Signatur des Lese-Umfangs prüfen (v1=<hex>[,v1=<hex>] – eine je gültigem Schlüssel) */
export async function verifyScopeSignature(keys: string[], payload: string, signature: string | undefined | null): Promise<boolean> {
  if (typeof signature !== 'string' || !keys.length) return false;
  const given = signature.split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3).toLowerCase());
  for (const k of keys) { const expected = await hmacHex(k, SCOPE_SIGNATURE_PREFIX + payload); if (given.some((g) => sameHex(g, expected))) return true; }
  return false;
}
/** Gegenstück (everydeck und Tests): signierter Lese-Umfang */
export async function signScopePayload(keys: string[], payload: string): Promise<string> {
  const out: string[] = []; for (const k of keys.filter((x, i, a) => !!x && a.indexOf(x) === i)) out.push(`v1=${await hmacHex(k, SCOPE_SIGNATURE_PREFIX + payload)}`); return out.join(',');
}

export interface ReadRouteOptions {
  /** Adresse von everydeck (EVERYDECK_URL) */ endpoint: string;
  /** Brückenschlüssel (EVERYDECK_READ_BRIDGE_TOKEN), von everydeck erzeugt */ key: string;
  /** voriger Schlüssel während eines Tauschs */ previousKey?: string | undefined;
  /** die Verbindung, die die App schon hat */ db: AppDb;
  /** Pfadteil vor /everydeck/read (Supabase Edge Function: /everydeck-read-bridge) */ prefix?: string;
  app?: string; fetch?: typeof fetch; /** wie lange der Lese-Umfang gilt, bevor die Route ihn neu holt (Standard 60 s) */ scopeTtlSeconds?: number;
  /** Replay-Schutz über mehrere Instanzen (Standard: Speicher dieses Prozesses) */ seen?: VerifyOptions['seen'];
}

const unavailable = (error: string): ReadBridgeResponse => ({ status: 503, body: { error } });
const ROLE_SQL = "SELECT current_user::text AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls, current_setting('transaction_read_only') AS read_only FROM pg_roles r WHERE r.rolname = current_user";

export function everydeckReadBridge(o: ReadRouteOptions) {
  const keys = [o.key, ...(o.previousKey ? [o.previousKey] : [])].filter((k) => typeof k === 'string' && k.length > 0);
  const endpoint = (o.endpoint ?? '').replace(/\/+$/, '');
  const ttl = Math.max(0, o.scopeTtlSeconds ?? 60) * 1000;
  const seen = o.seen ?? memorySeen();
  let ro: ReadOnlyDb | null = null; let dbError: string | null = null;
  try { ro = readOnlyDb(o.db); } catch (e) { dbError = e instanceof Error ? e.message : String(e); }
  let cached: { at: number; payload: SignedScopePayload; bridge: ReturnType<typeof createReadBridge> } | null = null;

  /** Rechte geprüft in derselben Art Transaktion, in der gelesen wird */
  const rightsOf = (scope: ReadScope) => async (): Promise<ReadRights> => ro!.readOnly(async (q) => {
    const base = await pgRights(q, scope)();
    const who = (await q.query(ROLE_SQL)).rows[0] as { role?: string; superuser?: boolean; bypass_rls?: boolean; read_only?: string } | undefined;
    return { ...base, ...(who?.role ? { role: who.role } : {}), superuser: !!who?.superuser, bypass_rls: !!who?.bypass_rls, read_only_transaction: who?.read_only === 'on' };
  });

  async function load(): Promise<{ bridge: ReturnType<typeof createReadBridge>; payload: SignedScopePayload } | { error: string }> {
    if (cached && Date.now() - cached.at < ttl) return cached;
    if (!endpoint) return { error: 'EVERYDECK_URL is not set: the read bridge cannot fetch its read scope from everydeck' };
    if (!keys.length) return { error: 'EVERYDECK_READ_BRIDGE_TOKEN is not set' };
    if (!ro) return { error: dbError ?? 'no database connection' };
    let res: Response;
    try { res = await (o.fetch ?? fetch)(`${endpoint}/v1/read-scope`, { method: 'GET', headers: { authorization: `Bearer ${keys[0]}`, accept: 'application/json' } }); }
    catch { return { error: 'everydeck is not reachable: read scope unavailable' }; }
    if (!res.ok) return { error: `everydeck refused the read scope (HTTP ${res.status})` };
    let body: { payload?: unknown; signature?: unknown };
    try { body = await res.json() as typeof body; } catch { return { error: 'read scope is not JSON' }; }
    if (typeof body.payload !== 'string' || !(await verifyScopeSignature(keys, body.payload, typeof body.signature === 'string' ? body.signature : null))) return { error: 'read scope signature invalid: not signed by everydeck with this key' };
    let payload: SignedScopePayload;
    try { payload = JSON.parse(body.payload) as SignedScopePayload; } catch { return { error: 'read scope payload is not JSON' }; }
    if (payload.version !== '1' || !payload.scope || payload.scope.version !== '1') return { error: 'read scope version not supported' };
    const db = ro; const scope = payload.scope;
    const bridge = createReadBridge({ scope, token: keys[0]!, keys, seen, signatures: 'required', app: o.app ?? 'everydeck read bridge (@everydeck/sdk)', pageLimit: 200,
      rows: (q) => db.readOnly((c) => pgRows(c)(q)), one: (q) => db.readOnly((c) => pgOne(c)(q)), match: (q) => db.readOnly((c) => pgMatch(c)(q)), rights: rightsOf(scope) });
    cached = { at: Date.now(), payload, bridge };
    return cached;
  }

  async function handle(req: ReadBridgeRequest): Promise<ReadBridgeResponse> {
    const path = req.path.split('?')[0]!;
    if (!path.startsWith('/everydeck/read/')) return { status: 404, body: { error: 'not found' } };
    const l = await load();
    if ('error' in l) return unavailable(l.error);
    return l.bridge.handle(req);
  }
  const prefix = o.prefix ?? '';
  /** fetch-Adapter (Deno.serve, Supabase Edge Function, Cloudflare, Next.js Route Handler) */
  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url); const path = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const r = await handle({ method: req.method, path, query: Object.fromEntries(url.searchParams), authorization: req.headers.get('authorization') ?? undefined, headers: req.headers, url: url.pathname + url.search, body: req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer()) });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  /** Node-Adapter: (req, res) für node:http oder Express-artige Server */
  const node = () => async (req: { method?: string | undefined; url?: string | undefined; headers: Record<string, string | string[] | undefined>; [Symbol.asyncIterator]?: () => AsyncIterator<unknown> }, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }) => {
    const url = new URL(req.url ?? '/', 'http://bridge'); const path = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const method = req.method ?? 'GET'; let body: Uint8Array | null = null;
    if (method !== 'GET' && method !== 'HEAD' && req[Symbol.asyncIterator]) { const parts: Uint8Array[] = []; for await (const ch of req as AsyncIterable<Uint8Array | string>) parts.push(typeof ch === 'string' ? enc.encode(ch) : ch); let n = 0; for (const p of parts) n += p.length; body = new Uint8Array(n); let i = 0; for (const p of parts) { body.set(p, i); i += p.length; } }
    const r = await handle({ method, path, query: Object.fromEntries(url.searchParams), authorization: Array.isArray(req.headers['authorization']) ? req.headers['authorization'][0] : req.headers['authorization'], headers: req.headers, url: url.pathname + url.search, body });
    const out = JSON.stringify(r.body); res.writeHead(r.status, { 'content-type': 'application/json', 'content-length': String(enc.encode(out).length) }); res.end(out);
  };
  return { handle, fetch: fetchHandler, node, scope: async () => { const l = await load(); return 'error' in l ? null : l.payload; } };
}
export { signEverydeckRequest } from './verify.js';
export { signEverydeckGrant, GRANT_SIGNATURE_PREFIX, type ReadGrant } from './read-bridge.js';
export type { ReadScope, QueryClient, ReadBridgeRequest, ReadBridgeResponse, ReadRights } from './read-bridge.js';
