/**
 * @everydeck/sdk – die allgemeine Lese-Brücke (B29 Abnahme, docs/04 „Lese-Bridge“): ein Endpunkt je deklarierter Tabelle, nur deklarierte Spalten,
 * mit Cursor. Der Agent schreibt keine Brücke mehr je App: er holt den Lese-Umfang (`everydeck/everydeck-read-scope.json`, aus dem Befund abgeleitet) und
 * liefert eine Funktion `rows`, die Zeilen aus der Datenbank der App liest – über eine eigene Leserolle (nur SELECT). `pgRows(client)` ist die
 * fertige Fassung für `pg` oder `postgres` (jeder Client mit `query(text, values)`), `pgRights(client, scope)` prüft beim Start die tatsächlichen
 * Rechte dieser Rolle (Superuser, INSERT/UPDATE/DELETE je Tabelle) – die Brücke meldet sie in `rights`, statt sie zu behaupten.
 *
 * Läuft in Node ≥ 22, Deno (Supabase Edge Functions) und jeder fetch-Laufzeit: kein `Buffer`, kein `node:`-Modul. `handle()` ist die reine
 * Funktion, `fetch()` der Adapter für Request/Response (Deno.serve), `node()` der für node:http.
 *
 * Vertrag (read-bridge.schema.json): GET /everydeck/read/capabilities · GET /everydeck/read/objects/{type}?cursor&limit[&changed_since=<ISO>] · GET /everydeck/read/objects/{type}/{ref} · GET /everydeck/read/people?cursor&limit
 * · B31: GET /everydeck/read/messages/{type}/{ref}?cursor&limit (Nachrichten eines Gesprächs, nur auf Abruf mit `match`);
 * B30 Schnitt A (inkrementell wie Fivetran): mit `changed_since` nur Geändertes, stabil nach (Änderungsspalte, Schlüssel), dazu `deleted` wo die App Löschungen kennt; Einzelabruf nach einem Signal; die Fähigkeiten nennen je Objektart `changed_since` und `fetch_one`;
 * eigener Bearer-Schlüssel (zeitkonstant verglichen); jedes Schreibverb wird abgewiesen; Seiten ≤ 200; Kennungen als Text (mehrere Schlüsselspalten
 * mit „|“ verbunden); Zeitstempel als ISO-8601; Objektwerte als JSON-Text; kein Wert länger als 256 Zeichen. Beziehungen (Verknüpfungstabellen)
 * werden wie Objektarten geliefert (type = relations[].id, fields = die beiden Seiten). Nichts außerhalb des Umfangs ist erreichbar.
 */
import { verifyEverydeckRequest, type HeadersLike, type VerifyOptions } from './verify.js';
const headerOf = (h: HeadersLike, name: string): string | null => { if (typeof (h as { get?: unknown }).get === 'function') return (h as { get(n: string): string | null }).get(name); const v = (h as Record<string, string | string[] | undefined>)[name] ?? (h as Record<string, string | string[] | undefined>)[name.toLowerCase()]; return Array.isArray(v) ? v[0] ?? null : v ?? null; };
export interface ReadScopeField { name: string; column: string }
export interface ReadScopeObject { type: string; table: string; ref: string[]; title?: string; status?: string; owner?: string; fields: ReadScopeField[]; statuses?: string[]; /** B30 Schnitt A: die Spalte, die die Datenbank bei jeder Änderung setzt (Trigger/onupdate) – erlaubt `changed_since`; ohne sie nur Volllauf */ changed?: string }
export interface ReadScopeRelation { id: string; table: string; ref: string[]; fields: ReadScopeField[] }
/** B35: name = Regel der App für den Anzeigenamen (Stufen nacheinander; je Stufe die Spalten, verbunden mit dem Trennzeichen der App) */
export interface ReadScopePeople { table: string; ref: string; fields: Record<string, string>; name?: { columns: string[]; separator?: string }[] }
/** B31 Schnitt A: ein Gespräch – die Nachrichten liefert die Brücke nur auf Abruf (GET /everydeck/read/messages/{type}/{ref}), everydeck speichert sie nicht */
export interface ReadScopeConversation { type: string; table: string; ref: string[]; messages: { table: string; ref: string[]; conversation: string; sender: string; time: string; text: string[] }; attachments?: { table: string; message: string; url: string; name?: string; kind: 'image' | 'file' } }
export interface ReadScope { version: '1'; objects: ReadScopeObject[]; relations: ReadScopeRelation[]; conversations?: ReadScopeConversation[]; people: ReadScopePeople | null }
/** Rechte der Datenbankrolle – geprüft, nicht behauptet */
export interface ReadRights { role: string; select_only: boolean; superuser?: boolean; writable?: string[]; checked_at?: string; /** B29 vierte Runde: wer außer der Leserolle an das Sichten-Schema kommt – 'supabase api' (pgrst.db_schemas des authenticator), 'anon', 'authenticated', 'public' (USAGE auf dem Schema); leer = niemand */ exposed?: string[] }

