export { EverydeckClient, scrubText, serverFramesOf, contextOf, CONTEXT_FRAMES, CONTEXT_LINES, CONTEXT_LINE_MAX, textHash, fullJitterMs, parseRetryAfter, gzipText, SCHEMA_VERSION, BATCH_MAX, BATCH_MAX_BYTES, EVENT_MAX_BYTES, httpField, type EverydeckOptions, type EverydeckStats, type HttpContext, type Frame, type FrameContext, type ContextStatus, type Refs, type LoginMethod } from './core.js';
export { resolveReleaseKey, COMMIT_ENV } from './release.js';
export { verifyEverydeckRequest, signEverydeckRequest, memorySeen, canonicalString as everydeckCanonicalString, signatureFor as everydeckSignatureFor, type VerifyInput, type VerifyOptions, type VerifyResult } from './verify.js';
export { createReadBridge, pgRows, pgOne, pgMatch, pgRights, scopeTables, sameToken, readViewName, type ReadScope, type ReadScopeObject, type ReadScopeConversation, type ReadMatch, type ReadScopeRelation, type ReadScopePeople, type ReadRows, type ReadOne, type ReadDeleted, type ReadRights, type ReadBridgeOptions, type ReadBridgeRequest, type ReadBridgeResponse, type QueryClient } from './read-bridge.js';
import { createEverydeck as createCore, type EverydeckOptions, type EverydeckClient } from './core.js';
import { resolveReleaseKey } from './release.js';

/** Node-Einstieg: `releaseKey: 'auto'` (oder leer) nimmt die automatische Versionskennung (B15/C5, release.ts). Deno nutzt core.js direkt. */
export function createEverydeck(o: EverydeckOptions): EverydeckClient {
  return createCore({ readSource: readNodeSource, ...o, releaseKey: !o.releaseKey || o.releaseKey === 'auto' ? resolveReleaseKey() : o.releaseKey });
}
/** B33: Datei der laufenden App lesen (für Code-Zeilen beim Senden); größer als 2 MB oder nicht lesbar → null */
async function readNodeSource(path: string): Promise<string | null> {
  try { const fs = await import('node:fs/promises'); const st = await fs.stat(path); if (!st.isFile() || st.size > 2_000_000) return null; return await fs.readFile(path, 'utf8'); } catch { return null; }
}
