/**
 * @everydeck/sdk: the generic read bridge: one endpoint per declared table, declared columns only,
 * with a cursor. The agent no longer writes a bridge per app: it fetches the read scope (`everydeck/everydeck-read-scope.json`, derived from the app map) and
 * passes a function `rows` that reads rows from the app's database, through a dedicated reader role (SELECT only). `pgRows(client)` is the
 * ready-made version for `pg` or `postgres` (any client with `query(text, values)`); `pgRights(client, scope)` checks the actual
 * rights of that role at startup (superuser, INSERT/UPDATE/DELETE per table), and the bridge reports them in `rights` instead of claiming them.
 *
 * Runs in Node >= 22, Deno (Supabase Edge Functions) and any fetch runtime: no `Buffer`, no `node:` module. `handle()` is the pure
 * function, `fetch()` the adapter for Request/Response (Deno.serve), `node()` the one for node:http.
 *
 * Contract (read-bridge.schema.json): GET /everydeck/read/capabilities · GET /everydeck/read/objects/{type}?cursor&limit[&changed_since=<ISO>] · GET /everydeck/read/objects/{type}/{ref} · GET /everydeck/read/people?cursor&limit
 * · GET /everydeck/read/messages/{type}/{ref}?cursor&limit (messages of a conversation, on demand only, with `match`)
 * · GET /everydeck/read/counts (with `count`: per type the number of records a full read would deliver, so everydeck's data loss watch need not wait for a full read);
 * incremental (like Fivetran): with `changed_since` only changed rows, stable by (change column, key), plus `deleted` where the app knows deletions; single fetch after a signal; the capabilities name `changed_since` and `fetch_one` per object type;
 * own Bearer key (compared in constant time); every write verb is rejected; pages <= 200; identifiers as text (several key columns
 * joined with "|"); timestamps as ISO-8601; object values as JSON text; no value longer than 256 characters. Relations (link tables)
 * are delivered like object types (type = relations[].id, fields = the two sides). Nothing outside the scope is reachable.
 */
import { verifyEverydeckRequest, type HeadersLike, type VerifyOptions } from './verify.js';
const headerOf = (h: HeadersLike, name: string): string | null => { if (typeof (h as { get?: unknown }).get === 'function') return (h as { get(n: string): string | null }).get(name); const v = (h as Record<string, string | string[] | undefined>)[name] ?? (h as Record<string, string | string[] | undefined>)[name.toLowerCase()]; return Array.isArray(v) ? v[0] ?? null : v ?? null; };
/**
 * The bridge reads a conversation only with a grant from everydeck for exactly that conversation: a moderator opened it with a reason.
 * The grant names object type, identifier, reason, expiry (Unix seconds, at most 5 minutes) and the message table with its columns;
 * the standing scope does not know this table. It travels as a query (?grant=<base64url(JSON)>&grant_sig=v1=<hex>), signed with the bridge key
 * over "EVERYDECK-GRANT-V1\n" + grant. None of it is stored.
 */
export const GRANT_SIGNATURE_PREFIX = 'EVERYDECK-GRANT-V1\n';
export interface ReadGrant { v: 1; id: string; type: string; ref: string; reason: string; exp: number; messages: ReadScopeConversation['messages']; attachments?: ReadScopeConversation['attachments'] }
const GRANT_MAX_SECONDS = 300;
async function grantHmac(key: string, grant: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(GRANT_SIGNATURE_PREFIX + grant))), (x) => x.toString(16).padStart(2, '0')).join('');
}
/** Counterpart for everydeck and tests: query parameters of a grant */
export async function signEverydeckGrant(keys: string[], grant: ReadGrant): Promise<{ grant: string; grant_sig: string }> {
  const bytes = enc.encode(JSON.stringify(grant)); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  const g = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sigs: string[] = []; for (const k of keys.filter((x, i, a) => !!x && a.indexOf(x) === i)) sigs.push(`v1=${await grantHmac(k, g)}`);
  return { grant: g, grant_sig: sigs.join(',') };
}
const isName = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 160;
/** Checks a grant: signature with a valid key, exactly this conversation, reason, not expired, message table complete */
async function grantOf(keys: string[], q: Record<string, string | undefined> | undefined, type: string, ref: string): Promise<ReadGrant | string> {
  const g = q?.['grant']; const sig = q?.['grant_sig'];
  if (!g || !sig) return 'grant missing';
  const given = sig.split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3).toLowerCase());
  let ok = false; for (const k of keys) { const e = await grantHmac(k, g); if (given.some((x) => x.length === e.length && x === e)) ok = true; }
  if (!ok) return 'grant signature invalid';
  let v: ReadGrant;
  try { const bin = atob(g.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (g.length % 4)) % 4)); v = JSON.parse(dec.decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as ReadGrant; } catch { return 'grant unreadable'; }
  const now = Math.floor(Date.now() / 1000);
  if (v.v !== 1 || v.type !== type || v.ref !== ref) return 'grant is for another conversation';
  if (typeof v.reason !== 'string' || !v.reason.trim()) return 'grant without a reason';
  if (typeof v.exp !== 'number' || v.exp < now || v.exp > now + GRANT_MAX_SECONDS + 30) return 'grant expired';
  const m = v.messages;
  if (!m || !isName(m.table) || !Array.isArray(m.ref) || !m.ref.every(isName) || !isName(m.conversation) || !isName(m.sender) || !isName(m.time) || !Array.isArray(m.text) || !m.text.length || !m.text.every(isName)) return 'grant names no message table';
  return v;
}
export interface ReadScopeField { name: string; column: string }
export interface ReadScopeObject { type: string; table: string; ref: string[]; title?: string; status?: string; owner?: string; fields: ReadScopeField[]; statuses?: string[]; /** the column the database sets on every change (trigger/onupdate); allows `changed_since`; without it only full runs */ changed?: string;
  /** the column the database sets to the current time when a record is created and nothing changes later; delivered as `created_at` (the app's history before everydeck) */ created?: string }