/** Zeilen einer Tabelle, sortiert nach den Schlüsselspalten, ab einem Cursor (Werte der Schlüsselspalten der letzten Zeile), höchstens `limit`.
 *  B30 Schnitt A: mit `changed` nur Zeilen mit changed.column ≥ since, stabil sortiert nach (changed.column, Schlüssel); der Cursor ist dann [Änderungszeit, …Schlüssel] */
export type ReadRows = (q: { table: string; columns: string[]; keys: string[]; after: string[] | null; limit: number; changed?: { column: string; since: string } | undefined }) => Promise<Record<string, unknown>[]>;
/** B30 Schnitt A: genau eine Zeile nach ihren Schlüsselwerten (Einzelabruf nach einem Signal) */
export type ReadOne = (q: { table: string; columns: string[]; keys: string[]; ref: string[] }) => Promise<Record<string, unknown> | null>;
/** B30 Schnitt A: Löschungen, die die App kennt (Soft-Delete-Spalte, Löschtabelle) – [{ ref, deleted_at }] seit `since`; ohne Adapter kommt Gelöschtes über die Inventur */
export type ReadDeleted = (q: { table: string; keys: string[]; since: string; limit: number }) => Promise<{ ref: string; deleted_at: string }[]>;
/** B31 Schnitt A: Zeilen, deren Spalte `where.column` einen der Werte hat, sortiert nach `order`, ab einem Cursor (Werte der Sortierspalten) – für die Nachrichten eines Gesprächs */
export type ReadMatch = (q: { table: string; columns: string[]; where: { column: string; values: string[] }; order: string[]; after: string[] | null; limit: number }) => Promise<Record<string, unknown>[]>;
export interface ReadBridgeOptions { scope: ReadScope; token: string;
  /** B31 Schnitt A: Nachrichten eines Gesprächs auf Abruf (pgMatch); ohne `match` bietet die Brücke keine Gespräche an */ match?: ReadMatch;
  /** B30 Schnitt E: everydeck signiert jeden Aufruf – `required` (Standard) lehnt unsignierte Aufrufe ab, `optional` nimmt den Bearer, wenn keine Signatur da ist (ältere everydeck-Stände), `off` prüft nur den Bearer */ signatures?: 'required' | 'optional' | 'off';
  /** gültige Schlüssel für die Signatur (Standard: `token`; während eines Tauschs der neue und der alte) */ keys?: string[]; /** Replay-Schutz über mehrere Instanzen (Standard: Speicher dieses Prozesses) */ seen?: VerifyOptions['seen']; rows: ReadRows; one?: ReadOne; deleted?: ReadDeleted; app?: string; pageLimit?: number; /** fest oder beim ersten Aufruf geprüft (pgRights) */ rights?: ReadRights | (() => Promise<ReadRights>) }
export interface ReadBridgeRequest { method: string; path: string; query?: Record<string, string | undefined>; authorization?: string | undefined;
  /** B30 Schnitt E: Kopfzeilen (X-Everydeck-Timestamp, X-Everydeck-Request-Id, X-Everydeck-Signature) und der Pfad mit Query, wie die App ihn sieht – für die Signaturprüfung */ headers?: HeadersLike | undefined; url?: string | undefined; body?: string | Uint8Array | null | undefined }
