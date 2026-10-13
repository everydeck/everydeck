/**
 * @everydeck/sdk/outbox: the outbox relay from the SDK, like the read bridge. Migration, trigger template and schedule ship in the package under `outbox/`
 * (`node_modules/@everydeck/sdk/outbox/*.sql`); the Supabase function is a few lines (supabase/functions/everydeck-outbox-relay/index.ts).
 *
 * One run: read pending outbox rows in id order, send them to everydeck in batches (<= 50 events, <= 64 KiB), delete each batch only after
 * 202, and end with the job heartbeat (`everydeck.job:<job>`). Per batch:
 *   202             → rows deleted (everydeck deduplicates by event_id; a row sent twice counts once)
 *   400/409/413/422 → the batch is split and resent row by row; a row that everydeck keeps rejecting stays with rejected_at and
 *                     last_error (visible, never sent again, never silently dropped)
 *   401/403         → stop: the key is wrong or revoked; rows stay, no heartbeat (everydeck reports the silent job)
 *   429/5xx/network → stop: rows stay with attempts + 1 for the next run; no heartbeat
 * The heartbeat only comes when the outbox was emptied without a stop: "the relay reports in" means "the relay delivers".
 *
 * Runs in Deno (Supabase Edge Functions), Node >= 18 and any fetch runtime; no dependency. The caller passes `query(text, params)` for its
 * own database client.
 */
export { supabaseDbUrl, LOCAL_DB_HOST } from './supabase-db.js';
export const OUTBOX_JOB = 'everydeck_outbox_relay';
export const BATCH_SCHEMA_VERSION = '1.2-r0';
type Runtime = 'deno' | 'node';
const runtime: Runtime = (globalThis as { Deno?: unknown }).Deno ? 'deno' : 'node';
/** Origin of every relay event (event contract 1.2-r0): a server component, like the server SDKs */
export const RELAY_CLIENT: Readonly<{ platform: 'server'; runtime: Runtime }> = Object.freeze({ platform: 'server', runtime });
const BATCH_MAX = 50;
const BATCH_MAX_BYTES = 64 * 1024;
const REJECT = new Set([400, 409, 413, 422]);
const AUTH = new Set([401, 403]);

/** One row of everydeck_outbox.event (references only, no column values of the app) */
export interface OutboxRow { id: number | string; event_id: string; name: string; occurred_at: string | Date; operation_id?: string | null; subject_ref?: string | null; account_ref?: string | null; object_type?: string | null; object_ref?: string | null; /** platform of the browser request (header x-everydeck-platform) */ platform?: string | null }
const APP_PLATFORMS = new Set(['web', 'ios', 'android', 'desktop', 'extension']);
type RequestPlatform = 'web' | 'ios' | 'android' | 'desktop' | 'extension';
export interface OutboxEvent { event_id: string; kind: 'signal'; name: string; occurred_at: string; client: { platform: 'server'; runtime: Runtime; request_platform?: RequestPlatform }; operation_id?: string; subject_ref?: string; account_ref?: string; object_type?: string; object_ref?: string; fields?: Record<string, string | number> }
/** Query on the caller's connection: result as a row array (postgres.js) or `{ rows }` (pg) */
export type OutboxQuery = (text: string, params: unknown[]) => Promise<unknown>;
export interface RelayOptions { query: OutboxQuery; endpoint: string; credential: string; releaseKey: string; manifestDigest: string; job?: string; intervalSeconds?: number; instanceId?: string; maxRows?: number; timeoutMs?: number; fetch?: typeof fetch; /** false = deliver only, no heartbeat (the short tick; the one-minute tick sends the heartbeat) */ heartbeat?: boolean }
export interface RelayResult { status: 'ok' | 'auth' | 'retry' | 'misconfigured'; sent: number; rejected: number; pending: number; heartbeat: boolean; error: string | null }

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] } | null)?.rows ?? [])) as Record<string, unknown>[];
const uuid = (): string => globalThis.crypto.randomUUID();
const iso = (v: string | Date): string => new Date(v).toISOString();
const REFS = ['operation_id', 'subject_ref', 'account_ref', 'object_type', 'object_ref'] as const;

