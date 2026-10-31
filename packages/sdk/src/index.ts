export { EverydeckClient, hostPublicUrl, scrubText, scrubClip, clipForScrub, SCRUB_INPUT_MAX, serverFramesOf, contextOf, CONTEXT_FRAMES, CONTEXT_LINES, CONTEXT_LINE_MAX, textHash, fullJitterMs, parseRetryAfter, gzipText, SCHEMA_VERSION, BATCH_MAX, BATCH_MAX_BYTES, EVENT_MAX_BYTES, httpField, type EverydeckOptions, type EverydeckStats, type HttpContext, type Frame, type FrameContext, type ContextStatus, type Refs, type LoginMethod, type ConfigValues } from './core.js';
export { resolveReleaseKey, COMMIT_ENV } from './release.js';
export { DEFAULT_HEARTBEAT_SECONDS } from './heartbeat.js';
export { everydeckExpress, everydeckOnRequestError, everydeckRoute, everydeckApiRoute, everydeckServe, reportServerFailure, routePattern, pathRoute, exceptionClass, type ServerErrorOptions, type NextRequestInfo, type NextErrorContext } from './server.js';
export { verifyEverydeckRequest, signEverydeckRequest, memorySeen, canonicalString as everydeckCanonicalString, signatureFor as everydeckSignatureFor, type VerifyInput, type VerifyOptions, type VerifyResult } from './verify.js';
export { createReadBridge, signEverydeckGrant, GRANT_SIGNATURE_PREFIX, type ReadGrant, pgRows, pgOne, pgMatch, pgRights, pgCount, scopeTables, sameToken, readViewName, type ReadScope, type ReadScopeObject, type ReadScopeConversation, type ReadMatch, type ReadScopeRelation, type ReadScopePeople, type ReadRows, type ReadOne, type ReadDeleted, type ReadCount, type ReadRights, type ReadBridgeOptions, type ReadBridgeRequest, type ReadBridgeResponse, type QueryClient } from './read-bridge.js';
export { everydeckReadBridge, readOnlyDb, verifyScopeSignature, signScopePayload, SCOPE_SIGNATURE_PREFIX, type ReadRouteOptions, type ReadOnlyDb, type AppDb, type SignedScopePayload, type WithheldColumn } from './read-route.js';
import { createEverydeck as createCore, type EverydeckOptions, type EverydeckClient } from './core.js';
import { resolveReleaseKey } from './release.js';
// payments (server only) live in their own module; the browser entry does not load it
export { PAYMENT_EVENTS, looksLikeCard, type PaymentEvent, type PaymentDetails } from './payment.js';
// AI calls (server only): the wrapper around the app's AI client lives in its own module; the browser entry does not load it
export { AI_EVENT, aiErrorType, type AiOptions, type AiCall, type AiOperation } from './ai.js';

/** Node entry: `releaseKey: 'auto'` (or empty) uses the automatic release key (release.ts). Deno uses core.js directly. */
export function createEverydeck(o: EverydeckOptions): EverydeckClient {
  return createCore({ readSource: readNodeSource, ...o, releaseKey: !o.releaseKey || o.releaseKey === 'auto' ? resolveReleaseKey() : o.releaseKey });
}
/** The everydeck settings of a server of its own (endpoint, server key, manifest digest); a value may be null before everydeck wrote it */
export interface ServerConfig { endpoint: string | null; server_key: string | null; manifest_digest: string | null }
/** Any Supabase client (supabase-js) created with the server's service key: only service_role may call everydeck_server_config */
export interface SupabaseRpcClient { rpc(fn: string): PromiseLike<{ data: unknown; error: unknown }> }

/**
 * Settings of a server of its own next to a hosted Supabase project: the three environment variables EVERYDECK_ENDPOINT, EVERYDECK_SERVER_KEY and
 * EVERYDECK_MANIFEST_DIGEST when all are set, else one call of public.everydeck_server_config() (added by everydeck after the owner's approval).
 * Throws when the call fails.
 */
export async function serverConfigFromSupabase(client: SupabaseRpcClient): Promise<ServerConfig> {
  const env = process.env;
  if (env['EVERYDECK_ENDPOINT'] && env['EVERYDECK_SERVER_KEY'] && env['EVERYDECK_MANIFEST_DIGEST']) return { endpoint: env['EVERYDECK_ENDPOINT'], server_key: env['EVERYDECK_SERVER_KEY'], manifest_digest: env['EVERYDECK_MANIFEST_DIGEST'] };
  const { data, error } = await client.rpc('everydeck_server_config');
  if (error) throw new Error('everydeck_server_config was refused');
  const row = (Array.isArray(data) ? data[0] : data) as Partial<ServerConfig> | null | undefined;
  if (!row || typeof row !== 'object') throw new Error('everydeck_server_config returned no object');
  return { endpoint: row.endpoint ?? null, server_key: row.server_key ?? null, manifest_digest: row.manifest_digest ?? null };
}

/**
 * A client for a server of its own whose settings come from serverConfigFromSupabase; release key "auto" (the commit the host sets). If the call
 * fails, the client is switched off with a warning that names the function and never a value; the app works unchanged.
 */
export async function everydeckFromSupabase(client: SupabaseRpcClient, o: Omit<Partial<EverydeckOptions>, 'endpoint' | 'credential' | 'manifestDigest' | 'configSource'> & {
  /** read the settings again every n seconds (default 300, like PostHog polls its flags); 0 reads them once at start */ refreshSeconds?: number } = {}): Promise<EverydeckClient> {
  const { refreshSeconds = 300, ...rest } = o;
  const warn = (msg: string) => { try { if (o.onWarning) o.onWarning(msg); else console.warn(`[everydeck] ${msg}`); } catch { /* diagnostics never break the app */ } };
  let cfg: ServerConfig = { endpoint: null, server_key: null, manifest_digest: null };
  try { cfg = await serverConfigFromSupabase(client); } catch { warn('disabled: could not read public.everydeck_server_config(); nothing is sent to everydeck'); }
  // a new approval (new digest) or a new server key reaches a long-running server without a restart; environment variables are fixed
  const fromEnv = ['EVERYDECK_ENDPOINT', 'EVERYDECK_SERVER_KEY', 'EVERYDECK_MANIFEST_DIGEST'].every((k) => !!process.env[k]);
  let failed = false;
  const load = async () => {
    try { const c = await serverConfigFromSupabase(client); failed = false; return { endpoint: c.endpoint, credential: c.server_key, manifestDigest: c.manifest_digest }; }
    catch { if (!failed) warn('could not read public.everydeck_server_config() again; the last settings stay in use'); failed = true; return null; }
  };
  return createEverydeck({ ...rest, releaseKey: o.releaseKey ?? 'auto', endpoint: cfg.endpoint ?? '', credential: cfg.server_key ?? '', manifestDigest: cfg.manifest_digest ?? '',
    ...(refreshSeconds > 0 && !fromEnv ? { configSource: { everyMs: Math.max(10, refreshSeconds * 1000), load } } : {}) });
}

/** Reads a file of the running app (for code lines when sending); larger than 2 MB or unreadable → null */
async function readNodeSource(path: string): Promise<string | null> {
  try { const fs = await import('node:fs/promises'); const st = await fs.stat(path); if (!st.isFile() || st.size > 2_000_000) return null; return await fs.readFile(path, 'utf8'); } catch { return null; }
}