export interface ReadBridgeResponse { status: number; body: unknown }
export interface QueryClient { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

const PAGE_MAX = 200; const VALUE_MAX = 256;
const enc = new TextEncoder(); const dec = new TextDecoder();
const b64 = (v: string[]) => { const bytes = enc.encode(JSON.stringify(v)); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = (c: string): string[] | null => { try { const bin = atob(c.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (c.length % 4)) % 4)); const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0)); const v = JSON.parse(dec.decode(bytes)); return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null; } catch { return null; } };
/** Schlüsselvergleich in konstanter Zeit (keine frühe Rückkehr je Zeichen) */
export function sameToken(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = enc.encode(a); const y = enc.encode(b); let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i % x.length] ?? 0) ^ (y[i % y.length] ?? 0);
  return d === 0 && x.length === y.length;
}
const text = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** Feldwert in der Transportform: Zahl, Ja/Nein, Text (≤ 256), sonst JSON-Text; Zeitstempel ISO-8601 */
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
  const objects = new Map<string, { table: string; keys: string[]; columns: string[]; title?: string | undefined; status?: string | undefined; owner?: string | undefined; changed?: string | undefined; fields: ReadScopeField[] }>();
  for (const x of o.scope.objects) objects.set(x.type, { table: x.table, keys: x.ref, title: x.title, status: x.status, owner: x.owner, changed: x.changed, fields: x.fields, columns: uniq([...x.ref, ...(x.title ? [x.title] : []), ...(x.status ? [x.status] : []), ...(x.owner ? [x.owner] : []), ...(x.changed ? [x.changed] : []), ...x.fields.map((f) => f.column)]) });
  for (const r of o.scope.relations) objects.set(r.id, { table: r.table, keys: r.ref, fields: r.fields, columns: uniq([...r.ref, ...r.fields.map((f) => f.column)]) });
  // B30 Schnitt A: die Fähigkeiten sagen je Objektart, ob `changed_since` geht (Änderungsspalte im Umfang), und ob der Einzelabruf geht
  const capabilities = async () => ({ version: '1' as const, ...(o.app ? { app: o.app } : {}), identity: 'subject_ref' as const,
    objects: [...o.scope.objects.map((x) => ({ type: x.type, fields: x.fields.map((f) => f.name), ...(x.statuses?.length ? { statuses: x.statuses } : {}), changed_since: !!x.changed })), ...o.scope.relations.map((r) => ({ type: r.id, fields: r.fields.map((f) => f.name), changed_since: false }))],
    ...(o.scope.people ? { people: { fields: Object.keys(o.scope.people.fields) } } : {}), ...(o.match && o.scope.conversations?.length ? { messages: o.scope.conversations.map((c) => c.type) } : {}), rights: await rights(), page_limit: limitMax, fetch_one: !!o.one, signed: (o.signatures ?? 'required') !== 'off' });
  const page = (q: Record<string, string | undefined> | undefined) => { const limit = Math.min(limitMax, Math.max(1, Number(q?.['limit'] ?? limitMax) || limitMax)); const after = q?.['cursor'] ? unb64(q['cursor']) : null; return { limit, after, bad: !!q?.['cursor'] && !after }; };
  const refOf = (row: Record<string, unknown>, keys: string[]) => keys.map((k) => text(row[k])).join('|');
  const isoOf = (v: unknown): string | null => { if (v === null || v === undefined) return null; const d = v instanceof Date ? v : new Date(text(v)); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
  const itemOf = (x: NonNullable<ReturnType<typeof objects.get>>, r: Record<string, unknown>) => ({ ref: refOf(r, x.keys).slice(0, 128), ...(x.title && r[x.title] !== null && r[x.title] !== undefined ? { title: text(r[x.title]).slice(0, 200) } : {}),
    status: x.status ? (r[x.status] === null || r[x.status] === undefined ? { value: 'none', reason: `no value in ${x.status}` } : { value: text(r[x.status]).slice(0, 64) }) : { value: 'present' },
    ...(x.owner ? { owner_ref: r[x.owner] === null || r[x.owner] === undefined ? null : text(r[x.owner]).slice(0, 128) } : {}),
    ...(x.changed ? { updated_at: isoOf(r[x.changed]) } : {}),
    fields: Object.fromEntries(x.fields.map((f) => [f.name, value(r[f.column])])) });

  async function handle(req: ReadBridgeRequest): Promise<ReadBridgeResponse> {
    const path = req.path.split('?')[0]!;
    if (!path.startsWith('/everydeck/read/')) return { status: 404, body: { error: 'not found' } };
    // B30 Schnitt E: signierter Aufruf (Zeitfenster 5 min, request_id einmalig) – gilt statt des Bearers; ohne Signatur je nach Einstellung
    const mode = o.signatures ?? 'required';
    const sigHeader = mode !== 'off' && req.headers ? headerOf(req.headers, 'x-everydeck-signature') : null;
    if (sigHeader) {
      const v = await verifyEverydeckRequest({ method: req.method, url: req.url ?? (req.path + (req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(Object.entries(req.query).filter((e): e is [string, string] => typeof e[1] === 'string')).toString() : '')), headers: req.headers!, body: req.body ?? null }, { keys: o.keys ?? [o.token], ...(o.seen ? { seen: o.seen } : {}) });
      if (!v.ok) return { status: 401, body: { error: `signature rejected: ${v.reason}` } };
    } else if (mode === 'required') return { status: 401, body: { error: 'signature required (X-Everydeck-Signature missing) – everydeck signs every call since B30; set signatures: "optional" for older everydeck instances' } };
    else if (!sameToken(req.authorization, `Bearer ${o.token}`)) return { status: 401, body: { error: 'read key invalid' } };
    if (req.method.toUpperCase() !== 'GET') return { status: 405, body: { error: 'read only' } };
    if (path === '/everydeck/read/capabilities') return { status: 200, body: await capabilities() };
    const asOf = new Date().toISOString();
    if (path === '/everydeck/read/people') {
      const p = o.scope.people; if (!p) return { status: 404, body: { error: 'no people in the read scope' } };
      const { limit, after, bad } = page(req.query); if (bad) return { status: 400, body: { error: 'bad cursor' } };
      const cols = uniq([p.ref, ...Object.values(p.fields), ...(p.name ?? []).flatMap((st) => st.columns)]);
      const rows = await o.rows({ table: p.table, columns: cols, keys: [p.ref], after, limit: limit + 1 });
      const kept = rows.slice(0, limit);
      // B35 Punkt 3: der Anzeigename nach der Regel der App – die erste Stufe mit Inhalt; je Stufe die nicht leeren Teile mit dem Trennzeichen der App
      const nameOf = (r: Record<string, unknown>): string | null => { for (const st of p.name ?? []) { const parts = st.columns.map((c) => (r[c] === null || r[c] === undefined ? '' : text(r[c]).trim())).filter(Boolean); if (parts.length) return parts.join(st.separator ?? ' ').slice(0, VALUE_MAX); } return null; };
      const items = kept.map((r) => ({ subject_ref: text(r[p.ref]).slice(0, 128), ...Object.fromEntries(Object.entries(p.fields).map(([f, c]) => [f, r[c] === null || r[c] === undefined ? null : text(r[c]).slice(0, VALUE_MAX)])), ...(p.name?.length && 'display_name' in p.fields ? { display_name: nameOf(r) } : {}) }));
      return { status: 200, body: { as_of: asOf, items, next_cursor: rows.length > limit ? b64([text(kept[kept.length - 1]![p.ref])]) : null } };
    }
    // B31 Schnitt A: GET /everydeck/read/messages/{type}/{ref} – die Nachrichten eines Gesprächs, aufsteigend nach Zeit; nur auf Abruf, everydeck speichert nichts
    const mm = /^\/everydeck\/read\/messages\/([^/]+)\/([^/]+)$/.exec(path);
    if (mm) {
      const type = decodeURIComponent(mm[1]!); const conv = (o.scope.conversations ?? []).find((c) => c.type === type);
      if (!conv || !o.match) return { status: 404, body: { error: `no conversations of ${type} in the read scope` } };
      const ref = decodeURIComponent(mm[2]!); const { limit, after, bad } = page(req.query); if (bad) return { status: 400, body: { error: 'bad cursor' } };
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
    // B30 Schnitt A: Einzelabruf GET /everydeck/read/objects/{type}/{ref} (Kennung = Schlüsselwerte, mehrere mit „|“)
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
      // B30 Schnitt A: ?changed_since=<ISO> liefert nur Geändertes, stabil nach (Änderungsspalte, Schlüssel); dazu Gelöschtes, wo die App es kennt
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
  /** fetch-Adapter (Deno.serve, Supabase Edge Function, Cloudflare, Node 22): `prefix` ist der Pfadteil vor /everydeck/read, z. B. /everydeck-read-bridge bei Supabase */
  const fetchHandler = (prefix = '') => async (req: Request): Promise<Response> => {
    const url = new URL(req.url); const path = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const r = await handle({ method: req.method, path, query: Object.fromEntries(url.searchParams), authorization: req.headers.get('authorization') ?? undefined, headers: req.headers, url: url.pathname + url.search, body: req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer()) });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  /** Node-Adapter: (req, res) für node:http oder Express-artige Server */
  const node = () => async (req: { method?: string | undefined; url?: string | undefined; headers: Record<string, string | string[] | undefined> }, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }) => {
    const url = new URL(req.url ?? '/', 'http://bridge');
    const r = await handle({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: Array.isArray(req.headers['authorization']) ? req.headers['authorization'][0] : req.headers['authorization'], headers: req.headers, url: url.pathname + url.search, body: null });
    const body = JSON.stringify(r.body); res.writeHead(r.status, { 'content-type': 'application/json', 'content-length': String(enc.encode(body).length) }); res.end(body);
  };
  return { handle, fetch: fetchHandler, node, capabilities, rights };
}

const ident = (name: string) => name.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
/** Name der Sicht im Schema der Leserolle (everydeck’s SQL legt sie an): Tabelle, außerhalb von public `<schema>__<tabelle>` */
export const readViewName = (table: string): string => (table.includes('.') ? table.replace('.', '__') : table);
/** `rows` für `pg`/`postgres` (jeder Client mit `query(text, values)`): Keyset-Cursor über die Schlüsselspalten, nur die genannten Spalten.
 *  `schema`: die Sichten der Leserolle (z. B. everydeck_read) statt der Tabellen – so greifen die Zeilenrechte der App nicht für den Leser */
export function pgRows(client: QueryClient, o: { schema?: string } = {}): ReadRows {
  return async ({ table, columns, keys, after, limit, changed }) => {
    const from = o.schema ? `${ident(o.schema)}.${ident(readViewName(table))}` : ident(table);
    const lim = `LIMIT ${Math.max(1, Math.min(PAGE_MAX + 1, limit))}`;
    if (changed) {   // B30 Schnitt A: nur Geändertes seit `since`, stabil nach (Änderungsspalte, Schlüssel); Cursor = [Änderungszeit, …Schlüssel]
      const order = [changed.column, ...keys]; const params: unknown[] = [changed.since];
      let where = ` WHERE ${ident(changed.column)} >= $1`;
      if (after && after.length === order.length) { where += ` AND (${order.map(ident).join(', ')}) > (${order.map((_, i) => `$${i + 2}`).join(', ')})`; params.push(...after); }
      return (await client.query(`SELECT ${uniq([...columns, changed.column]).map(ident).join(', ')} FROM ${from}${where} ORDER BY ${order.map(ident).join(', ')} ${lim}`, params)).rows;
    }
    const where = after && after.length === keys.length ? ` WHERE (${keys.map(ident).join(', ')}) > (${keys.map((_, i) => `$${i + 1}`).join(', ')})` : '';
    const sql = `SELECT ${columns.map(ident).join(', ')} FROM ${from}${where} ORDER BY ${keys.map(ident).join(', ')} ${lim}`;
    return (await client.query(sql, where ? after! : [])).rows;
  };
}
/** B30 Schnitt A: `one` für `pg`/`postgres` – genau eine Zeile nach ihren Schlüsselwerten */
export function pgOne(client: QueryClient, o: { schema?: string } = {}): ReadOne {
  return async ({ table, columns, keys, ref }) => {
    const from = o.schema ? `${ident(o.schema)}.${ident(readViewName(table))}` : ident(table);
    const r = (await client.query(`SELECT ${columns.map(ident).join(', ')} FROM ${from} WHERE (${keys.map(ident).join(', ')}) = (${keys.map((_, i) => `$${i + 1}`).join(', ')}) LIMIT 1`, ref)).rows;
    return r[0] ?? null;
  };
}
/** B31 Schnitt A: `match` für `pg`/`postgres` – Zeilen mit `where.column = ANY(values)`, Keyset-Cursor über `order` */
export function pgMatch(client: QueryClient, o: { schema?: string } = {}): ReadMatch {
  return async ({ table, columns, where, order, after, limit }) => {
    const from = o.schema ? `${ident(o.schema)}.${ident(readViewName(table))}` : ident(table);
    const params: unknown[] = [where.values]; let cond = `${ident(where.column)}::text = ANY($1::text[])`;
    if (after && after.length === order.length) { cond += ` AND (${order.map(ident).join(', ')}) > (${order.map((_, i) => `$${i + 2}`).join(', ')})`; params.push(...after); }
    return (await client.query(`SELECT ${uniq([...columns, ...order]).map(ident).join(', ')} FROM ${from} WHERE ${cond} ORDER BY ${order.map(ident).join(', ')} LIMIT ${Math.max(1, Math.min(PAGE_MAX + 1, limit))}`, params)).rows;
  };
}
/** Alle Tabellen des Umfangs (Objekte, Beziehungen, Gespräche, Personen) – für die Rechteprüfung und das SQL der Leserolle */
export const scopeTables = (scope: ReadScope): string[] => uniq([...scope.objects.map((x) => x.table), ...scope.relations.map((r) => r.table), ...(scope.conversations ?? []).flatMap((c) => [c.table, c.messages.table, ...(c.attachments ? [c.attachments.table] : [])]), ...(scope.people ? [scope.people.table] : [])]);
/** Rechte der Rolle prüfen, nicht behaupten: Superuser (pg_roles.rolsuper) und INSERT/UPDATE/DELETE je Tabelle des Umfangs (has_table_privilege);
 * mit `schema` (die Sichten der Leserolle, z. B. everydeck_read) zusätzlich, ob das Schema über die Supabase-API (pgrst.db_schemas) oder für anon/authenticated/PUBLIC erreichbar ist */
/** Erreichbarkeit des Sichten-Schemas: in pgrst.db_schemas der Rolle authenticator (Supabase-API), USAGE für anon / authenticated, USAGE für PUBLIC (nspacl '=U') */
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
      // über den Katalog (pg_class), nicht über den Namen: has_table_privilege(name) verlangt USAGE auf dem Schema und scheitert sonst – eine Leserolle hat das nicht
      const [schema, name] = t.includes('.') ? [t.slice(0, t.indexOf('.')), t.slice(t.indexOf('.') + 1)] : ['public', t];
      const r = (await client.query("SELECT (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE') OR has_table_privilege(current_user, c.oid, 'DELETE')) AS w FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2", [schema, name])).rows[0] as { w: boolean } | undefined;
      if (r?.w) writable.push(t);
    }
    const superuser = !!who?.superuser;
    const exposed: string[] = [];
    if (opts.schema) {   // die Sichten laufen als Eigentümer (keine Zeilenrechte der App): niemand außer der Leserolle darf an das Schema
      const e = (await client.query(EXPOSURE_SQL, [opts.schema])).rows[0] as { api?: boolean; anon?: boolean; authenticated?: boolean; pub?: boolean } | undefined;
      if (e?.api) exposed.push('supabase api'); if (e?.anon) exposed.push('anon'); if (e?.authenticated) exposed.push('authenticated'); if (e?.pub) exposed.push('public');
    }
    return { role: who?.role ?? 'unknown', superuser, writable, select_only: !superuser && writable.length === 0, checked_at: new Date().toISOString(), ...(opts.schema ? { exposed } : {}) };
  };
}