export interface ReadScopeRelation { id: string; table: string; ref: string[]; fields: ReadScopeField[] }
/** name = the app's rule for the display name (stages in order; per stage the columns, joined with the app's separator) */
export interface ReadScopePeople { table: string; ref: string; fields: Record<string, string>; name?: { columns: string[]; separator?: string }[]; /** when the person signed up; delivered as `created_at` */ created?: string }
/** A conversation: the bridge delivers its messages only on demand (GET /everydeck/read/messages/{type}/{ref}); everydeck does not store them */
export interface ReadScopeConversation { type: string; table: string; ref: string[]; messages: { table: string; ref: string[]; conversation: string; sender: string; time: string; text: string[] }; attachments?: { table: string; message: string; url: string; name?: string; kind: 'image' | 'file' } }
export interface ReadScope { version: '1'; objects: ReadScopeObject[]; relations: ReadScopeRelation[]; conversations?: ReadScopeConversation[]; people: ReadScopePeople | null }
/** Rights of the database role: checked, not claimed */
export interface ReadRights { role: string; select_only: boolean; superuser?: boolean; writable?: string[]; checked_at?: string; /** who besides the reader role can reach the view schema: 'supabase api' (pgrst.db_schemas of authenticator), 'anon', 'authenticated', 'public' (USAGE on the schema); empty = nobody */ exposed?: string[];
  /** the role bypasses the app's row security (pg_roles.rolbypassrls); the bridge then sees every row and delivers only the approved columns */ bypass_rls?: boolean;
  /** every query runs in a transaction in which the database only allows reads (current_setting('transaction_read_only') = on, checked) */ read_only_transaction?: boolean }

/** Rows of a table, sorted by the key columns, from a cursor (key column values of the last row), at most `limit`.
 *  With `changed` only rows with changed.column >= since, sorted stably by (changed.column, key); the cursor is then [change time, ...key] */
export type ReadRows = (q: { table: string; columns: string[]; keys: string[]; after: string[] | null; limit: number; changed?: { column: string; since: string } | undefined }) => Promise<Record<string, unknown>[]>;
/** Exactly one row by its key values (single fetch after a signal) */
export type ReadOne = (q: { table: string; columns: string[]; keys: string[]; ref: string[] }) => Promise<Record<string, unknown> | null>;
/** Deletions the app knows (soft-delete column, deletion table): [{ ref, deleted_at }] since `since`; without an adapter, deleted rows show up through the inventory */
export type ReadDeleted = (q: { table: string; keys: string[]; since: string; limit: number }) => Promise<{ ref: string; deleted_at: string }[]>;
/** The number of rows of a table (what a full read of the type would deliver), like Elementary's row count; everydeck compares counts for its data loss watch */
export type ReadCount = (q: { table: string; keys: string[] }) => Promise<number>;
/** Rows whose column `where.column` has one of the values, sorted by `order`, from a cursor (values of the sort columns); for the messages of a conversation */
export type ReadMatch = (q: { table: string; columns: string[]; where: { column: string; values: string[] }; order: string[]; after: string[] | null; limit: number }) => Promise<Record<string, unknown>[]>;
export interface ReadBridgeOptions { scope: ReadScope; token: string;
  /** messages of a conversation on demand (pgMatch); without `match` the bridge offers no conversations */ match?: ReadMatch;
  /** everydeck signs every call: `required` (default) rejects unsigned calls, `optional` accepts the Bearer when there is no signature (everydeck instances that do not sign yet), `off` checks only the Bearer */ signatures?: 'required' | 'optional' | 'off';
  /** valid keys for the signature (default: `token`; during a rotation the new and the old one) */ keys?: string[]; /** replay protection across several instances (default: memory of this process) */ seen?: VerifyOptions['seen']; rows: ReadRows; one?: ReadOne; deleted?: ReadDeleted; /** counts per type (pgCount); without it the bridge offers no counts and everydeck waits for a full read */ count?: ReadCount; app?: string; pageLimit?: number; /** fixed, or checked on the first call (pgRights) */ rights?: ReadRights | (() => Promise<ReadRights>) }
