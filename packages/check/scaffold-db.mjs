// The schema from the database itself: tables, columns (type, required, default, generated), keys, foreign keys,
// CHECK value lists, row-level policies, triggers and SQL functions from pg_catalog. The database is the truth; the migrations in the repo
// are the places in the code. Every role may read pg_catalog, including the read role everydeck_reader, which may not read any table of the app itself.
// Connection: the package `pg` or `postgres` from the app's repo (or next to this tool), otherwise `psql`. If none is available, the skeleton stops with
// a message; nothing is dropped silently.
// The same catalog without a database connection: the structure address everydeck gives for an app whose database is hosted (https://…/api/live-structure/…;
// everydeck reads it through the owner's connection with this very query, as a role without rights on the app's tables: structure only, never rows),
// or a file with that JSON.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Platform schemas (Postgres, Supabase), not tables of the app */
export const PLATFORM_SCHEMAS = ['information_schema', 'pg_catalog', 'pg_toast', 'auth', 'storage', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'pgbouncer', 'vault', 'net', 'supabase_functions', 'supabase_migrations', 'cron', 'pgsodium', 'pgsodium_masks', '_analytics', 'topology', 'tiger', 'tiger_data', 'pgtle', 'repack', 'everydeck_read'];

// The text of policies, defaults and constraints names a function or table without its schema when that schema is on the search path of the session
// (auth.uid() becomes uid() for a role whose path has auth). The query sets the path of a Supabase project's postgres role for its own transaction, so the
// catalog reads the same for every caller (local --db, everydeck's query). everydeck runs it as the role authenticator, which may read no table of the app
// at all; a schema the caller may not use drops out of its search path, so types and functions from there come with their schema (extensions.geography;
// the type is written without it, plainTypes below).
export const CATALOG_SQL = `WITH cfg AS MATERIALIZED (SELECT pg_catalog.set_config('search_path', '"$user", public, extensions', true) AS search_path),
 s AS (SELECT oid, nspname FROM pg_catalog.pg_namespace, cfg WHERE nspname <> ALL($1::text[]) AND nspname NOT LIKE 'pg\\_%'),
 t AS (SELECT c.oid, s.nspname AS schema, c.relname AS name FROM pg_catalog.pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition),
 cols AS (SELECT a.attrelid, json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid), 'generated', a.attgenerated <> '') ORDER BY a.attnum) AS j
   FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attrelid IN (SELECT oid FROM t) GROUP BY a.attrelid),
 cons AS (SELECT k.conrelid, json_agg(json_build_object('type', k.contype, 'cols', (SELECT json_agg(attname) FROM pg_catalog.pg_attribute WHERE attrelid = k.conrelid AND attnum = ANY(k.conkey)),
   'ref', CASE WHEN k.contype = 'f' THEN (SELECT n.nspname || '.' || c2.relname FROM pg_catalog.pg_class c2 JOIN pg_catalog.pg_namespace n ON n.oid = c2.relnamespace WHERE c2.oid = k.confrelid) END,
   'refcols', (SELECT json_agg(attname) FROM pg_catalog.pg_attribute WHERE attrelid = k.confrelid AND attnum = ANY(k.confkey)), 'def', pg_get_constraintdef(k.oid))) AS j FROM pg_catalog.pg_constraint k WHERE k.conrelid IN (SELECT oid FROM t) GROUP BY k.conrelid),
 trg AS (SELECT g.tgrelid, json_agg(json_build_object('name', g.tgname, 'before', (g.tgtype & 2) <> 0, 'update', (g.tgtype & 16) <> 0, 'insert', (g.tgtype & 4) <> 0, 'function', p.proname, 'def', pg_get_triggerdef(g.oid))) AS j
   FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_proc p ON p.oid = g.tgfoid WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT oid FROM t) GROUP BY g.tgrelid)
SELECT json_build_object(
 'tables', coalesce((SELECT json_agg(json_build_object('schema', t.schema, 'name', t.name, 'columns', coalesce(cols.j, '[]'), 'constraints', coalesce(cons.j, '[]'), 'triggers', coalesce(trg.j, '[]')) ORDER BY t.schema, t.name)
   FROM t LEFT JOIN cols ON cols.attrelid = t.oid LEFT JOIN cons ON cons.conrelid = t.oid LEFT JOIN trg ON trg.tgrelid = t.oid), '[]'),
 'policies', coalesce((SELECT json_agg(json_build_object('schema', n.nspname, 'table', c.relname, 'qual', pg_get_expr(pl.polqual, pl.polrelid), 'check', pg_get_expr(pl.polwithcheck, pl.polrelid)))
   FROM pg_catalog.pg_policy pl JOIN pg_catalog.pg_class c ON c.oid = pl.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.oid IN (SELECT oid FROM s)), '[]'),
 'functions', coalesce((SELECT json_agg(json_build_object('schema', n.nspname, 'name', p.proname, 'args', pg_get_function_arguments(p.oid), 'returns_trigger', p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype, 'src', p.prosrc))
   FROM pg_catalog.pg_proc p JOIN s n ON n.oid = p.pronamespace WHERE p.prokind = 'f'), '[]')) AS catalog`;