/** Outbox row → event of the everydeck batch contract (declared references only, no column values) */
export function eventOf(row: OutboxRow): OutboxEvent {
  const ev: OutboxEvent = { event_id: String(row.event_id), kind: 'signal', name: row.name, occurred_at: iso(row.occurred_at), client: { ...RELAY_CLIENT } };
  for (const k of REFS) { const v = row[k]; if (v !== null && v !== undefined && v !== '') ev[k] = String(v); }
  // the platform of the browser request as a detail of that request; the event stays a server event
  if (row.platform && APP_PLATFORMS.has(row.platform)) ev.client.request_platform = row.platform as RequestPlatform;
  return ev;
}

/** Job heartbeat exactly as `@everydeck/sdk` sends it (`heartbeat(interval, { job })`) */
export function heartbeatOf(job: string, intervalSeconds: number, instanceId: string): OutboxEvent {
  return { event_id: uuid(), kind: 'signal', name: 'everydeck.sdk.heartbeat', occurred_at: new Date().toISOString(), operation_id: `everydeck.job:${job}`, fields: { instance_id: instanceId, interval_seconds: intervalSeconds, job }, client: { ...RELAY_CLIENT } };
}

export async function relayOnce(o: RelayOptions): Promise<RelayResult> {
  const out: RelayResult = { status: 'ok', sent: 0, rejected: 0, pending: 0, heartbeat: false, error: null };
  const job = o.job ?? OUTBOX_JOB; const interval = o.intervalSeconds ?? 60; const instance = o.instanceId ?? 'everydeck-outbox-relay';
  if (!o.endpoint || !o.credential || !o.releaseKey || !o.manifestDigest) return { ...out, status: 'misconfigured', error: 'endpoint, key, release key and manifest digest are required' };
  const doFetch: typeof fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
  const endpoint = o.endpoint.replace(/\/$/, '');

  const post = async (events: OutboxEvent[]): Promise<number | 'timeout' | 'network'> => {
    const batch = { schema_version: BATCH_SCHEMA_VERSION, batch_id: uuid(), release_key: o.releaseKey, manifest_digest: o.manifestDigest, events };
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 10_000);
    try {
      const res = await doFetch(`${endpoint}/v1/events`, { method: 'POST', headers: { authorization: `Bearer ${o.credential}`, 'content-type': 'application/json' }, body: JSON.stringify(batch), signal: ctl.signal });
      try { await res.arrayBuffer(); } catch { /* body not needed */ }
      return res.status;
    } catch (e) { return (e as Error)?.name === 'AbortError' ? 'timeout' : 'network'; } finally { clearTimeout(t); }
  };
  const remember = (ids: unknown[], error: string) => o.query('UPDATE everydeck_outbox.event SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])', [ids, String(error).slice(0, 200)]);
  const stop = async (ids: unknown[], status: number | 'timeout' | 'network') => {
    const auth = typeof status === 'number' && AUTH.has(status);
    out.status = auth ? 'auth' : 'retry';
    out.error = auth ? `everydeck refused the key (${status})` : `everydeck not reachable (${status})`;
    if (ids.length) await remember(ids, out.error);
  };

  const maxRows = o.maxRows ?? 1000;
  let seen = 0;
  while (seen < maxRows) {
    const rows = rowsOf(await o.query('SELECT id, event_id, name, occurred_at, operation_id, subject_ref, account_ref, object_type, object_ref, platform FROM everydeck_outbox.event WHERE rejected_at IS NULL ORDER BY id LIMIT $1', [BATCH_MAX])) as unknown as OutboxRow[];
    if (!rows.length) break;
    // as many rows as fit into a batch of <= 64 KiB
    const take: OutboxRow[] = []; let bytes = 200;
    for (const r of rows) { const n = JSON.stringify(eventOf(r)).length + 1; if (take.length && bytes + n > BATCH_MAX_BYTES) break; take.push(r); bytes += n; }
    seen += take.length;
    const ids = take.map((r) => r.id);
    const status = await post(take.map(eventOf));
    if (status === 202) { await o.query('DELETE FROM everydeck_outbox.event WHERE id = ANY($1::bigint[])', [ids]); out.sent += take.length; continue; }
    if (typeof status === 'number' && REJECT.has(status)) {
      // resend one by one: only the row that everydeck rejects stays behind, visible
      for (const r of take) {
        const one = await post([eventOf(r)]);
        if (one === 202) { await o.query('DELETE FROM everydeck_outbox.event WHERE id = $1', [r.id]); out.sent++; }
        else if (typeof one === 'number' && REJECT.has(one)) { await o.query('UPDATE everydeck_outbox.event SET attempts = attempts + 1, rejected_at = now(), last_error = $2 WHERE id = $1', [r.id, `rejected by everydeck (${one})`]); out.rejected++; }
        else { await stop([r.id], one); break; }
      }
      if (out.status !== 'ok') break;
      continue;
    }
    await stop(ids, status);
    break;
  }
  out.pending = Number(rowsOf(await o.query('SELECT count(*)::int AS n FROM everydeck_outbox.event WHERE rejected_at IS NULL', []))[0]?.['n'] ?? 0);
  if (out.status === 'ok' && o.heartbeat !== false) {
    const hb = await post([heartbeatOf(job, interval, instance)]);
    out.heartbeat = hb === 202;
    if (!out.heartbeat) { out.status = typeof hb === 'number' && AUTH.has(hb) ? 'auth' : 'retry'; out.error = `heartbeat not accepted (${hb})`; }
  }
  return out;
}