export interface ReadBridgeRequest { method: string; path: string; query?: Record<string, string | undefined>; authorization?: string | undefined;
  /** headers (X-Everydeck-Timestamp, X-Everydeck-Request-Id, X-Everydeck-Signature) and the path with query as the app sees it, for the signature check */ headers?: HeadersLike | undefined; url?: string | undefined; body?: string | Uint8Array | null | undefined }
export interface ReadBridgeResponse { status: number; body: unknown }
export interface QueryClient { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

const PAGE_MAX = 200; const VALUE_MAX = 256;
const enc = new TextEncoder(); const dec = new TextDecoder();
const b64 = (v: string[]) => { const bytes = enc.encode(JSON.stringify(v)); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = (c: string): string[] | null => { try { const bin = atob(c.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (c.length % 4)) % 4)); const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0)); const v = JSON.parse(dec.decode(bytes)); return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null; } catch { return null; } };
/** Key comparison in constant time (no early return per character) */
export function sameToken(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = enc.encode(a); const y = enc.encode(b); let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i % x.length] ?? 0) ^ (y[i % y.length] ?? 0);
  return d === 0 && x.length === y.length;
}
const text = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** Field value in transport form: number, boolean, text (<= 256), otherwise JSON text; timestamps ISO-8601 */
const value = (v: unknown): string | number | boolean | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return text(v).slice(0, VALUE_MAX);
};
const uniq = (xs: string[]) => [...new Set(xs)];