/** A catalog of another source (structure address, file): the shape the query gives, or an error that says what is wrong */
export function checkedCatalog(c, from) {
  const ok = c && typeof c === 'object' && ['tables', 'policies', 'functions'].every((k) => Array.isArray(c[k]))
    && c.tables.every((t) => t && typeof t.schema === 'string' && typeof t.name === 'string' && Array.isArray(t.columns) && Array.isArray(t.constraints) && Array.isArray(t.triggers));
  if (!ok) throw new Error(`${from} is not a database structure (expected { tables, policies, functions } as everydeck gives it)`);
  return c;
}

/** The structure address of everydeck (https, or http on this computer): the catalog it read, never rows */
async function fetchCatalog(url) {
  let r;
  try { r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(120_000) }); }
  catch (e) { throw new Error(`cannot reach the structure address (${String(e?.cause?.code ?? e?.message ?? e).split('\n')[0]})`); }
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300); try { msg = JSON.parse(text).message ?? msg; } catch { /* plain text */ }
    throw new Error(`the structure address answered ${r.status}: ${msg}`);
  }
  try { return checkedCatalog(JSON.parse(text), 'the answer of the structure address'); } catch (e) { throw e instanceof SyntaxError ? new Error('the structure address did not answer JSON') : e; }
}

/** --db is a database url, everydeck's structure address (http/https) or a JSON file with the same catalog */
export const isStructureSource = (src) => /^https?:\/\//i.test(src) || /\.json$/i.test(src);

// A role that may not use the schema extensions (everydeck reads a hosted database as authenticator) gets types from there with their schema
// (extensions.geography, extensions.vector(1536)); a role that may use it gets geography. The type of a column is written without that leading schema, so
// every source gives the same type. Only the type: defaults and expressions stay as the database wrote them.
export const EXTENSIONS_PREFIX = /^extensions\./;
export function plainTypes(catalog) {
  for (const t of catalog.tables) for (const c of t.columns) if (c && typeof c.type === 'string') c.type = c.type.replace(EXTENSIONS_PREFIX, '');
  return catalog;
}

/** Reads the catalog: { tables, policies, functions }, or throws with a clear message; types without a leading extensions. (plainTypes) */
export async function readCatalog(url, repo, files = []) {
  return plainTypes(await readAnyCatalog(url, repo, files));
}

async function readAnyCatalog(url, repo, files) {
  if (/^https?:\/\//i.test(url)) return fetchCatalog(url);
  if (/\.json$/i.test(url)) { let c; try { c = JSON.parse(readFileSync(url, 'utf8')); } catch (e) { throw new Error(`cannot read the structure file ${url} (${String(e?.message ?? e).split('\n')[0]})`); } return checkedCatalog(c, url); }
  const roots = [repo, ...files.filter((f) => f.endsWith('package.json')).map((f) => dirname(f))].map((d) => join(d, 'package.json'));
  for (const r of [...roots, import.meta.url]) {
    let mod = null; let kind = null;
    try { mod = createRequire(r)('pg'); kind = 'pg'; } catch { try { mod = createRequire(r)('postgres'); kind = 'postgres'; } catch { /* next */ } }
    if (!mod) continue;
    if (kind === 'pg') { const c = new (mod.Client ?? mod.default.Client)({ connectionString: url }); await c.connect(); try { return (await c.query(CATALOG_SQL, [PLATFORM_SCHEMAS])).rows[0].catalog; } finally { await c.end(); } }
    const sql = (mod.default ?? mod)(url, { max: 1, prepare: false }); try { return (await sql.unsafe(CATALOG_SQL, [PLATFORM_SCHEMAS]))[0].catalog; } finally { await sql.end(); }
  }
  // psql: the parameter as a literal (fixed list, no outside input)
  const lit = `ARRAY[${PLATFORM_SCHEMAS.map((x) => `'${x}'`).join(',')}]`;
  try { return JSON.parse(execFileSync('psql', [url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', CATALOG_SQL.replace('$1::text[]', `${lit}::text[]`)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { throw new Error(`cannot read the database schema at the given URL: no pg/postgres package and psql failed (${String(e.stderr ?? e.message ?? e).split('\n')[0]})`); }
}

/** CHECK (col = ANY (ARRAY['a'::text, 'b'::text])) / CHECK (col IN ('a','b')) → { col, values } */
export function checkValues(def) {
  const m = /CHECK \(\(?\(?"?([A-Za-z_]\w*)"?\)?(?:::text)?\s*(?:=\s*ANY\s*\(\(?ARRAY\[([^\]]*)\]|IN\s*\(([^)]*)\))/i.exec(def ?? '');
  if (!m) return null;
  const values = [...(m[2] ?? m[3] ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
  return values.length ? { col: m[1], values } : null;
}
