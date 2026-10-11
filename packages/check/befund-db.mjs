// B31 Schnitt D – das Schema aus der Datenbank selbst: Tabellen, Spalten (Typ, Pflicht, Standardwert, berechnet), Schlüssel, Fremdschlüssel,
// CHECK-Wertelisten, Zeilenrechte (Policies), Trigger und SQL-Funktionen aus pg_catalog. Die Datenbank ist die Wahrheit; die Migrationen im Repo
// sind die Fundstelle. pg_catalog darf jede Rolle lesen – auch die Leserolle everydeck_reader, die keine Tabelle der App selbst lesen darf.
// Verbindung: das Paket `pg` oder `postgres` aus dem Repo der App (oder neben diesem Werkzeug), sonst `psql`. Fehlt alles, bricht das Gerüst mit der
// Meldung ab – es fällt nichts still weg.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Schemata der Plattform (Postgres, Supabase), keine Tabellen der App */
export const PLATFORM_SCHEMAS = ['information_schema', 'pg_catalog', 'pg_toast', 'auth', 'storage', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'pgbouncer', 'vault', 'net', 'supabase_functions', 'supabase_migrations', 'cron', 'pgsodium', 'pgsodium_masks', '_analytics', 'topology', 'tiger', 'tiger_data', 'pgtle', 'repack', 'everydeck_read'];

export const CATALOG_SQL = `WITH s AS (SELECT oid, nspname FROM pg_namespace WHERE nspname <> ALL($1::text[]) AND nspname NOT LIKE 'pg\\_%'),
 t AS (SELECT c.oid, s.nspname AS schema, c.relname AS name FROM pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition),
 cols AS (SELECT a.attrelid, json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid), 'generated', a.attgenerated <> '') ORDER BY a.attnum) AS j
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attrelid IN (SELECT oid FROM t) GROUP BY a.attrelid),
 cons AS (SELECT k.conrelid, json_agg(json_build_object('type', k.contype, 'cols', (SELECT json_agg(attname) FROM pg_attribute WHERE attrelid = k.conrelid AND attnum = ANY(k.conkey)),
   'ref', CASE WHEN k.contype = 'f' THEN (SELECT n.nspname || '.' || c2.relname FROM pg_class c2 JOIN pg_namespace n ON n.oid = c2.relnamespace WHERE c2.oid = k.confrelid) END,
   'refcols', (SELECT json_agg(attname) FROM pg_attribute WHERE attrelid = k.confrelid AND attnum = ANY(k.confkey)), 'def', pg_get_constraintdef(k.oid))) AS j FROM pg_constraint k WHERE k.conrelid IN (SELECT oid FROM t) GROUP BY k.conrelid),
 trg AS (SELECT g.tgrelid, json_agg(json_build_object('name', g.tgname, 'before', (g.tgtype & 2) <> 0, 'update', (g.tgtype & 16) <> 0, 'insert', (g.tgtype & 4) <> 0, 'function', p.proname, 'def', pg_get_triggerdef(g.oid))) AS j
   FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT oid FROM t) GROUP BY g.tgrelid)
SELECT json_build_object(
 'tables', coalesce((SELECT json_agg(json_build_object('schema', t.schema, 'name', t.name, 'columns', coalesce(cols.j, '[]'), 'constraints', coalesce(cons.j, '[]'), 'triggers', coalesce(trg.j, '[]')) ORDER BY t.schema, t.name)
   FROM t LEFT JOIN cols ON cols.attrelid = t.oid LEFT JOIN cons ON cons.conrelid = t.oid LEFT JOIN trg ON trg.tgrelid = t.oid), '[]'),
 'policies', coalesce((SELECT json_agg(json_build_object('schema', n.nspname, 'table', c.relname, 'qual', pg_get_expr(pl.polqual, pl.polrelid), 'check', pg_get_expr(pl.polwithcheck, pl.polrelid)))
   FROM pg_policy pl JOIN pg_class c ON c.oid = pl.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.oid IN (SELECT oid FROM s)), '[]'),
 'functions', coalesce((SELECT json_agg(json_build_object('schema', n.nspname, 'name', p.proname, 'args', pg_get_function_arguments(p.oid), 'returns_trigger', p.prorettype = 'trigger'::regtype, 'src', p.prosrc))
   FROM pg_proc p JOIN s n ON n.oid = p.pronamespace WHERE p.prokind = 'f'), '[]')) AS catalog`;

/** Liest den Katalog: { tables, policies, functions } – oder wirft mit einer verständlichen Meldung */
export async function readCatalog(url, repo, files = []) {
  const roots = [repo, ...files.filter((f) => f.endsWith('package.json')).map((f) => dirname(f))].map((d) => join(d, 'package.json'));
  for (const r of [...roots, import.meta.url]) {
    let mod = null; let kind = null;
    try { mod = createRequire(r)('pg'); kind = 'pg'; } catch { try { mod = createRequire(r)('postgres'); kind = 'postgres'; } catch { /* weiter */ } }
    if (!mod) continue;
    if (kind === 'pg') { const c = new (mod.Client ?? mod.default.Client)({ connectionString: url }); await c.connect(); try { return (await c.query(CATALOG_SQL, [PLATFORM_SCHEMAS])).rows[0].catalog; } finally { await c.end(); } }
    const sql = (mod.default ?? mod)(url, { max: 1, prepare: false }); try { return (await sql.unsafe(CATALOG_SQL, [PLATFORM_SCHEMAS]))[0].catalog; } finally { await sql.end(); }
  }
  // psql: der Parameter als Literal (feste Liste, keine Eingabe von außen)
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