export function createReadBridge(o: ReadBridgeOptions) {
  const limitMax = Math.min(PAGE_MAX, Math.max(1, o.pageLimit ?? 100));
  let rightsCache: ReadRights | null = typeof o.rights === 'function' ? null : (o.rights ?? { role: 'unknown', select_only: false });
  const rights = async (): Promise<ReadRights> => { if (!rightsCache) rightsCache = await (o.rights as () => Promise<ReadRights>)(); return rightsCache; };
  const objects = new Map<string, { table: string; keys: string[]; columns: string[]; title?: string | undefined; status?: string | undefined; owner?: string | undefined; changed?: string | undefined; created?: string | undefined; fields: ReadScopeField[] }>();
  for (const x of o.scope.objects) objects.set(x.type, { table: x.table, keys: x.ref, title: x.title, status: x.status, owner: x.owner, changed: x.changed, created: x.created, fields: x.fields, columns: uniq([...x.ref, ...(x.title ? [x.title] : []), ...(x.status ? [x.status] : []), ...(x.owner ? [x.owner] : []), ...(x.changed ? [x.changed] : []), ...(x.created ? [x.created] : []), ...x.fields.map((f) => f.column)]) });
  for (const r of o.scope.relations) objects.set(r.id, { table: r.table, keys: r.ref, fields: r.fields, columns: uniq([...r.ref, ...r.fields.map((f) => f.column)]) });
  // the capabilities say per object type whether `changed_since` works (change column in the scope) and whether the single fetch works
  const capabilities = async () => ({ version: '1' as const, ...(o.app ? { app: o.app } : {}), identity: 'subject_ref' as const,
    objects: [...o.scope.objects.map((x) => ({ type: x.type, fields: x.fields.map((f) => f.name), ...(x.statuses?.length ? { statuses: x.statuses } : {}), changed_since: !!x.changed, ...(o.count ? { count: true } : {}) })), ...o.scope.relations.map((r) => ({ type: r.id, fields: r.fields.map((f) => f.name), changed_since: false, ...(o.count ? { count: true } : {}) }))],
    ...(o.scope.people ? { people: { fields: Object.keys(o.scope.people.fields) } } : {}), ...(o.match && o.scope.conversations?.length ? { messages: o.scope.conversations.map((c) => c.type) } : {}), ...(o.match ? { messages_grant: true } : {}), rights: await rights(), page_limit: limitMax, fetch_one: !!o.one, signed: (o.signatures ?? 'required') !== 'off' });
  const page = (q: Record<string, string | undefined> | undefined) => { const limit = Math.min(limitMax, Math.max(1, Number(q?.['limit'] ?? limitMax) || limitMax)); const after = q?.['cursor'] ? unb64(q['cursor']) : null; return { limit, after, bad: !!q?.['cursor'] && !after }; };
  const refOf = (row: Record<string, unknown>, keys: string[]) => keys.map((k) => text(row[k])).join('|');
  // a timestamp as Postgres writes it as text ("2026-10-25 23:59:16.774+00", offset without minutes) is read too
  const isoOf = (v: unknown): string | null => { if (v === null || v === undefined) return null; const d = v instanceof Date ? v : new Date(text(v).replace(/([+-]\d{2})$/, '$1:00')); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
  const itemOf = (x: NonNullable<ReturnType<typeof objects.get>>, r: Record<string, unknown>) => ({ ref: refOf(r, x.keys).slice(0, 128), ...(x.title && r[x.title] !== null && r[x.title] !== undefined ? { title: text(r[x.title]).slice(0, 200) } : {}),
    status: x.status ? (r[x.status] === null || r[x.status] === undefined ? { value: 'none', reason: `no value in ${x.status}` } : { value: text(r[x.status]).slice(0, 64) }) : { value: 'present' },
    ...(x.owner ? { owner_ref: r[x.owner] === null || r[x.owner] === undefined ? null : text(r[x.owner]).slice(0, 128) } : {}),
    ...(x.changed ? { updated_at: isoOf(r[x.changed]) } : {}),
    ...(x.created ? { created_at: isoOf(r[x.created]) } : {}),
    fields: Object.fromEntries(x.fields.map((f) => [f.name, value(r[f.column])])) });

  async function handle(req: ReadBridgeRequest): Promise<ReadBridgeResponse> {
    const path = req.path.split('?')[0]!;
    if (!path.startsWith('/everydeck/read/')) return { status: 404, body: { error: 'not found' } };
    // signed call (time window 5 min, request_id used once) counts instead of the Bearer; without a signature it depends on the setting
    const mode = o.signatures ?? 'required';
    const sigHeader = mode !== 'off' && req.headers ? headerOf(req.headers, 'x-everydeck-signature') : null;
    if (sigHeader) {
      const v = await verifyEverydeckRequest({ method: req.method, url: req.url ?? (req.path + (req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(Object.entries(req.query).filter((e): e is [string, string] => typeof e[1] === 'string')).toString() : '')), headers: req.headers!, body: req.body ?? null }, { keys: o.keys ?? [o.token], ...(o.seen ? { seen: o.seen } : {}) });
      if (!v.ok) return { status: 401, body: { error: `signature rejected: ${v.reason}` } };
    } else if (mode === 'required') return { status: 401, body: { error: 'signature required (X-Everydeck-Signature missing): everydeck signs every call; set signatures: "optional" only for everydeck instances that do not sign calls yet' } };
    else if (!sameToken(req.authorization, `Bearer ${o.token}`)) return { status: 401, body: { error: 'read key invalid' } };
    if (req.method.toUpperCase() !== 'GET') return { status: 405, body: { error: 'read only' } };
    if (path === '/everydeck/read/capabilities') return { status: 200, body: await capabilities() };
    const asOf = new Date().toISOString();
    // GET /everydeck/read/counts: per type of the scope the number of rows of its table, counted now
    if (path === '/everydeck/read/counts') {
      if (!o.count) return { status: 404, body: { error: 'this bridge does not count' } };
      const counts: Record<string, number> = {};
      for (const [type, x] of objects) counts[type] = Math.max(0, Math.floor(Number(await o.count({ table: x.table, keys: x.keys })) || 0));
      return { status: 200, body: { as_of: asOf, counts } };
    }
    if (path === '/everydeck/read/people') {
      const p = o.scope.people; if (!p) return { status: 404, body: { error: 'no people in the read scope' } };
      const { limit, after, bad } = page(req.query); if (bad) return { status: 400, body: { error: 'bad cursor' } };
      const cols = uniq([p.ref, ...Object.values(p.fields), ...(p.name ?? []).flatMap((st) => st.columns), ...(p.created ? [p.created] : [])]);
      const rows = await o.rows({ table: p.table, columns: cols, keys: [p.ref], after, limit: limit + 1 });
      const kept = rows.slice(0, limit);
      // the display name by the app's rule: the first stage with content; per stage the non-empty parts joined with the app's separator
      const nameOf = (r: Record<string, unknown>): string | null => { for (const st of p.name ?? []) { const parts = st.columns.map((c) => (r[c] === null || r[c] === undefined ? '' : text(r[c]).trim())).filter(Boolean); if (parts.length) return parts.join(st.separator ?? ' ').slice(0, VALUE_MAX); } return null; };
      const items = kept.map((r) => ({ subject_ref: text(r[p.ref]).slice(0, 128), ...Object.fromEntries(Object.entries(p.fields).map(([f, c]) => [f, r[c] === null || r[c] === undefined ? null : text(r[c]).slice(0, VALUE_MAX)])), ...(p.name?.length && 'display_name' in p.fields ? { display_name: nameOf(r) } : {}), ...(p.created ? { created_at: isoOf(r[p.created]) } : {}) }));
      return { status: 200, body: { as_of: asOf, items, next_cursor: rows.length > limit ? b64([text(kept[kept.length - 1]![p.ref])]) : null } };
    }
    // GET /everydeck/read/messages/{type}/{ref}: the messages of a conversation, ascending by time; on demand only, everydeck stores nothing
    const mm = /^\/everydeck\/read\/messages\/([^/]+)\/([^/]+)$/.exec(path);
    if (mm) {
      const type = decodeURIComponent(mm[1]!); if (!o.match) return { status: 404, body: { error: 'this bridge reads no conversations' } };
      const ref = decodeURIComponent(mm[2]!);
      // only with everydeck's grant for exactly this conversation (opened with a reason); table and columns are only in the grant
      const grant = await grantOf(o.keys ?? [o.token], req.query, type, ref);
      if (typeof grant === 'string') return { status: 403, body: { error: `a conversation is read only when a moderator opens it with a reason in everydeck (${grant})` } };
      const conv = { messages: grant.messages, attachments: grant.attachments };
      const { limit, after, bad } = page(req.query); if (bad) return { status: 400, body: { error: 'bad cursor' } };
      const m = conv.messages; const order = [m.time, ...m.ref]; if (after && after.length !== order.length) return { status: 400, body: { error: 'bad cursor' } };
      const rows = await o.match({ table: m.table, columns: uniq([...m.ref, m.conversation, m.sender, m.time, ...m.text]), where: { column: m.conversation, values: [ref] }, order, after, limit: limit + 1 });
      const kept = rows.slice(0, limit); const ids = kept.map((r) => refOf(r, m.ref));
      const att = new Map<string, { kind: 'image' | 'file'; name?: string; url?: string }[]>();
      if (conv.attachments && ids.length && m.ref.length === 1) {
        const a = conv.attachments; const arows = await o.match({ table: a.table, columns: uniq([a.message, a.url, ...(a.name ? [a.name] : [])]), where: { column: a.message, values: ids }, order: [a.message], after: null, limit: PAGE_MAX });
        for (const r of arows) { const k = text(r[a.message]); const list = att.get(k) ?? []; if (list.length < 10) list.push({ kind: a.kind, ...(a.name && r[a.name] != null ? { name: text(r[a.name]).slice(0, 200) } : {}), ...(r[a.url] != null ? { url: text(r[a.url]).slice(0, 2048) } : {}) }); att.set(k, list); }
      }
      const items = kept.map((r, i) => ({ id: ids[i]!.slice(0, 128), sender_ref: r[m.sender] == null ? 'unknown' : text(r[m.sender]).slice(0, 128), sent_at: isoOf(r[m.time]) ?? asOf, text: m.text.map((c) => (r[c] == null ? '' : text(r[c]))).filter(Boolean).join('\n').slice(0, 4000), ...(att.get(ids[i]!)?.length ? { attachments: att.get(ids[i]!) } : {}) }));
      const last = kept[kept.length - 1];
      return { status: 200, body: { type, ref: ref.slice(0, 128), as_of: asOf, items, next_cursor: rows.length > limit && last ? b64([isoOf(last[m.time]) ?? '', ...m.ref.map((k) => text(last[k]))]) : null } };
    }
    // single fetch GET /everydeck/read/objects/{type}/{ref} (identifier = key values, several joined with "|")
    const m1 = /^\/everydeck\/read\/objects\/([^/]+)\/([^/]+)$/.exec(path);
    if (m1) {
      const type = decodeURIComponent(m1[1]!); const x = objects.get(type); if (!x) return { status: 404, body: { error: `unknown type ${type}` } };
      if (!o.one) return { status: 404, body: { error: 'fetching one object is not supported by this bridge' } };
      const ref = decodeURIComponent(m1[2]!).split('|'); if (ref.length !== x.keys.length) return { status: 400, body: { error: 'bad ref' } };
      const r = await o.one({ table: x.table, columns: x.columns, keys: x.keys, ref });
      if (!r) return { status: 404, body: { error: 'not found', type, ref: ref.join('|') } };
      return { status: 200, body: { type, as_of: asOf, item: itemOf(x, r) } };
    }
    const m = /^\/everydeck\/read\/objects\/([^/]+)$/.exec(path);
    if (m) {
      const type = decodeURIComponent(m[1]!); const x = objects.get(type); if (!x) return { status: 404, body: { error: `unknown type ${type}` } };
      const { limit, after, bad } = page(req.query); if (bad) return { status: 400, body: { error: 'bad cursor' } };
      // ?changed_since=<ISO> returns only changed rows, stable by (change column, key); plus deleted rows where the app knows them
      const sinceRaw = req.query?.['changed_since'];
      if (sinceRaw !== undefined) {
        if (!x.changed) return { status: 400, body: { error: `changed_since is not supported for ${type}: no column the database sets on every change` } };
        const since = isoOf(sinceRaw); if (!since) return { status: 400, body: { error: 'bad changed_since (ISO-8601 expected)' } };
        if (after && after.length !== x.keys.length + 1) return { status: 400, body: { error: 'bad cursor' } };
        const rows = await o.rows({ table: x.table, columns: x.columns, keys: x.keys, after, limit: limit + 1, changed: { column: x.changed, since } });
        const kept = rows.slice(0, limit); const last = kept[kept.length - 1];
        const deleted = o.deleted && !after ? (await o.deleted({ table: x.table, keys: x.keys, since, limit: PAGE_MAX })).slice(0, PAGE_MAX).map((d) => ({ ref: d.ref.slice(0, 128), deleted_at: isoOf(d.deleted_at) ?? asOf })) : undefined;
        return { status: 200, body: { type, as_of: asOf, changed_since: since, items: kept.map((r) => itemOf(x, r)), ...(deleted ? { deleted } : {}), next_cursor: rows.length > limit && last ? b64([isoOf(last[x.changed]) ?? '', ...x.keys.map((k) => text(last[k]))]) : null } };
      }
      if (after && after.length !== x.keys.length) return { status: 400, body: { error: 'bad cursor' } };
      const rows = await o.rows({ table: x.table, columns: x.columns, keys: x.keys, after, limit: limit + 1 });
      const kept = rows.slice(0, limit);
      return { status: 200, body: { type, as_of: asOf, items: kept.map((r) => itemOf(x, r)), next_cursor: rows.length > limit ? b64(x.keys.map((k) => text(kept[kept.length - 1]![k]))) : null } };
    }
    return { status: 404, body: { error: 'not found' } };
  }
  /** fetch adapter (Deno.serve, Supabase Edge Function, Cloudflare, Node 22): `prefix` is the path part before /everydeck/read, e.g. /everydeck-read-bridge on Supabase */
  const fetchHandler = (prefix = '') => async (req: Request): Promise<Response> => {
    const url = new URL(req.url); const path = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const r = await handle({ method: req.method, path, query: Object.fromEntries(url.searchParams), authorization: req.headers.get('authorization') ?? undefined, headers: req.headers, url: url.pathname + url.search, body: req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer()) });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  /** Node adapter: (req, res) for node:http or Express-style servers */
  const node = () => async (req: { method?: string | undefined; url?: string | undefined; headers: Record<string, string | string[] | undefined> }, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }) => {
    const url = new URL(req.url ?? '/', 'http://bridge');
    const r = await handle({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: Array.isArray(req.headers['authorization']) ? req.headers['authorization'][0] : req.headers['authorization'], headers: req.headers, url: url.pathname + url.search, body: null });
    const body = JSON.stringify(r.body); res.writeHead(r.status, { 'content-type': 'application/json', 'content-length': String(enc.encode(body).length) }); res.end(body);
  };
  return { handle, fetch: fetchHandler, node, capabilities, rights };
}