// ── Scheduled call (Supabase Edge Function or any fetch runtime) ────────────────────────────────────────────────────────────
/** Secrets from Supabase Vault over the function's own database connection; never from a migration, never from the repository */
const SECRETS = ['everydeck_outbox_invoke_token', 'everydeck_ingest_key'];
function sameToken(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length < 32) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export interface RelayHandlerDeps { query: OutboxQuery; env: (name: string) => string | undefined; fetch?: typeof fetch }
/**
 * HTTP handler for the scheduled call: checks its own invoke token from Vault (`everydeck_outbox_invoke_token`), fetches the everydeck server key
 * from Vault (`everydeck_ingest_key`) and does one run. Non-secret settings come from the function's environment: EVERYDECK_ENDPOINT,
 * EVERYDECK_RELEASE_KEY, EVERYDECK_MANIFEST_DIGEST. The response only counts rows, never a secret.
 */
export function createRelayHandler(deps: RelayHandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    const r = rowsOf(await deps.query('SELECT name, decrypted_secret FROM vault.decrypted_secrets WHERE name = ANY($1::text[])', [SECRETS]));
    const secrets = Object.fromEntries(r.map((x) => [String(x['name']), x['decrypted_secret']]));
    const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!sameToken(auth, secrets['everydeck_outbox_invoke_token'])) return Response.json({ error: 'unauthorized' }, { status: 401 });
    // the short tick (every 5 s, only while rows wait) sends {"heartbeat": false}; the one-minute tick sends the heartbeat
    let heartbeat = true;
    try { const b = await req.json() as { heartbeat?: unknown } | null; if (b && b.heartbeat === false) heartbeat = false; } catch { /* empty body: one-minute tick */ }
    const result = await relayOnce({ query: deps.query, endpoint: deps.env('EVERYDECK_ENDPOINT') ?? '', credential: String(secrets['everydeck_ingest_key'] ?? ''), releaseKey: deps.env('EVERYDECK_RELEASE_KEY') ?? '', manifestDigest: deps.env('EVERYDECK_MANIFEST_DIGEST') ?? '', heartbeat, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    return Response.json(result, { status: result.status === 'ok' ? 200 : 503 });
  };
}