/** node-pg reads a `date` as a Date at midnight in the local time zone of the app server: in Bali (UTC+8) the 19th left as `…-18T16:00:00.000Z`.
 *  The bridge reads `date` and `date[]` as text and sends the calendar day as midnight UTC (`2026-10-19T00:00:00.000Z`, like postgres.js and the Supabase
 *  bridge), only on its own queries (node-pg `types` per query): the app's own queries keep their parsers, and every other type keeps the parser of the
 *  app's client. Other clients (postgres.js, wrappers) get `query(text, values)` as before. */
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (v: string): string => (DAY_TEXT.test(v) ? `${v}T00:00:00.000Z` : v);   // 'infinity' and BC dates stay text
const daysOf = (v: string): (string | null)[] | string => { const inner = v.slice(1, -1); if (!v.startsWith('{') || inner.includes('{')) return v; return inner ? inner.split(',').map((x) => (x === 'NULL' ? null : dayOf(x))) : []; };
type TypeParser = (oid: number, format?: string) => unknown;
interface PgClient { query: (config: { text: string; values: unknown[]; types: { getTypeParser: TypeParser } }) => Promise<{ rows: Record<string, unknown>[] }>; getTypeParser: TypeParser }
interface PgPool { connect: () => Promise<QueryClient & { release: (err?: Error | boolean) => void }>; Client: unknown }
const isPgClient = (c: unknown): c is PgClient => typeof c === 'object' && c !== null && typeof (c as { getTypeParser?: unknown }).getTypeParser === 'function' && typeof (c as { query?: unknown }).query === 'function';
const isPgPool = (c: unknown): c is PgPool => typeof c === 'object' && c !== null && typeof (c as { connect?: unknown }).connect === 'function' && typeof (c as { Client?: unknown }).Client === 'function';
/** One query of the bridge: with a pg Client (or a client of a pg Pool) `date` as the calendar day, otherwise the client as it is */
export async function readQuery(client: QueryClient, text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
  if (isPgClient(client)) {
    const own = client.getTypeParser.bind(client);
    return client.query({ text, values, types: { getTypeParser: (oid, format) => ((format ?? 'text') !== 'text' ? own(oid, format) : oid === 1082 ? dayOf : oid === 1182 ? daysOf : own(oid, format)) } });
  }
  if (isPgPool(client)) {   // like pool.query(): one client of the pool for this query
    const c = await client.connect();
    try { const r = await readQuery(c, text, values); c.release(); return r; } catch (e) { c.release(e instanceof Error ? e : true); throw e; }
  }
  return client.query(text, values);
}
const ident = (name: string) => name.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
/** Name of the view in the reader role's schema (everydeck's SQL creates it): the table, outside public `<schema>__<table>` */
export const readViewName = (table: string): string => (table.includes('.') ? table.replace('.', '__') : table);
/** `rows` for `pg`/`postgres` (any client with `query(text, values)`): keyset cursor over the key columns, only the named columns.
 *  `schema`: the reader role's views (e.g. everydeck_read) instead of the tables, so the app's row security does not apply to the reader */
export function pgRows(client: QueryClient, o: { schema?: string } = {}): ReadRows {
  return async ({ table, columns, keys, after, limit, changed }) => {
    const from = o.schema ? `${ident(o.schema)}.${ident(readViewName(table))}` : ident(table);
    const lim = `LIMIT ${Math.max(1, Math.min(PAGE_MAX + 1, limit))}`;
    if (changed) {   // only rows changed since `since`, stable by (change column, key); cursor = [change time, ...key]
      const order = [changed.column, ...keys]; const params: unknown[] = [changed.since];
      let where = ` WHERE ${ident(changed.column)} >= $1`;
      if (after && after.length === order.length) { where += ` AND (${order.map(ident).join(', ')}) > (${order.map((_, i) => `$${i + 2}`).join(', ')})`; params.push(...after); }
      return (await readQuery(client, `SELECT ${uniq([...columns, changed.column]).map(ident).join(', ')} FROM ${from}${where} ORDER BY ${order.map(ident).join(', ')} ${lim}`, params)).rows;
    }
    const where = after && after.length === keys.length ? ` WHERE (${keys.map(ident).join(', ')}) > (${keys.map((_, i) => `$${i + 1}`).join(', ')})` : '';
    const sql = `SELECT ${columns.map(ident).join(', ')} FROM ${from}${where} ORDER BY ${keys.map(ident).join(', ')} ${lim}`;
    return (await readQuery(client, sql, where ? after! : [])).rows;
  };
}
/** `one` for `pg`/`postgres`: exactly one row by its key values */
export function pgOne(client: QueryClient, o: { schema?: string } = {}): ReadOne {
  return async ({ table, columns, keys, ref }) => {
    const from = o.schema ? `${ident(o.schema)}.${ident(readViewName(table))}` : ident(table);
    const r = (await readQuery(client, `SELECT ${columns.map(ident).join(', ')} FROM ${from} WHERE (${keys.map(ident).join(', ')}) = (${keys.map((_, i) => `$${i + 1}`).join(', ')}) LIMIT 1`, ref)).rows;
    return r[0] ?? null;
  };
}
/** `count` for `pg`/`postgres`: count(*) of the table (or the reader role's view) */
export function pgCount(client: QueryClient, o: { schema?: string } = {}): ReadCount {
  return async ({ table }) => {
    const from = o.schema ? `${ident(o.schema)}.${ident(readViewName(table))}` : ident(table);
    return Number((await readQuery(client, `SELECT count(*) AS n FROM ${from}`)).rows[0]?.['n'] ?? 0);
  };
}
/** `match` for `pg`/`postgres`: rows with `where.column = ANY(values)`, keyset cursor over `order` */
export function pgMatch(client: QueryClient, o: { schema?: string } = {}): ReadMatch {
  return async ({ table, columns, where, order, after, limit }) => {
    const from = o.schema ? `${ident(o.schema)}.${ident(readViewName(table))}` : ident(table);
    const params: unknown[] = [where.values]; let cond = `${ident(where.column)}::text = ANY($1::text[])`;
    if (after && after.length === order.length) { cond += ` AND (${order.map(ident).join(', ')}) > (${order.map((_, i) => `$${i + 2}`).join(', ')})`; params.push(...after); }
    return (await readQuery(client, `SELECT ${uniq([...columns, ...order]).map(ident).join(', ')} FROM ${from} WHERE ${cond} ORDER BY ${order.map(ident).join(', ')} LIMIT ${Math.max(1, Math.min(PAGE_MAX + 1, limit))}`, params)).rows;
  };
}
/** All tables of the scope (objects, relations, conversations, people), for the rights check and the reader role's SQL */
export const scopeTables = (scope: ReadScope): string[] => uniq([...scope.objects.map((x) => x.table), ...scope.relations.map((r) => r.table), ...(scope.conversations ?? []).flatMap((c) => [c.table, c.messages.table, ...(c.attachments ? [c.attachments.table] : [])]), ...(scope.people ? [scope.people.table] : [])]);
/** Checks the role's rights instead of claiming them: superuser (pg_roles.rolsuper) and INSERT/UPDATE/DELETE per scope table (has_table_privilege);
 * with `schema` (the reader role's views, e.g. everydeck_read) also whether the schema is reachable through the Supabase API (pgrst.db_schemas) or for anon/authenticated/PUBLIC */
/** Reachability of the view schema: in pgrst.db_schemas of the authenticator role (Supabase API), USAGE for anon / authenticated, USAGE for PUBLIC (nspacl '=U') */
export const EXPOSURE_SQL = `SELECT
  coalesce((SELECT bool_or(cfg ~ ('(^|[=, ])' || $1 || '($|[, ])')) FROM pg_db_role_setting rs JOIN pg_roles r ON r.oid = rs.setrole CROSS JOIN LATERAL unnest(rs.setconfig) AS cfg WHERE r.rolname = 'authenticator' AND cfg LIKE 'pgrst.db_schemas=%'), false) AS api,
  CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) THEN coalesce((SELECT bool_or(has_schema_privilege(r.rolname, $1, 'USAGE')) FROM pg_roles r WHERE r.rolname = 'anon'), false) ELSE false END AS anon,
  CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) THEN coalesce((SELECT bool_or(has_schema_privilege(r.rolname, $1, 'USAGE')) FROM pg_roles r WHERE r.rolname = 'authenticated'), false) ELSE false END AS authenticated,
  EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL unnest(coalesce(n.nspacl, '{}'::aclitem[])) AS a WHERE n.nspname = $1 AND a::text LIKE '=%') AS pub`;
export function pgRights(client: QueryClient, scope: ReadScope, opts: { schema?: string } = {}): () => Promise<ReadRights> {
  return async () => {
    const who = (await client.query('SELECT current_user::text AS role, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser')).rows[0] as { role: string; superuser: boolean } | undefined;
    const writable: string[] = [];
    for (const t of scopeTables(scope)) {
      // through the catalog (pg_class), not by name: has_table_privilege(name) requires USAGE on the schema and fails otherwise, which a reader role does not have
      const [schema, name] = t.includes('.') ? [t.slice(0, t.indexOf('.')), t.slice(t.indexOf('.') + 1)] : ['public', t];
      const r = (await client.query("SELECT (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE') OR has_table_privilege(current_user, c.oid, 'DELETE')) AS w FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2", [schema, name])).rows[0] as { w: boolean } | undefined;
      if (r?.w) writable.push(t);
    }
    const superuser = !!who?.superuser;
    const exposed: string[] = [];
    if (opts.schema) {   // the views run as owner (no app row security): nobody but the reader role may reach the schema
      const e = (await client.query(EXPOSURE_SQL, [opts.schema])).rows[0] as { api?: boolean; anon?: boolean; authenticated?: boolean; pub?: boolean } | undefined;
      if (e?.api) exposed.push('supabase api'); if (e?.anon) exposed.push('anon'); if (e?.authenticated) exposed.push('authenticated'); if (e?.pub) exposed.push('public');
    }
    return { role: who?.role ?? 'unknown', superuser, writable, select_only: !superuser && writable.length === 0, checked_at: new Date().toISOString(), ...(opts.schema ? { exposed } : {}) };
  };
}
