#!/usr/bin/env node
// app map scaffold from the repo: a tool for the coding agent that reads only facts with their place in the code (file:line) and judges nothing.
//   everydeck-scaffold <repo> [--db <database url, a read-only role is enough>] [--out everydeck/app-map.json] [--merge <existing app map>]   (without --out: output to stdout, nothing is written into the repo)
// With --db (or EVERYDECK_SCHEMA_DB_URL) the skeleton reads the schema from the database first (scaffold-db.mjs); the migrations are the places.
// Reads: tables and columns from SQL migrations (CREATE TABLE … (…), ALTER TABLE … ADD COLUMN, CHECK (col IN (…)), REFERENCES, DEFAULT; final state: DROP TABLE and DROP COLUMN remove, RENAME COLUMN renames, CREATE TABLE … AS SELECT * FROM takes over the columns; schemas other than public; auth.users as foreign key, also from policies auth.uid() = column),
//        Alembic (op.create_table) and Firestore rules (match /name/{id}); packages from package.json/requirements*.txt (only provider packages
//        that everydeck-check knows); API routes (Express/Fastify/Hono calls, FastAPI decorators, Next.js app/api/**/route.ts); pages
//        (Next.js app/**/page.tsx, Expo Router app/**.tsx, React Router <Route path>); platforms (capacitor.config.*, app.json, ios/, android/).
//        Display places from every data access of the frontend through the syntax tree (scaffold-reads.mjs: TypeScript compiler API, Python ast), also .rpc, functions.invoke,
//        Realtime, views, API calls with template strings against the backend routes; writes and mentions as not_shown[] with a reason.
// What the tool cannot read (visible elements, write places, functions with rights, flows, identity, channels), the agent adds
// with places; `--merge` keeps these parts from an existing app map and renews only the skeleton parts.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analyseReads } from './scaffold-reads.mjs';
import { findIcon } from './scaffold-icon.mjs';
import { profileTables, shownNameColumn } from './rules/everydeck-rules.mjs';

const args = process.argv.slice(2); const repo = args[0]; if (!repo) { console.error('usage: scaffold.mjs <repo> [--db <url>] [--out file] [--merge file]'); process.exit(2); }
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.expo', 'coverage', '__pycache__', '.venv', 'venv', 'Pods', '.everydeck', 'everydeck', 'everydeck-outbox', 'supabase_types']);
const files = [];
(function walk(dir, depth) { if (depth > 7) return; for (const n of readdirSync(dir)) { if (SKIP.has(n)) continue; const p = join(dir, n); const st = statSync(p); if (st.isDirectory()) walk(p, depth + 1); else if (st.size < 2_000_000) files.push(p); } })(repo, 0);
const rel = (p) => relative(repo, p);
const text = (p) => readFileSync(p, 'utf8');
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const commit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); } catch { return '0'.repeat(40); } })();

// ── Tables from SQL ──
const tables = new Map(); const dropLater = new Set();
const addTable = (name, kind, evidence, schema) => { if (!tables.has(name)) tables.set(name, { name, ...(schema && schema.toLowerCase() !== 'public' ? { schema } : {}), kind, defined: evidence, columns: [] }); return tables.get(name); };
const qualified = (schema, name) => (schema && schema.toLowerCase() !== 'public' ? `${schema}.${name}` : name);   // foreign keys to other schemas (auth.users) keep their schema name
const sqlType = (s) => s.replace(/\s+(not\s+null|null|default\s+.*|primary\s+key.*|references.*|check.*|unique.*|generated.*)$/i, '').trim();
function parseColumns(body, file, baseLine, t) {
  let depth = 0, cur = '', parts = [];
  for (const ch of body) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) parts.push(cur);
  let line = baseLine;
  for (const raw of parts) {
    const nl = (raw.match(/\n/g) ?? []).length; const def = raw.trim(); const firstLine = line + (raw.slice(0, raw.search(/\S/)).match(/\n/g) ?? []).length; line += nl;
    if (!def || /^(constraint|primary\s+key|unique|foreign\s+key|check|exclude|index)\b/i.test(def)) {
      const chk = /check\s*\(\s*"?([a-z_]\w*)"?\s+in\s*\(([^)]*)\)/i.exec(raw); if (chk) applyEnum(t, chk[1], chk[2], file, firstLine + (raw.slice(0, chk.index).match(/\n/g) ?? []).length);
      continue;
    }
    const m = /^"?([A-Za-z_]\w*)"?\s+(.+)$/s.exec(def); if (!m) continue;
    const name = m[1]; const restAll = m[2].replace(/\s+/g, ' ');
    const col = { name, type: sqlType(restAll.split(/\s(?=not null|null|default|primary key|references|check|unique|generated)/i)[0] ?? restAll).toLowerCase() };
    if (/primary\s+key/i.test(restAll) || /\bserial\b/i.test(col.type)) col.pk = true;
    if (!/not\s+null/i.test(restAll) && !col.pk) col.nullable = true;
    const d = /default\s+((?:'[^']*')|[^\s,]+(?:\([^)]*\))?)/i.exec(restAll); if (d) col.default = d[1].replace(/^'|'$/g, '').slice(0, 120);
    const fk = /references\s+(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?\s*(?:\(\s*"?([A-Za-z_]\w*)"?\s*\))?/i.exec(restAll); if (fk) col.fk = { table: qualified(fk[1], fk[2]), ...(fk[3] ? { column: fk[3] } : {}) };
    const chk = /check\s*\(\s*"?(\w+)"?\s+in\s*\(([^)]*)\)/i.exec(raw); if (chk && chk[1] === name) col.enum = enumValues(chk[2], file, firstLine + (raw.slice(0, chk.index).match(/\n/g) ?? []).length);
    if (/default\s+now\(\)|default\s+current_timestamp|generated\s+always/i.test(restAll)) col.computed = { path: rel(file), line: firstLine };
    if (!t.columns.some((c) => c.name === name)) t.columns.push(col);
  }
}
function enumValues(list, file, baseLine) {   // each value with the line it is on (lists over several lines); NULL is not a value
  const out = []; let line = baseLine;
  for (const raw of list.split(',')) { const nl = (raw.match(/\n/g) ?? []).length; const before = (raw.slice(0, raw.search(/\S|$/)).match(/\n/g) ?? []).length; const v = raw.trim().replace(/^'|'$/g, ''); if (v && !/^null$/i.test(v) && /^'/.test(raw.trim())) out.push({ value: v, evidence: { path: rel(file), line: line + before } }); line += nl; }
  return out;
}
function applyEnum(t, colName, list, file, line) { const c = t.columns.find((x) => x.name === colName); if (c) c.enum = enumValues(list, file, line); }
const stripSql = (src) => src.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));   // strip comments, line numbers stay
// Migrations in file order: only the final state of the schema counts; a table dropped later (DROP TABLE) is not in the app map
for (const f of files.filter((p) => p.endsWith('.sql')).sort()) {
  const src = stripSql(text(f));
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?\s+as\s+select\s+\*\s+from\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) {   // CREATE TABLE … AS SELECT * FROM y: the same columns as y
    const t = addTable(m[2], 'table', { path: rel(f), line: lineOf(src, m.index), symbol: m[2] }, m[1]); const from = tables.get(m[3]); if (from && !t.columns.length) t.columns = from.columns.map((c) => ({ ...c }));
  }
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?\s+as\b/gi)) addTable(m[2], 'table', { path: rel(f), line: lineOf(src, m.index), symbol: m[2] }, m[1]);   // CREATE TABLE … AS: without a column list
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?\s*\(/gi)) {
    const start = m.index + m[0].length; let depth = 1, i = start; while (i < src.length && depth > 0) { if (src[i] === '(') depth++; if (src[i] === ')') depth--; i++; }
    const existed = tables.has(m[2]); const t = addTable(m[2], 'table', { path: rel(f), line: lineOf(src, m.index), symbol: m[2] }, m[1]);
    if (!existed) parseColumns(src.slice(start, i - 1), f, lineOf(src, start), t);   // CREATE TABLE IF NOT EXISTS on an existing table changes nothing (as in Postgres; copies of migrations in two folders)
  }
  for (const m of src.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) tables.delete(m[1]);
  // ALTER TABLE x RENAME TO y: from here on the table is called y (place: the rename, where the name is); references from other tables follow
  for (const m of src.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+rename\s+to\s+"?([A-Za-z_]\w*)"?/gi)) {
    const t = tables.get(m[1]); if (!t || tables.has(m[2])) continue;
    tables.delete(m[1]); t.name = m[2]; t.defined = { path: rel(f), line: lineOf(src, m.index), symbol: m[2] }; tables.set(m[2], t);
    for (const o of tables.values()) for (const c of o.columns) if (c.fk?.table === m[1]) c.fk.table = m[2];
  }
  // Final state per column too: ALTER TABLE … DROP COLUMN removes, RENAME COLUMN renames (also several actions per ALTER)
  for (const m of src.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+([^;]+)/gi)) {
    const t = tables.get(m[1]); if (!t) continue;
    for (const d of m[2].matchAll(/drop\s+column\s+(?:if\s+exists\s+)?"?([A-Za-z_]\w*)"?/gi)) t.columns = t.columns.filter((c) => c.name !== d[1]);
    for (const r of m[2].matchAll(/rename\s+(?:column\s+)?"?([A-Za-z_]\w*)"?\s+to\s+"?([A-Za-z_]\w*)"?/gi)) { const c = t.columns.find((x) => x.name === r[1]); if (c && !t.columns.some((x) => x.name === r[2])) c.name = r[2]; }
  }
  // Row policies that compare a column with the signed-in user (auth.uid() = column): a reference to the provider's user table
  for (const m of src.matchAll(/create\s+policy\s+"[^"]*"\s+on\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?[\s\S]*?(?:auth\.uid\(\)\s*=\s*"?([A-Za-z_]\w*)"?|"?([A-Za-z_]\w*)"?\s*=\s*auth\.uid\(\))/gi)) {
    const t = tables.get(m[1]); const c = t?.columns.find((x) => x.name === (m[2] ?? m[3])); if (c && !c.fk) c.fk = { table: 'auth.users', column: 'id' };
  }
  for (const m of src.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+((?:add\s+(?:column\s+)?[^;]+))/gi)) {
    const t = tables.get(m[1]); if (!t) continue;
    for (const part of m[2].split(/,\s*(?=add\s+)/i)) { const c = /add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([A-Za-z_]\w*)"?\s+(.+)$/is.exec(part.trim()); if (!c || /^constraint$/i.test(c[1]) || t.columns.some((x) => x.name === c[1])) continue; parseColumns(`${c[1]} ${c[2].replace(/,\s*$/, '')}`, f, lineOf(src, m.index + m[0].indexOf(part)), t); }
  }
  for (const m of src.matchAll(/alter\s+table\s+(?:only\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+add\s+constraint\s+\w+\s+check\s*\(\s*"?(\w+)"?\s+in\s*\(([^)]*)\)/gi)) { const t = tables.get(m[1]); if (t) applyEnum(t, m[2], m[3], f, lineOf(src, m.index + m[0].indexOf(m[3]))); }
}
// ── Change column: a column the database sets on every change, through a BEFORE UPDATE trigger whose function sets NEW.column = now()
//    or is moddatetime('column'). Fact with a place (columns[].updated); the read scope gets it as `changed` and allows changed_since.
{
  const setters = new Map();   // function name → column(s) the body sets to now()/current_timestamp
  for (const f of files.filter((p) => p.endsWith('.sql')).sort()) {
    const src = stripSql(text(f));
    for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\([^)]*\)[\s\S]*?\bas\s+(\$[A-Za-z_]*\$)([\s\S]*?)\2/gi)) {
      const cols = [...m[3].matchAll(/\bnew\.(?:"?)([A-Za-z_]\w*)(?:"?)\s*:?=\s*(?:now\(\)|current_timestamp|clock_timestamp\(\)|timezone\([^)]*now\(\)\))/gi)].map((x) => x[1]);
      if (cols.length) setters.set(m[1], cols);
    }
  }
  for (const f of files.filter((p) => p.endsWith('.sql')).sort()) {
    const src = stripSql(text(f));
    for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?trigger\s+"?\w+"?\s+(before|after)\s+((?:insert|update|delete)(?:\s+or\s+(?:insert|update|delete))*)\s+(?:of\s+[\w\s,"]+\s+)?on\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?[\s\S]*?execute\s+(?:function|procedure)\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\(([^)]*)\)/gi)) {
      if (m[1].toLowerCase() !== 'before' || !/update/i.test(m[2])) continue;
      const t = tables.get(m[3]); if (!t) continue;
      const cols = /^moddatetime$/i.test(m[4]) ? [...m[5].matchAll(/'?([A-Za-z_]\w*)'?/g)].map((x) => x[1]).filter(Boolean) : (setters.get(m[4]) ?? []);
      for (const cname of cols) { const c = t.columns.find((x) => x.name === cname); if (c && !c.updated) c.updated = { path: rel(f), line: lineOf(src, m.index) }; }
    }
  }
}
// ── Alembic (in file order, also op.drop_table and SQL in op.execute("…"); only the final state counts) ──
const upgradeBody = (s) => { const m = /\ndef upgrade\b[^\n]*\n/.exec(s); if (!m) return s; const start = m.index + m[0].length; const rest = s.slice(start); const end = /\n(?=def |class )/.exec(rest); const stop = start + (end ? end.index : rest.length); return s.slice(0, start).replace(/[^\n]/g, ' ') + s.slice(start, stop) + s.slice(stop).replace(/[^\n]/g, ' '); };   // everything outside is blanked, lines stay   // only upgrade() counts; downgrade() undoes everything
for (const f of files.filter((p) => p.endsWith('.py') && /alembic|migrations|versions/.test(p)).sort()) {
  const src = upgradeBody(text(f));
  for (const m of src.matchAll(/op\.drop_table\(\s*['"]([A-Za-z_]\w*)['"]|op\.execute\(\s*(?:f?r?(?:\"\"\"|'''|"|'))\s*(drop\s+table\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?)/gi)) {
    const name = m[1] ?? m[3]; const createdBefore = [...src.matchAll(/op\.create_table\(\s*['"]([A-Za-z_]\w*)['"]/g)].some((c) => c[1] === name && c.index < m.index);   // created earlier in the same file: dropped along with it
    if (name && (tables.has(name) || createdBefore)) tables.delete(name); if (name) dropLater.add(name + '@' + m.index + '@' + f);
  }
  for (const m of src.matchAll(/op\.create_table\(\s*['"]([A-Za-z_]\w*)['"]/g)) {
    if ([...dropLater].some((k) => { const [n, at, file] = k.split('@'); return n === m[1] && file === f && Number(at) > m.index; })) continue;   // dropped later in the same file
    const t = addTable(m[1], 'table', { path: rel(f), line: lineOf(src, m.index), symbol: m[1] });
    const start = m.index; let depth = 0, i = start; do { if (src[i] === '(') depth++; if (src[i] === ')') depth--; i++; } while (i < src.length && depth > 0);
    const body = src.slice(start, i);
    for (const c of body.matchAll(/sa\.Column\(\s*['"]([A-Za-z_]\w*)['"]\s*,\s*(?:sa\.|postgresql\.)?([A-Za-z_]+)(?:\([^)]*\))?([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
      const col = { name: c[1], type: c[2].toLowerCase() }; const rest = c[3];
      if (/primary_key=True/.test(rest)) col.pk = true; if (/nullable=True/.test(rest)) col.nullable = true;
      const fk = /ForeignKey\(\s*['"]([A-Za-z_]\w*)\.([A-Za-z_]\w*)['"]/.exec(rest); if (fk) col.fk = { table: fk[1], column: fk[2] };
      if (/server_default=.*now\(\)|func\.now/.test(rest)) col.computed = { path: rel(f), line: lineOf(src, start + c.index) };
      if (/onupdate\s*=\s*(?:sa\.)?func\.now\(\)/.test(rest)) col.updated = { path: rel(f), line: lineOf(src, start + c.index) };   // SQLAlchemy sets the column on every change
      if (!t.columns.some((x) => x.name === col.name)) t.columns.push(col);
    }
  }
}
// ── SQLAlchemy models (Column / mapped_column) and Python enums (values with line) ──
const pyEnums = new Map();   // class name → [{ value, evidence }]
for (const f of files.filter((p) => p.endsWith('.py'))) {
  const src = text(f); const ls = src.split('\n');
  for (const m of src.matchAll(/^class\s+(\w+)\((?:str,\s*)?(?:enum\.)?Enum\):/gm)) {
    const start = lineOf(src, m.index); const vals = [];
    for (let i = start; i < ls.length; i++) { const l = ls[i]; if (i > start && /^(class |def |\S)/.test(l) && !/^\s/.test(l)) break; const v = /^\s+(\w+)\s*=\s*["']([^"']+)["']/.exec(l); if (v) vals.push({ value: v[2], evidence: { path: rel(f), line: i + 1 } }); }
    if (vals.length) pyEnums.set(m[1], vals);
  }
}
for (const f of files.filter((p) => p.endsWith('.py'))) {
  const src = text(f); const ls = src.split('\n');
  for (const m of src.matchAll(/__tablename__\s*=\s*["']([A-Za-z_]\w*)["']/g)) {
    const line = lineOf(src, m.index); const t = addTable(m[1], 'table', { path: rel(f), line, symbol: m[1] });
    for (let i = line; i < ls.length; i++) {
      const l = ls[i]; if (/^class\s|^\S/.test(l) && i > line) break;
      const c = /^\s+(\w+)\s*(?::\s*Mapped\[(.*?)\])?\s*=\s*(?:mapped_column|Column)\((.*)\)\s*$/.exec(l); if (!c) continue;
      const name = c[1]; const rest = c[3]; const typeArg = /^\s*(?:["']\w+["']\s*,\s*)?([A-Za-z_][\w.]*)/.exec(rest)?.[1] ?? 'text';
      const col = { name, type: typeArg.toLowerCase() };
      if (/primary_key=True/.test(rest)) col.pk = true;
      if (/nullable=True/.test(rest) || (c[2] && /Optional\[/.test(c[2]) && !/nullable=False/.test(rest))) col.nullable = true;
      const fk = /ForeignKey\(\s*["']([A-Za-z_]\w*)\.([A-Za-z_]\w*)["']/.exec(rest); if (fk) col.fk = { table: fk[1], column: fk[2] };
      const d = /server_default=\s*(["'][^"']*["']|[\w.()]+)/.exec(rest); if (d) col.default = d[1].replace(/^["']|["']$/g, '').slice(0, 120);
      if (/server_default=func\.|onupdate=func\.|default=func\./.test(rest)) col.computed = { path: rel(f), line: i + 1 };
      if (/onupdate\s*=\s*(?:sa\.)?func\.now\(\)/.test(rest)) col.updated = { path: rel(f), line: i + 1 };
      const en = c[2] && /^(?:Optional\[)?(\w+Enum)\]?$/.exec(c[2].replace(/\s/g, '')); if (en && pyEnums.has(en[1])) col.enum = pyEnums.get(en[1]);
      if (!t.columns.some((x) => x.name === name)) t.columns.push(col);
    }
  }
}
// ── Firestore ──
for (const f of files.filter((p) => p.endsWith('.rules'))) { const src = text(f); for (const m of src.matchAll(/match\s+\/([A-Za-z_]\w*)\/\{/g)) if (!['databases', 'documents'].includes(m[1])) addTable(m[1], 'collection', { path: rel(f), line: lineOf(src, m.index), symbol: m[1] }); }
// ── The schema from the database (--db <url> or EVERYDECK_SCHEMA_DB_URL; the read role is enough, every role can read pg_catalog). The database is
//    the truth: tables without CREATE TABLE in the repo appear with the place "database"; columns, types, keys, foreign keys and value lists come
//    from the catalog; tables and columns that do not exist there are dropped. Places in the migrations stay where they exist.
const dbUrl = opt('--db') ?? process.env.EVERYDECK_SCHEMA_DB_URL ?? null;
let catalog = null;
if (dbUrl) {
  const { readCatalog, checkValues } = await import('./scaffold-db.mjs');
  catalog = await readCatalog(dbUrl, repo, files);
  const dbEv = (symbol) => ({ path: 'database', line: 1, symbol: symbol.slice(0, 160) });
  const key = (schema, name) => `${schema}.${name}`;
  const fromDb = new Set(catalog.tables.map((t) => key(t.schema, t.name)));
  const known = [...tables.values()].filter((t) => fromDb.has(key(t.schema ?? 'public', t.name)));
  if (tables.size && !known.length) throw new Error(`the database at --db has none of the ${tables.size} tables of the migrations; is it the database of this app?`);
  for (const [name, t] of [...tables]) if (t.kind === 'table' && !fromDb.has(key(t.schema ?? 'public', t.name))) tables.delete(name);   // in the repo, not in the database: it does not exist
  for (const dt of catalog.tables) {
    let t = tables.get(dt.name);
    if (t && (t.schema ?? 'public') !== dt.schema) continue;   // same name in another schema: the repo's table stays authoritative
    if (!t) { t = addTable(dt.name, 'table', dbEv(key(dt.schema, dt.name)), dt.schema); t.columns = []; }
    const pk = new Set(dt.constraints.filter((k) => k.type === 'p').flatMap((k) => k.cols ?? []));
    const fks = new Map(dt.constraints.filter((k) => k.type === 'f' && (k.cols ?? []).length === 1).map((k) => [k.cols[0], { ref: k.ref, col: (k.refcols ?? [])[0] }]));
    const enums = new Map(dt.constraints.filter((k) => k.type === 'c').map((k) => checkValues(k.def)).filter(Boolean).map((x) => [x.col, x.values]));
    t.columns = dt.columns.map((dc) => {
      const old = t.columns.find((c) => c.name === dc.name);
      const col = { name: dc.name, type: dc.type.toLowerCase().slice(0, 60) };
      if (pk.has(dc.name)) col.pk = true;
      if (!dc.not_null && !col.pk) col.nullable = true;
      if (dc.default) col.default = dc.default.replace(/::[\w\s"]+(\[\])?$/g, '').replace(/^'(.*)'$/, '$1').slice(0, 120);
      const fk = fks.get(dc.name); if (fk) { const [fs, ft] = fk.ref.split('.'); col.fk = { table: fs === 'public' ? ft : `${fs}.${ft}`, ...(fk.col ? { column: fk.col } : {}) }; }
      else if (old?.fk) col.fk = old.fk;   // auth.uid() = column from a policy in the migrations
      const vals = enums.get(dc.name); if (vals) col.enum = vals.slice(0, 60).map((v) => old?.enum?.find((e) => e.value === v) ?? { value: v.slice(0, 80), evidence: dbEv(`${dt.name}.${dc.name}`) }).filter((e) => e.value);
      if (old?.computed) col.computed = old.computed; else if (dc.generated || /^(now\(\)|CURRENT_TIMESTAMP|timezone\(.*now\(\)\))/i.test(dc.default ?? '')) col.computed = dbEv(`${dt.name}.${dc.name}`);
      if (old?.updated) col.updated = old.updated;
      return col;
    });
  }
  // Row policies: auth.uid() = column is a reference to the provider's user table
  for (const pl of catalog.policies) { const t = tables.get(pl.table); if (!t) continue; for (const m of `${pl.qual ?? ''} ${pl.check ?? ''}`.matchAll(/auth\.uid\(\)\s*\)?\s*=\s*\(?"?([A-Za-z_]\w*)"?|"?([A-Za-z_]\w*)"?\s*=\s*\(?\s*auth\.uid\(\)/g)) { const c = t.columns.find((x) => x.name === (m[1] ?? m[2])); if (c && !c.fk && !c.pk) c.fk = { table: 'auth.users', column: 'id' }; } }
  // Change column from the database triggers (BEFORE UPDATE … NEW.column = now() / moddatetime)
  const fnSrc = new Map(catalog.functions.map((f) => [f.name, f]));
  for (const dt of catalog.tables) { const t = tables.get(dt.name); if (!t) continue;
    for (const g of dt.triggers) { if (!g.before || !g.update) continue; const cols = g.function === 'moddatetime' ? [.../moddatetime\(([^)]*)\)/i.exec(g.def)?.[1]?.matchAll(/'?([A-Za-z_]\w*)'?/g) ?? []].map((x) => x[1]) : [...(fnSrc.get(g.function)?.src ?? '').matchAll(/\bnew\.(?:"?)([A-Za-z_]\w*)(?:"?)\s*:?=\s*(?:now\(\)|current_timestamp|clock_timestamp\(\))/gi)].map((x) => x[1]);
      for (const cn of cols) { const c = t.columns.find((x) => x.name === cn); if (c && !c.updated) c.updated = dbEv(`trigger ${g.name}`); } } }
}
// ── Columns the database computes itself: credits, counters, balances. Facts with a place (columns[].computed), final state of the migrations
//    (CREATE OR REPLACE: the last version counts; DROP FUNCTION / DROP TRIGGER remove):
//    * an SQL function sets the column from its own value or a local variable, without a parameter (UPDATE … SET credits_used = v_new_used,
//      credits_total = GREATEST(COALESCE(credits_total, 0), 100)); if it writes a parameter, it is a door, not a computation;
//    * a BEFORE trigger sets NEW.column from other values (not only from the same column, not now()).
//    The rule lock.computed locks them; the value stays with the app.
const fnDefs = new Map(); const trigDefs = new Map();   // also used for the copies of contact data below
{
  for (const f of files.filter((p) => p.endsWith('.sql')).sort()) {
    const src = stripSql(text(f)); const ops = [];
    for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\(/gi)) {
      let depth = 1, i = m.index + m[0].length; while (i < src.length && depth > 0) { if (src[i] === '(') depth++; if (src[i] === ')') depth--; i++; }   // arguments with parentheses (numeric(10,2), default now())
      const args = src.slice(m.index + m[0].length, i - 1); const rest = src.slice(i); const tag = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(rest); if (!tag) continue;
      const bodyStart = i + tag.index + tag[0].length; const bodyEnd = src.indexOf(tag[1], bodyStart); if (bodyEnd < 0) continue;
      ops.push({ at: m.index, run: () => fnDefs.set(m[1].toLowerCase(), { name: m[1], args, trigger: /returns\s+trigger/i.test(rest.slice(0, tag.index)), body: src.slice(bodyStart, bodyEnd), bodyAt: bodyStart, src, file: rel(f) }) });
    }
    for (const m of src.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => fnDefs.delete(m[1].toLowerCase()) });
    for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?trigger\s+"?(\w+)"?\s+(before|after|instead\s+of)\s+([\s\S]*?)\bon\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?[\s\S]*?execute\s+(?:function|procedure)\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => trigDefs.set(`${m[4]}:${m[1]}`.toLowerCase(), { table: m[4], when: m[2].toLowerCase(), fn: m[5].toLowerCase(), name: m[1], event: (/insert|update|delete/i.exec(m[3])?.[0] ?? 'update').toLowerCase(), place: { path: rel(f), line: lineOf(src, m.index) } }) });
    for (const m of src.matchAll(/drop\s+trigger\s+(?:if\s+exists\s+)?"?(\w+)"?\s+on\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => trigDefs.delete(`${m[2]}:${m[1]}`.toLowerCase()) });
    for (const m of src.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => { for (const k of [...trigDefs.keys()]) if (k.startsWith(`${m[1].toLowerCase()}:`)) trigDefs.delete(k); } });
    for (const op of ops.sort((a, b) => a.at - b.at)) op.run();
  }
  // Functions and triggers that exist only in the database (not in the migrations): place "database"
  if (catalog) {
    for (const f of catalog.functions) if (!fnDefs.has(f.name.toLowerCase())) fnDefs.set(f.name.toLowerCase(), { name: f.name, args: f.args ?? '', trigger: !!f.returns_trigger, body: f.src ?? '', bodyAt: 0, src: f.src ?? '', file: 'database' });
    for (const dt of catalog.tables) for (const g of dt.triggers) { const k = `${dt.name}:${g.name}`.toLowerCase(); if (!trigDefs.has(k)) trigDefs.set(k, { table: dt.name, when: g.before ? 'before' : 'after', fn: g.function.toLowerCase(), name: g.name, event: g.insert ? 'insert' : g.update ? 'update' : 'delete', place: { path: 'database', line: 1 } }); }
  }
  const refers = (expr, name) => new RegExp(`(^|[^A-Za-z0-9_.])"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?([^A-Za-z0-9_]|$)`, 'i').test(expr);
  for (const fd of fnDefs.values()) {
    // Parameters and everything derived from them (NEW/OLD in a trigger, local variables from a parameter): whoever writes them is a door
    const params = [...fd.args.split(',').map((x) => x.trim().split(/\s+/).filter((w) => !/^(in|out|inout|variadic)$/i.test(w))[0]?.replace(/"/g, '')).filter(Boolean), ...(fd.trigger ? ['new', 'old'] : [])];
    const locals = [...(/\bdeclare\b([\s\S]*?)\bbegin\b/i.exec(fd.body)?.[1] ?? '').matchAll(/^\s*([A-Za-z_]\w*)\s+[A-Za-z]/gm)].map((x) => x[1]);
    const fromParam = new Set(params.map((p) => p.toLowerCase()));
    const selfOf = (l) => [...fd.body.matchAll(new RegExp(`select\\s+([\\s\\S]*?)\\binto\\s+([\\s\\S]*?)\\bfrom\\b`, 'gi'))].flatMap((x) => { const cols = x[1].split(',').map((c) => c.trim().replace(/^.*\./, '').replace(/^coalesce\(\s*([A-Za-z_]\w*).*$/i, '$1')); const vars = x[2].split(',').map((v) => v.trim()); const i = vars.findIndex((v) => v.toLowerCase() === l.toLowerCase()); return i >= 0 && cols[i] ? [cols[i]] : []; });
    const selfCols = new Map(locals.map((l) => [l.toLowerCase(), new Set(selfOf(l).map((c) => c.toLowerCase()))]));
    for (let round = 0; round < 4; round++) for (const l of locals) for (const e of [...fd.body.matchAll(new RegExp(`\\b${l}\\s*:=\\s*([^;]+);`, 'gi'))].map((x) => x[1])) for (const o of locals) if (o !== l && refers(e, o)) for (const c of selfCols.get(o.toLowerCase()) ?? []) selfCols.get(l.toLowerCase()).add(c);
    for (let round = 0; round < 4; round++) for (const l of locals) { if (fromParam.has(l.toLowerCase())) continue;
      const assigned = [...fd.body.matchAll(new RegExp(`\\b${l}\\s*:=\\s*([^;]+);`, 'gi'))].map((x) => x[1]).concat([...fd.body.matchAll(new RegExp(`select\\s+([\\s\\S]*?)\\binto\\s+${l}\\b([\\s\\S]*?);`, 'gi'))].map((x) => x[1] + x[2]));
      if (assigned.some((e) => [...fromParam].some((p) => refers(e, p)))) fromParam.add(l.toLowerCase()); }
    for (const u of fd.body.matchAll(/\bupdate\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|\bfrom\b|;)/gi)) {
      const t = tables.get(u[1]); if (!t) continue;
      let depth = 0, cur = '', start = 0; const parts = []; const body = u[2];
      for (let i = 0; i < body.length; i++) { const ch = body[i]; if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push([cur, start]); cur = ''; start = i + 1; } else cur += ch; } parts.push([cur, start]);
      for (const [part, off] of parts) { const a = /^\s*"?([A-Za-z_]\w*)"?\s*=\s*([\s\S]+)$/.exec(part); if (!a) continue; const c = t.columns.find((x) => x.name === a[1]); if (!c || c.computed || c.pk) continue;
        const expr = a[2]; const at = fd.file === 'database' ? { path: 'database', line: 1, symbol: `function ${fd.name}` } : { path: fd.file, line: lineOf(fd.src, fd.bodyAt + u.index + u[0].indexOf(u[2]) + off + part.indexOf(a[1])) };
        if (refers(expr, c.name) || locals.some((l) => refers(expr, l) && selfCols.get(l.toLowerCase())?.has(c.name.toLowerCase()))) { c.computed = at; continue; }   // from its own previous value: credits, counters
        if ([...fromParam].some((p) => refers(expr, p)) || /\$\d/.test(expr)) { if (!fd.trigger) { c.written ??= []; if (c.written.length < 5) c.written.push(at); } continue; }   // writes a parameter: a door (write place)
        if (!refers(expr, c.name) && !locals.some((l) => refers(expr, l))) continue;   // neither its own value nor a computed local variable
        c.computed = at; }
    }
  }
  for (const td of trigDefs.values()) {
    if (td.when !== 'before') continue; const fd = fnDefs.get(td.fn); const t = tables.get(td.table); if (!fd || !t) continue;
    for (const a of fd.body.matchAll(/\bnew\.(?:"?)([A-Za-z_]\w*)(?:"?)\s*:?=\s*([^;]+);/gi)) {
      const expr = a[2].trim(); if (/^(now\(\)|current_timestamp|clock_timestamp\(\)|timezone\([^)]*now\(\)\))$/i.test(expr) || refers(expr, `new.${a[1]}`)) continue;
      if (!/\bnew\.|\bselect\b|[a-z_]\w*\s*\(/i.test(expr)) continue;
      const c = t.columns.find((x) => x.name === a[1]); if (c && !c.computed && !c.pk) c.computed = fd.file === 'database' ? { path: 'database', line: 1, symbol: `function ${fd.name}` } : { path: fd.file, line: lineOf(fd.src, fd.bodyAt + a.index) };
    }
  }
}
// ── Components (provider packages that everydeck-check knows) ──
const KNOWN = /^(stripe|@stripe\/|@paddle\/|@lemonsqueezy\/|paddle$|openai$|@anthropic-ai\/|@google\/generative-ai$|@google\/genai$|google-generativeai$|resend$|postmark$|postmarker$|nodemailer$|@sendgrid\/mail$|sendgrid$|mailgun|@aws-sdk\/client-ses$|next-auth$|@auth\/|@supabase\/supabase-js$|@supabase\/ssr$|supabase$|firebase$|firebase-admin$|@clerk\/|passport$|lucia$|expo-notifications$|expo-server-sdk$|exponent-server-sdk$|@capacitor\/push-notifications$|@capacitor-firebase\/messaging$|@react-native-firebase\/messaging$|pyfcm$|web-push$|@aws-sdk\/client-s3$|boto3$|cloudinary$|multer$|busboy$|formidable$|node-cron$|cron$|bullmq$|bull$|pg-boss$|celery$|apscheduler$|rq$|pg$|postgres$|@prisma\/client$|drizzle-orm$|asyncpg$|sqlalchemy$|psycopg|algoliasearch$|meilisearch$|typesense$|@elastic\/|@capacitor\/core$|expo$|react-native$|electron$|@tauri-apps\/|bcrypt|argon2|jsonwebtoken$|jose$|iron-session$|python-jose$|pyjwt$|passlib$|sharp$|jimp$|@supabase\/storage-js$|uploadthing$|@uploadthing\/|pillow$|socket\.io$|pusher|ably$|stream-chat$|@stream-io\/|sendbird|@sendbird\/|@paypal\/|razorpay$|@mollie\/|cohere-ai$|@mistralai\/|langchain$|@langchain\/|@ai-sdk\/|^ai$|@getbrevo\/|node-mailjet$|@workos-inc\/|auth0$|@auth0\/|@oslojs\/|agenda$|@temporalio\/|@onesignal\/|react-native-onesignal$|@react-native-firebase\/messaging$)/;
const components = [];
for (const f of files.filter((p) => p.endsWith('package.json'))) {
  const src = text(f); let pkg; try { pkg = JSON.parse(src); } catch { continue; }
  for (const dep of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) if (KNOWN.test(dep) && !components.some((c) => c.package === dep)) { const idx = src.indexOf(`"${dep}"`); components.push({ id: dep.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+/, '').slice(0, 60), package: dep, evidence: { path: rel(f), line: lineOf(src, idx) } }); }
}
for (const f of files.filter((p) => /requirements[^/]*\.txt$|pyproject\.toml$/.test(p))) {
  const src = text(f); src.split('\n').forEach((l, i) => { const raw = l.trim().split(/[=<>!\[ ;#"']/)[0]; const name = raw.toLowerCase(); if (name && KNOWN.test(name) && !components.some((c) => c.package.toLowerCase() === name)) components.push({ id: name.replace(/[^A-Za-z0-9_.-]/g, '-'), package: raw, evidence: { path: rel(f), line: i + 1 } }); });
}
// ── Routes and pages ──
const api_routes = []; const screens = [];
const pattern = (p) => p.replace(/\[\.\.\.[^\]]+\]/g, '*').replace(/\[([^\]]+)\]/g, ':$1').replace(/\{(\w+):path\}/g, '*').replace(/\{(\w+)(?::[^}]*)?\}/g, ':$1').replace(/\([^)]*\)\/?/g, '').replace(/\/$/, '') || '/';
const TEST_PATH = /\.(test|spec|stories)\.[tj]sx?$|(^|\/)(__tests__|e2e|cypress|tests?)\/|(^|\/)test_[^/]*\.py$/;   // pages and routes from tests are not part of the app
for (const f of files.filter((p) => /\.(ts|tsx|js|mjs|cjs|py)$/.test(p) && !TEST_PATH.test(relative(repo, p)))) {
  const src = text(f); const r = rel(f);
  const re = f.endsWith('.py') ? /@(?:app|router|api|[a-z_]+_router)\.(get|post|put|patch|delete)\(\s*['"](\/[^'"\s]*)['"]/g : /\b(?:app|router|server|fastify|api|r)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`\s]*)['"`]/g;
  for (const m of src.matchAll(re)) { if (m[2].includes('${')) continue; /* template strings are client calls, not routes */ const pat = pattern(m[2]); if (!api_routes.some((x) => x.pattern === pat && x.method === m[1].toUpperCase())) api_routes.push({ pattern: pat, method: m[1].toUpperCase(), evidence: { path: r, line: lineOf(src, m.index) } }); }
  const parts = r.split('/');
  if (parts.includes('api') && /^route\.(ts|js)$/.test(parts.at(-1))) { const i = parts.indexOf('api'); const pat = pattern('/' + parts.slice(i, -1).join('/')); if (!api_routes.some((x) => x.pattern === pat)) api_routes.push({ pattern: pat, evidence: { path: r, line: 1 } }); }
  if (/^app\//.test(r) && /\/page\.(tsx|jsx|ts|js)$/.test(r) && !parts.includes('api')) { const pat = pattern('/' + parts.slice(1, -1).join('/')); screens.push({ pattern: pat, evidence: { path: r, line: 1 } }); }
  if (/^app\//.test(r) && /\.(tsx|jsx)$/.test(r) && !/\/page\.|_layout|\+not-found|\+html/.test(r) && !parts.includes('api') && !/\.test\./.test(r) && existsSync(join(repo, 'app.json'))) { const pat = pattern('/' + r.replace(/^app\//, '').replace(/\.(tsx|jsx)$/, '').replace(/\/index$/, '')); screens.push({ pattern: pat, evidence: { path: r, line: 1 } }); }
  for (const m of src.matchAll(/<Route\s+[^>]*path=["'](\/[^"']*)["']/g)) { const pat = pattern(m[1]); screens.push({ pattern: pat, evidence: { path: r, line: lineOf(src, m.index) } }); }
  for (const m of src.matchAll(/\{\s*path:\s*['"](\/[^'"]*)['"]/g)) { const pat = pattern(m[1]); screens.push({ pattern: pat, evidence: { path: r, line: lineOf(src, m.index) } }); }
}
// ── Platforms ──
const platforms = [];
const cap = files.find((p) => /capacitor\.config\.(ts|js|json)$/.test(p)); if (cap) { platforms.push({ id: 'web', runtime: 'browser', evidence: { path: rel(cap), line: 1 } }); if (existsSync(join(repo, 'ios'))) platforms.push({ id: 'ios', runtime: 'capacitor', evidence: { path: rel(cap), line: 1 } }); if (existsSync(join(repo, 'android'))) platforms.push({ id: 'android', runtime: 'capacitor', evidence: { path: rel(cap), line: 1 } }); }
const appJson = files.find((p) => /(^|\/)app\.json$/.test(p) && text(p).includes('"expo"')); if (appJson) for (const id of ['web', 'ios', 'android']) platforms.push({ id, runtime: 'expo', evidence: { path: rel(appJson), line: 1 } });
if (!platforms.length && files.some((p) => /package\.json$/.test(p))) platforms.push({ id: 'web', runtime: 'browser', evidence: { path: rel(files.find((p) => /package\.json$/.test(p))), line: 1 } });
if (components.some((c) => /^(pg|postgres|asyncpg|sqlalchemy|psycopg|@prisma\/client|drizzle-orm)/.test(c.package))) platforms.push({ id: 'server', runtime: files.some((p) => p.endsWith('.py')) ? 'python' : 'node', evidence: components.find((c) => /^(pg|postgres|asyncpg|sqlalchemy|psycopg|@prisma\/client|drizzle-orm)/.test(c.package)).evidence });

const BLOCKS = ['login', 'people_roles', 'organizations', 'content_status', 'moderation', 'chats', 'uploads', 'search', 'payments', 'email', 'push', 'ai', 'jobs', 'imports', 'bookings', 'settings', 'platforms'];
// The app map was called everydeck/everydeck-befund.json before: an existing setup with only the old file is still merged; the result goes only to --out
const OLD_NAME = 'everydeck-befund.json';
const mergeFile = (() => { const m = opt('--merge'); if (!m) return null; if (existsSync(m)) return m; const old = join(m, '..', OLD_NAME); return /(^|[\\/])app-map\.json$/.test(m) && existsSync(old) ? old : null; })();
const merge = mergeFile ? JSON.parse(readFileSync(mergeFile, 'utf8')) : null;
// ── Display places: every data access in the frontend, through the syntax tree (scaffold-reads.mjs) ──
// Direct (supabase.from('x' as never), Firestore, ORM, SQL), through .rpc('fn') → tables of the SQL function, functions.invoke('n') → tables of the Edge
// Function, Realtime postgres_changes, views → base tables, API calls (`${API_BASE}/persons/${id}` → /persons/:p) → tables that the route
// handler reads (FastAPI: path parameters, APIRouter(prefix), include_router; Express: app.use). Each place: shown[] { path, line, element: "data", via, symbol }.
// Writes and other mentions of a table name in the frontend appear, for tables without a display place, as not_shown[] { path, line, reason };
// the cross-check in everydeck-check (its own string scanner) requires exactly such an entry for every mention of a table without a display place.
const tableKey = (n) => (tables.has(n) ? n : [...tables.keys()].find((k) => k.toLowerCase() === n.toLowerCase()) ?? null);
const addShown = (name, entry) => { const t = tables.get(name); if (!t) return; t.shown ??= []; if (t.shown.length < 60 && !t.shown.some((x) => x.path === entry.path && x.line === entry.line)) t.shown.push({ path: entry.path, line: entry.line, element: 'data', ...(entry.symbol ? { symbol: entry.symbol } : {}), ...(entry.via ? { via: entry.via } : {}) }); };
// Final state: a foreign key to a table that does not exist in the final state (DROP TABLE … CASCADE) is gone; other schemas (auth.users) stay
for (const t of tables.values()) for (const c of t.columns) if (c.fk && !c.fk.table.includes('.') && !tableKey(c.fk.table)) delete c.fk;
const reads = analyseReads({ repo, files, tables, tableKey });
// Routes with the full pattern (FastAPI: APIRouter(prefix) + include_router(prefix) + path; Express: app.use prefix) from the analysis; regex matches covered by them are dropped
for (const r of reads.routes) { const entry = { pattern: r.pattern, method: r.method, evidence: { path: r.file, line: r.line } };
  const i = api_routes.findIndex((x) => x.evidence.path === r.file && x.evidence.line === r.line && (!x.method || x.method === r.method));   // same place (the decorator): full pattern instead of the path
  if (i >= 0) api_routes[i] = entry; else if (!api_routes.some((x) => x.pattern === r.pattern && x.method === r.method)) api_routes.push(entry); }
for (let i = api_routes.length - 1; i >= 0; i--) if (api_routes.findIndex((x) => x.pattern === api_routes[i].pattern && x.method === api_routes[i].method) !== i) api_routes.splice(i, 1);   // one pattern per method
// Pages only from files the app's entry point reaches; the rest are listed as unreachable[] in the app map (everydeck-check checks the same rule)
const unreachablePaths = new Set(reads.reach.unreachable.map((u) => u.path));
for (let i = screens.length - 1; i >= 0; i--) if (unreachablePaths.has(screens[i].evidence.path)) screens.splice(i, 1);
{ // one place per page: a route with a page file behind it (React Router, route object) before any other mention (a sitemap script), else the first one
  const routed = new Set((reads.page_files ?? []).map((x) => `${x.path}:${x.line}`)); const isRouted = (x) => routed.has(`${x.evidence.path}:${x.evidence.line}`);
  for (let i = screens.length - 1; i >= 0; i--) { const first = screens.findIndex((x) => x.pattern === screens[i].pattern && (isRouted(x) || !screens.some((y) => y.pattern === x.pattern && isRouted(y)))); if (first !== i) screens.splice(i, 1); } }
for (const s of reads.shown) addShown(s.table, s);
// Display places per column (element data, place = where the column is named or read); the read scope contains only columns with a display place
// Write places (columns[].written) and IDs of other systems (columns[].external_id: the value comes from a call to a provider package or is passed to it)
for (const w of reads.column_writes) { const c = tables.get(w.table)?.columns.find((x) => x.name === w.column); if (!c || c.pk) continue;
  if (w.self) { c.computed ??= { path: w.path, line: w.line }; continue; }   // the app computes the value from the previous one (credits, counters): held by the app
  c.written ??= []; if (c.written.length < 5 && !c.written.some((x) => x.path === w.path && x.line === w.line)) c.written.push({ path: w.path, line: w.line }); }
for (const pc of reads.provider_columns) {
  const comp = components.find((x) => x.package.toLowerCase() === pc.provider.toLowerCase()); if (!comp) continue;   // only packages the skeleton knows as providers
  // Tables the function reads; if it reads none with this column, only the one table that has a column of this name (with several, it stays open)
  const named = [...tables.keys()].filter((t) => tables.get(t).columns.some((x) => x.name === pc.column));
  const cands = pc.table ? [pc.table] : (pc.tables ?? []).some((t) => named.includes(t)) ? pc.tables : named.length === 1 ? named : [];
  for (const tn of cands) { const c = tables.get(tn)?.columns.find((x) => x.name === pc.column); if (c && !c.pk && !c.fk && !c.external_id) c.external_id = { component: comp.id, evidence: { path: pc.path, line: pc.line } }; }
}
for (const cs of reads.columns_shown) { const c = tables.get(cs.table)?.columns.find((x) => x.name === cs.column); if (!c) continue; c.shown ??= []; if (c.shown.length < 3 && !c.shown.some((x) => x.path === cs.path && x.line === cs.line)) c.shown.push({ path: cs.path, line: cs.line, element: 'data', symbol: cs.column, via: cs.via }); }
// Money: where the app formats a value as a currency (scaffold-reads.mjs: Intl.NumberFormat/toLocaleString with style currency, own functions
// only with such a call in the body). The property belongs to the column of the same name if the column is a number and the frontend reads its table;
// the currency is in the call (currency) or in a column of the same table (currency_column); otherwise no currency, nothing guessed.
const readTables = new Set(reads.columns_shown.map((x) => x.table));
for (const m of reads.money) for (const [tn, t] of tables) { if (!readTables.has(tn)) continue; const c = t.columns.find((x) => x.name === m.prop); if (!c || c.pk || c.fk || !/int|numeric|decimal|real|double|float|money|number/i.test(c.type)) continue;
  c.shown ??= []; if (c.shown.filter((x) => x.element === 'money').length >= 2 || c.shown.some((x) => x.element === 'money' && x.path === m.path && x.line === m.line)) continue;
  const curCol = m.currency_prop && t.columns.some((x) => x.name === m.currency_prop) ? m.currency_prop : null;
  c.shown.push({ path: m.path, line: m.line, element: 'money', ...(m.currency ? { currency: m.currency } : curCol ? { currency_column: curCol } : {}), symbol: m.prop, via: m.via }); }
// Display kind from the place where the app shows the value (scaffold-display.mjs: <img src>, background image, <a href>, <textarea>, text with
// line breaks or Markdown, date formatters), through maps, variables and props back to the property; the property belongs to the column of the same
// name in a table the frontend reads, with a type that can hold the value. What cannot be traced is listed in display_ends[].
const holds = { image: /char|text|json|\[\]/i, link: /char|text/i, textarea: /char|text/i, long_text: /char|text/i, date: /date|time|char|text/i };
// Contact detail (mailto:/tel:/sms:/wa.me, input field type email/tel): fact columns[].contact with its place, not a display place
for (const d of reads.display ?? []) { const kind = d.element === 'contact_email' ? 'email' : d.element === 'contact_phone' ? 'phone' : null; if (!kind) continue;
  for (const [tn, t] of tables) { if (!readTables.has(tn) || (d.tables && !d.tables.includes(tn))) continue; const c = t.columns.find((x) => x.name === d.prop); if (!c || c.pk || c.fk || !/char|text/i.test(c.type) || c.contact) continue;
    c.contact = { kind, evidence: { path: d.path, line: d.line, ...(d.symbol ? { symbol: d.symbol } : {}) } }; } }
for (const d of reads.display ?? []) for (const [tn, t] of tables) { if (!readTables.has(tn) || (d.tables && !d.tables.includes(tn))) continue; const c = t.columns.find((x) => x.name === d.prop); if (!c || c.pk || c.fk || !holds[d.element]?.test(c.type)) continue;
  c.shown ??= []; if (c.shown.filter((x) => x.element === d.element).length >= 3 || c.shown.some((x) => x.element === d.element && x.path === d.path && x.line === d.line)) continue;
  c.shown.push({ path: d.path, line: d.line, element: d.element, symbol: d.symbol, via: d.via }); }   // symbol: the expression at the display place (everydeck-check finds it there)
// The app's labels for values (mapping in code: object[x], switch, i18n key from the value, <option value>), with the language of the
// translation file and the place; for fixed values (enum, status) only for those values
for (const l of reads.value_labels ?? []) for (const [tn, t] of tables) { if (!l.tables?.includes(tn)) continue; const c = t.columns.find((x) => x.name === l.column); if (!c || c.pk || c.fk) continue;
  const known = [...(c.enum ?? []).map((e) => e.value), ...(t.status_column === c.name ? (t.statuses ?? []).map((x) => x.value) : [])]; if (known.length && !known.includes(l.value)) continue;
  c.value_labels ??= []; if (c.value_labels.length >= 400 || c.value_labels.some((x) => x.value === l.value && (x.lang ?? null) === (l.lang ?? null) && x.label === l.label)) continue;
  c.value_labels.push({ value: l.value, label: l.label.slice(0, 120), ...(l.lang ? { lang: l.lang } : {}), evidence: { path: l.path, line: l.line } }); }
// Display name of a person: the app's rule from shown expressions that start with the name column of the person table
// (composition, fallback steps); several places: the common prefix; a fixed text as the last step is not a name of the person
const nameRuleOf = (identity) => { const nameCol = identity?.fields?.display_name?.column; if (!identity?.table || !nameCol) return null;
  const chains = (reads.name_chains ?? []).filter((c) => c.table === identity.table && c.steps[0]?.columns.includes(nameCol)); if (!chains.length) return null;
  const key = (st) => JSON.stringify(st); let steps = chains[0].steps;
  for (const c of chains.slice(1)) { let i = 0; while (i < steps.length && i < c.steps.length && key(steps[i]) === key(c.steps[i])) i++; steps = steps.slice(0, i); }
  return steps.length ? { steps, evidence: [...chains].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line).slice(0, 5).map((c) => ({ path: c.path, line: c.line, symbol: c.symbol })) } : null; };
for (const m of reads.not_shown) { const t = tables.get(m.table); if (!t) continue; t.not_shown ??= []; if (t.not_shown.length < 100 && !t.not_shown.some((x) => x.path === m.path && x.line === m.line)) t.not_shown.push({ path: m.path, line: m.line, fact: m.fact }); }

// Tables of the existing app map that the skeleton does not know (added by the agent) stay, unless the database says they do not exist
const keptOld = (merge?.tables ?? []).filter((x) => !tables.has(x.name) && (!catalog || catalog.tables.some((d) => d.name === x.name)));
const mergedTables = [...[...tables.values()].map((t) => { const old = merge?.tables?.find((x) => x.name === t.name); if (!old) return t; const keep = (old.shown ?? []).filter((x) => x.element !== 'data'); const { not_shown: _dropped, shown: _old, ...rest } = old; return { ...rest, defined: t.defined, ...(keep.length || t.shown ? { shown: [...keep, ...(t.shown ?? [])].slice(0, 60) } : {}), ...(t.not_shown ? { not_shown: t.not_shown } : {}), columns: [...t.columns.map((c) => { const oc = old.columns.find((x) => x.name === c.name); if (!oc) return c; const keepShown = (oc.shown ?? []).filter((x) => x.element !== 'data' && !(c.shown ?? []).some((y) => y.element === x.element && y.path === x.path && y.line === x.line));   /* what the skeleton finds again itself (money), not twice */ const shownAll = [...keepShown, ...(c.shown ?? [])].slice(0, 12); return { ...c, ...(oc.external_id && !c.external_id ? { external_id: oc.external_id } : {}), ...(oc.contact && !c.contact ? { contact: oc.contact } : {}), ...(shownAll.length ? { shown: shownAll } : {}) };   /* the agent's contact fact stays */ }), ...old.columns.filter((x) => !t.columns.some((c) => c.name === x.name) && !(catalog && t.kind === 'table'))] }; }), ...keptOld];   // the agent's column display places (heading, money …) stay, the skeleton renews data places; with --db only the database columns count   // skeleton parts (data display places, not_shown) are renewed; agent entries and columns added by the agent (e.g. Firestore) stay
// ── Copies of contact data and messages. If an SQL function of the app writes a value marked as contact (also shortened
//    or transformed, left(NEW.content, 140)) into another column, that column is the same fact: NEW./OLD. of a trigger's table, local variables
//    from them, and INSERT … SELECT from the table itself. The place is where the function writes the column (the column is named there). Copies
//    of copies count too (up to three levels). The agent marks the source (e.g. messages.content as message); the skeleton follows with --merge.
{
  const byName = new Map(mergedTables.map((t) => [t.name, t]));
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = (x) => new RegExp(`(^|[^A-Za-z0-9_."])"?${esc(x)}"?(?![A-Za-z0-9_])`, 'i');
  // top-level parts (commas outside parentheses and strings), each with its offset
  const splitTop = (str) => { const out = []; let depth = 0, q = false, start = 0; for (let i = 0; i <= str.length; i++) { const ch = str[i]; if (q) { if (ch === "'") q = false; continue; } if (ch === "'") { q = true; continue; } if (ch === '(') depth++; else if (ch === ')') depth--; else if ((ch === ',' && depth === 0) || i === str.length) { out.push([str.slice(start, i), start]); start = i + 1; } } return out; };
  const masked = (str) => { let out = '', depth = 0, q = false; for (const ch of str) { if (q) { out += ' '; if (ch === "'") q = false; continue; } if (ch === "'") { q = true; out += ' '; continue; } if (ch === '(') { depth++; out += ' '; continue; } if (ch === ')') { depth = Math.max(0, depth - 1); out += ' '; continue; } out += depth > 0 ? ' ' : ch; } return out; };
  const closeOf = (str, open) => { let depth = 0, q = false; for (let i = open; i < str.length; i++) { const ch = str[i]; if (q) { if (ch === "'") q = false; continue; } if (ch === "'") q = true; else if (ch === '(') depth++; else if (ch === ')' && --depth === 0) return i; } return -1; };
  const contactCols = (tn) => (byName.get(tn)?.columns ?? []).filter((c) => c.contact);
  const place = (fd, at) => (fd.file === 'database' ? { path: 'database', line: 1, symbol: `function ${fd.name}` } : { path: fd.file, line: lineOf(fd.src, fd.bodyAt + at) });
  const setContact = (tn, cn, kind, ev, from) => { const t = byName.get(tn); const c = t?.columns.find((x) => x.name === cn); if (!c || c.contact || c.pk || c.fk || (tn === from.table && cn === from.column)) return false; c.contact = { kind, evidence: ev }; return true; };
  for (let round = 0, changed = true; round < 3 && changed; round++) {
    changed = false;
    for (const fd of fnDefs.values()) {
      const body = fd.body;
      // Sources: { re, kind, table, column }: NEW./OLD. of the tables whose triggers call this function
      const refs = [];
      for (const td of trigDefs.values()) if (td.fn === fd.name.toLowerCase()) for (const c of contactCols(td.table)) refs.push({ re: new RegExp(`\\b(?:new|old)\\s*\\.\\s*"?${esc(c.name)}"?(?![A-Za-z0-9_])`, 'i'), kind: c.contact.kind, table: td.table, column: c.name });
      const taint = (expr, extra = []) => [...refs, ...extra].find((r) => r.re.test(expr)) ?? null;
      // local variables from a source (v := lower(NEW.email))
      for (let i = 0; i < 3; i++) for (const a of body.matchAll(/(?:^|[;\s])([A-Za-z_]\w*)\s*:=\s*([^;]+);/g)) { if (/^new$|^old$/i.test(a[1])) continue; const r = taint(a[2]); if (r && !refs.some((x) => x.local === a[1].toLowerCase())) refs.push({ ...r, re: word(a[1]), local: a[1].toLowerCase() }); }
      // BEFORE trigger: NEW.other_column := expression from the source (same table)
      for (const td of trigDefs.values()) if (td.fn === fd.name.toLowerCase()) for (const a of body.matchAll(/\bnew\s*\.\s*"?([A-Za-z_]\w*)"?\s*:=\s*([^;]+);/gi)) { const r = taint(a[2]); if (r && setContact(td.table, a[1], r.kind, place(fd, a.index + a[0].indexOf(a[1])), r)) changed = true; }
      // INSERT INTO x (columns) VALUES (…) | SELECT … FROM source
      for (const m of body.matchAll(/\binsert\s+into\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\(/gi)) {
        const open = m.index + m[0].length - 1; const close = closeOf(body, open); if (close < 0) continue;
        const cols = splitTop(body.slice(open + 1, close)); const rest = body.slice(close + 1); let exprs = null; const extra = [];
        const v = /^\s*values\s*\(/i.exec(rest);
        if (v) { const o = close + 1 + v[0].length - 1; const e = closeOf(body, o); if (e > 0) exprs = splitTop(body.slice(o + 1, e)); }
        const sel = /^\s*select\b/i.exec(rest);
        if (sel) {
          const seg = rest.slice(sel[0].length).split(';')[0]; const at = /\bfrom\b/i.exec(masked(seg)); if (!at) continue;
          exprs = splitTop(seg.slice(0, at.index));
          for (const f of masked(seg.slice(at.index)).matchAll(/\b(?:from|join)\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?(?:\s+(?:as\s+)?(?!where\b|join\b|left\b|right\b|inner\b|on\b|group\b|order\b|limit\b)([A-Za-z_]\w*))?/gi))
            for (const c of contactCols(f[1])) for (const q of [f[1], f[2]].filter(Boolean)) extra.push({ re: new RegExp(`\\b${esc(q)}\\s*\\.\\s*"?${esc(c.name)}"?(?![A-Za-z0-9_])`, 'i'), kind: c.contact.kind, table: f[1], column: c.name });
        }
        if (!exprs || exprs.length !== cols.length) continue;
        cols.forEach(([cname, off], i) => { const r = taint(exprs[i][0], extra); if (!r) return; const name = cname.trim().replace(/"/g, ''); if (setContact(m[1], name, r.kind, place(fd, open + 1 + off + cname.indexOf(cname.trim())), r)) changed = true; });
      }
      // UPDATE x SET column = expression from the source
      for (const u of body.matchAll(/\bupdate\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+set\s+/gi)) {
        const start = u.index + u[0].length; const seg = body.slice(start).split(';')[0]; const end = /\b(?:where|returning|from)\b/i.exec(masked(seg));
        for (const [part, off] of splitTop(seg.slice(0, end ? end.index : seg.length))) { const a = /^\s*"?([A-Za-z_]\w*)"?\s*=\s*([\s\S]+)$/.exec(part); if (!a) continue; const r = taint(a[2]); if (r && setContact(u[1], a[1], r.kind, place(fd, start + off + part.indexOf(a[1])), r)) changed = true; }
      }
    }
  }
}
// ── Name source of people and organizations: the table whose key references the provider's user (profiles.id → auth.users), the name column the app shows
//    from it (with its place), the login provider from the packages, and memberships: a table with a reference to the person and one to a table whose name the
//    app shows. Facts only, the same rule the setup requires (rules bundle). What the agent described stays; a missing name or membership list is added.
const AUTH_PACKAGES = [[/^@supabase\/(supabase-js|ssr|auth-helpers-[a-z]+)$|^supabase$/i, 'supabase_auth'], [/^firebase(-admin)?$/i, 'firebase_auth'], [/^next-auth$|^@auth\//i, 'authjs'], [/^@clerk\//i, 'clerk']];
const identityProposal = (() => {
  const profiles = profileTables({ tables: mergedTables }); const profile = profiles.find((t) => shownNameColumn(t)) ?? (profiles.length === 1 ? profiles[0] : null);
  if (!profile) return null;
  const auth = components.map((c) => ({ c, p: AUTH_PACKAGES.find(([re]) => re.test(c.package))?.[1] })).find((x) => x.p);
  const name = shownNameColumn(profile);
  const isPerson = (c) => !!c.fk && (/^auth\.users$/i.test(c.fk.table) || c.fk.table === profile.name);
  const memberships = mergedTables.filter((t) => t.name !== profile.name).flatMap((t) => { const person = t.columns.find(isPerson); const org = t.columns.find((c) => c.fk && !isPerson(c) && c !== person);
    const orgT = org ? mergedTables.find((x) => x.name === org.fk.table) : null; return person && orgT && shownNameColumn(orgT) && t.columns.filter((c) => c.fk).length === 2 ? [{ table: t.name, person_column: person.name, org_table: orgT.name, evidence: { path: t.defined.path, line: t.defined.line } }] : []; });
  return { provider: auth?.p ?? 'supabase_auth', evidence: auth ? { path: auth.c.evidence.path, line: auth.c.evidence.line } : { path: profile.defined.path, line: profile.defined.line }, table: profile.name, auth_table: 'auth.users',
    ...(name ? { fields: { display_name: name } } : {}), ...(memberships.length ? { memberships: memberships.slice(0, 5) } : {}) };
})();
const identityOut = (() => {
  const id = merge && 'identity' in merge ? merge.identity : identityProposal;   // the agent's null (no login) stays null
  if (!id) return null;
  const p = identityProposal && (!id.table || id.table === identityProposal.table) ? identityProposal : null;
  const fields = id.fields?.display_name || !p?.fields?.display_name ? id.fields : { ...(id.fields ?? {}), display_name: p.fields.display_name };
  return { ...id, ...(fields ? { fields } : {}), ...(!id.memberships && p?.memberships ? { memberships: p.memberships } : {}) };
})();
// ── Flow candidates: every write of the browser (to a table or a route of the app's backend), every AFTER trigger of the app (not everydeck's own; BEFORE
//    triggers only keep columns) and every place where the app signs people up or in or resets a password (required: these are always flows). The agent
//    describes each one as a flow or sets left_out with the reason; everydeck-check and everydeck refuse one without either. --merge keeps the reasons.
const AUTH_CALLS = [
  ['sign_up', /\.auth\.(signUp)\s*\(|\b(createUserWithEmailAndPassword)\s*\(|\b(useSignUp)\s*\(|<(SignUp)\b|\.auth\.(sign_up)\s*\(/],
  ['sign_in', /\.auth\.(signIn(?:WithPassword|WithOtp|WithOAuth|WithIdToken|WithSSO)?|verifyOtp)\s*\(|\b(signInWith(?:EmailAndPassword|Popup|Redirect|EmailLink|PhoneNumber|Credential))\s*\(|\b(useSignIn)\s*\(|<(SignIn)\b|\.auth\.(sign_in_with_(?:password|otp|oauth|id_token)|verify_otp)\s*\(|\b(signIn)\s*\(\s*['"]/],
  ['password_reset', /\.auth\.(resetPasswordForEmail)\s*\(|\b(sendPasswordResetEmail)\s*\(|\.auth\.(reset_password_(?:email|for_email))\s*\(/],
];
const byPlace = (a, b) => a.path.localeCompare(b.path) || a.line - b.line;
const candidates = [];
const addCand = (c) => { if (!candidates.some((x) => x.id === c.id)) candidates.push(c); };
const unreachableSet = new Set(reads.reach.unreachable.map((u) => u.path));
const codeFiles = files.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|py|vue|svelte)$/.test(p) && !/\.d\.ts$/.test(p) && !TEST_PATH.test(rel(p)) && !unreachableSet.has(rel(p))).sort();
// ── Money and AI, facts with their places (no connection to any provider). The payment provider (its package or its address in the code) with the
//    places where the app talks to it: checkout, webhook, subscription, customer, portal. Tables with money: a column the app shows as money (with the
//    currency column), a column with an identifier of the provider, or a table the payment code writes (in a file with a call to the provider, or within
//    60 lines after the webhook). AI: the clients and calls of openai, anthropic, google genai, openrouter, mistral, groq and the ai-sdk, with the model
//    where the code names it. No table becomes money by its name.
const PAY = [
  { provider: 'stripe', pkg: /^(stripe|@stripe\/[\w.-]+)$/i, host: /api\.stripe\.com/, calls: [
    ['checkout', /\b(stripe\.checkout\.(?:sessions|Session)\.create|stripe\.paymentIntents\.create|stripe\.PaymentIntent\.create|redirectToCheckout)\s*\(/],
    ['webhook', /\b(stripe\.webhooks\.constructEvent(?:Async)?|stripe\.Webhook\.construct_event)\s*\(/],
    ['subscription', /\b(stripe\.(?:subscriptions|Subscription)\.(?:create|modify|update|cancel|del|retrieve))\s*\(/],
    ['customer', /\b(stripe\.(?:customers|Customer)\.(?:create|modify|update|retrieve))\s*\(/],
    ['portal', /\b(stripe\.billing_?[pP]ortal\.(?:sessions|Session)\.create)\s*\(/]] },
  { provider: 'paddle', pkg: /^@paddle\//i, host: /(?:sandbox-)?api\.paddle\.com/, calls: [['checkout', /\b(Paddle\.Checkout\.open)\s*\(/], ['webhook', /\b(\w+\.webhooks\.unmarshal)\s*\(/]] },
  { provider: 'lemonsqueezy', pkg: /^@lemonsqueezy\//i, host: /api\.lemonsqueezy\.com/, calls: [['checkout', /\b(createCheckout)\s*\(/]] },
  { provider: 'revenuecat', pkg: /^(react-native-purchases|@revenuecat\/[\w.-]+)$/i, host: /api\.revenuecat\.com/, calls: [['checkout', /\b(Purchases\.purchase(?:Package|Product|StoreProduct))\s*\(/]] },
  { provider: 'midtrans', pkg: /^(midtrans-client|midtransclient)$/i, host: /(?:app|api)(?:\.sandbox)?\.midtrans\.com/, calls: [['checkout', /\b(\w+\.createTransaction(?:Token)?|\w+\.create_transaction(?:_token)?)\s*\(/], ['webhook', /\b(\w+\.transaction\.notification)\s*\(/]] },
  { provider: 'xendit', pkg: /^(xendit-node|xendit|xendit-python)$/i, host: /api\.xendit\.co/, calls: [['checkout', /\b(\w+\.createInvoice|\w+\.create_invoice)\s*\(/]] },
  { provider: 'paypal', pkg: /^@paypal\//i, host: /api-m\.(?:sandbox\.)?paypal\.com/, calls: [['checkout', /\b(paypal\.Buttons)\s*\(/]] },
  { provider: 'mollie', pkg: /^(@mollie\/api-client|mollie-api-python)$/i, host: /api\.mollie\.com/, calls: [['checkout', /\b(\w+\.payments\.create)\s*\(/]] },
  { provider: 'razorpay', pkg: /^razorpay$/i, host: /api\.razorpay\.com/, calls: [['checkout', /\b(\w+\.orders?\.create)\s*\(/]] },
];
const AI = [
  { provider: 'anthropic', client: /\b((?:Async)?Anthropic(?:Bedrock|Vertex)?)\s*\(/, call: /\.(messages\.(?:create|stream))\s*\(/, needs: /anthropic/i },
  { provider: 'google', client: /\b(GoogleGenerativeAI|GoogleGenAI|genai\.Client|genai\.GenerativeModel)\s*\(/, call: /\.(generateContent(?:Stream)?|models\.generate_content|generate_content)\s*\(/ },
  { provider: 'mistral', client: /\b(Mistral(?:Client)?)\s*\(/, call: /\.(chat\.complete(?:Async)?|chat\.stream)\s*\(/, needs: /mistral/i },
  { provider: 'groq', client: /\b((?:Async)?Groq)\s*\(/, call: null },
  { provider: 'openai', client: /\b((?:Async)?(?:Azure)?OpenAI)\s*\(/, call: /\.(chat\.completions\.create|chat\.completions\.parse|responses\.create|completions\.create|embeddings\.create|images\.generate|audio\.transcriptions\.create)\s*\(/ },
];
const AI_SDK_CALL = /\b(generateText|streamText|generateObject|streamObject|embedMany)\s*\(/;
const AI_HOSTS = [[/api\.openai\.com/, 'openai'], [/api\.anthropic\.com/, 'anthropic'], [/generativelanguage\.googleapis\.com/, 'google'], [/openrouter\.ai\/api/, 'openrouter'], [/api\.mistral\.ai/, 'mistral'], [/api\.groq\.com/, 'groq'], [/api\.together\.xyz/, 'together']];
const payProviders = []; const aiCalls = [];
for (const P of PAY) {
  const comp = components.find((c) => P.pkg.test(c.package)); const calls = [];
  for (const f of codeFiles) { const ls = text(f).split('\n'); ls.forEach((l, i) => { if (/^\s*(\/\/|#|\*)/.test(l)) return;
    for (const [kind, re] of P.calls) { const m = re.exec(l); if (m && (comp || P.provider === 'stripe' || ls.some((x) => P.host.test(x)))) calls.push({ kind, evidence: { path: rel(f), line: i + 1, symbol: m[1] } }); }
    const h = P.host.exec(l); if (h && /['"`]/.test(l)) calls.push({ kind: 'api', evidence: { path: rel(f), line: i + 1, symbol: h[0] } }); }); }
  if (!comp && !calls.length) continue;
  payProviders.push({ provider: P.provider, ...(comp ? { component: comp.id } : {}), evidence: comp ? { path: comp.evidence.path, line: comp.evidence.line, symbol: comp.package } : calls[0].evidence, calls: calls.slice(0, 50) });
}
for (const f of codeFiles) {
  const src = text(f); const ls = src.split('\n'); const usesAiSdk = /from\s+['"]ai['"]|require\(\s*['"]ai['"]\s*\)/.test(src);
  const viaHost = AI_HOSTS.find(([re]) => re.test(src) && (re.source.includes('openrouter') || re.source.includes('groq') || re.source.includes('together')))?.[1] ?? null;   // an OpenAI client pointed at another provider
  const modelNear = (i) => { for (let j = i; j < Math.min(ls.length, i + 7); j++) { const m = /\bmodel\s*[:=]\s*["'`]([\w.:\/@-]{2,80})["'`]/.exec(ls[j]); if (m) return { value: m[1], evidence: { path: rel(f), line: j + 1, symbol: m[1] } }; } return null; };
  ls.forEach((l, i) => { if (/^\s*(\/\/|#|\*)/.test(l)) return;
    for (const A of AI) {
      if (A.needs && !A.needs.test(src)) continue;
      const c = A.client.exec(l); if (c) aiCalls.push({ provider: A.provider === 'openai' && viaHost ? viaHost : A.provider, kind: 'client', evidence: { path: rel(f), line: i + 1, symbol: c[1] } });
      const k = A.call?.exec(l); if (k) { const model = modelNear(i); aiCalls.push({ provider: A.provider === 'openai' && viaHost ? viaHost : A.provider, kind: 'call', evidence: { path: rel(f), line: i + 1, symbol: k[1] }, ...(model ? { model } : {}) }); }
    }
    const s2 = usesAiSdk ? AI_SDK_CALL.exec(l) : null; if (s2) { const model = modelNear(i); aiCalls.push({ provider: 'ai_sdk', kind: 'call', evidence: { path: rel(f), line: i + 1, symbol: s2[1] }, ...(model ? { model } : {}) }); }
    for (const [re, provider] of AI_HOSTS) { const h = re.exec(l); if (h && /['"`]/.test(l)) aiCalls.push({ provider, kind: 'call', evidence: { path: rel(f), line: i + 1, symbol: h[0] } }); }
  });
}
const payComponents = new Set(payProviders.map((p) => p.component).filter(Boolean));
const moneyTables = [];
const addMoney = (table, because, evidence, columns) => { if (!moneyTables.some((x) => x.table === table) && mergedTables.some((t) => t.name === table)) moneyTables.push({ table, because, evidence, ...(columns?.length ? { columns: [...new Set(columns)] } : {}) }); };
for (const t of mergedTables) { const cols = t.columns.filter((c) => (c.shown ?? []).some((x) => x.element === 'money')); if (!cols.length) continue;
  const s0 = cols[0].shown.find((x) => x.element === 'money'); addMoney(t.name, 'shown_as_money', { path: s0.path, line: s0.line, symbol: cols[0].name }, [...cols.map((c) => c.name), ...cols.flatMap((c) => c.shown.filter((x) => x.element === 'money' && x.currency_column).map((x) => x.currency_column))]); }
for (const t of mergedTables) for (const c of t.columns) if (c.external_id && payComponents.has(c.external_id.component)) addMoney(t.name, 'provider_id', { path: c.external_id.evidence.path, line: c.external_id.evidence.line, symbol: c.name }, [c.name]);
// The payment code: a file with a call to the provider (not only the webhook), and around the webhook its function plus the functions of the same file it
// calls (by name, transitively). Top-level blocks: a definition at the start of a line (def, function, const name = (…) =>) up to the next one.
const payFiles = new Set(payProviders.flatMap((p) => p.calls.filter((c) => c.kind !== 'webhook' && c.kind !== 'api').map((c) => c.evidence.path)));
const payRanges = new Map();   // path → [[from, to]] of lines
const DEF = /^(?:export\s+)?(?:async\s+)?(?:def|function)\s+([A-Za-z_]\w*)|^(?:export\s+)?(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_]\w*\s*=>)/;
for (const h of payProviders.flatMap((p) => p.calls.filter((c) => c.kind === 'webhook').map((c) => c.evidence))) {
  if (payFiles.has(h.path)) continue;
  const ls = text(join(repo, h.path)).split('\n'); const blocks = [];
  ls.forEach((l, i) => { const m = DEF.exec(l); if (m) blocks.push({ name: m[1] ?? m[2], from: i + 1 }); });
  blocks.forEach((b, i) => { b.to = i + 1 < blocks.length ? blocks[i + 1].from - 1 : ls.length; });
  const start = [...blocks].reverse().find((b) => b.from <= h.line); if (!start) continue;
  const seen = new Set([start]); const queue = [start];
  while (queue.length) { const b = queue.shift(); const body = ls.slice(b.from, b.to).join('\n'); for (const o of blocks) if (!seen.has(o) && new RegExp(`\\b${o.name}\\s*\\(`).test(body)) { seen.add(o); queue.push(o); } }
  payRanges.set(h.path, [...(payRanges.get(h.path) ?? []), ...[...seen].map((b) => [b.from, b.to])]);
}
const inPay = (path, line) => payFiles.has(path) || (payRanges.get(path) ?? []).some(([a, b]) => line >= a && line <= b);
const writtenIn = new Set(reads.column_writes.filter((w) => inPay(w.path, w.line)).map((w) => w.table));
for (const f of [...new Set([...payFiles, ...payRanges.keys()])].sort()) {
  text(join(repo, f)).split('\n').forEach((l, i) => { if (!inPay(f, i + 1)) return;
    for (const m of l.matchAll(/\.(?:table|from)\(\s*["'`]([A-Za-z_]\w*)["'`]|\b(?:from|into|update|join)\s+"?(?:public\.)?"?([A-Za-z_]\w*)/gi)) { const t = tableKey(m[1] ?? m[2]); if (t) addMoney(t, writtenIn.has(t) ? 'written_with_provider' : 'used_with_provider', { path: f, line: i + 1, symbol: m[1] ?? m[2] }); } });
}
const keyOf = (x) => `${x.provider}|${x.kind ?? ''}|${x.evidence?.path}:${x.evidence?.line}`;
const money = payProviders.length || moneyTables.length || merge?.money ? { providers: [...payProviders, ...(merge?.money?.providers ?? []).filter((o) => !payProviders.some((p) => p.provider === o.provider))], tables: [...moneyTables, ...(merge?.money?.tables ?? []).filter((o) => !moneyTables.some((t) => t.table === o.table) && mergedTables.some((t) => t.name === o.table))].slice(0, 200) } : null;
const aiOut = [...aiCalls, ...(merge?.ai_calls ?? []).filter((o) => !aiCalls.some((a) => keyOf(a) === keyOf(o)))].slice(0, 200);
const authPlaces = [];
for (const f of codeFiles) { const ls = text(f).split('\n'); ls.forEach((l, i) => { if (/^\s*(\/\/|#|\*)/.test(l)) return; for (const [kind, re] of AUTH_CALLS) { const m = re.exec(l); if (m) authPlaces.push({ kind, path: rel(f), line: i + 1, symbol: m.slice(1).find(Boolean) }); } }); }
for (const a of authPlaces.sort(byPlace)) addCand({ id: `auth:${a.kind}`, source: 'auth', kind: a.kind, evidence: { path: a.path, line: a.line, symbol: a.symbol }, required: true });
for (const r of api_routes.filter((x) => x.method === 'POST' || !x.method).sort((a, b) => byPlace(a.evidence, b.evidence))) {   // an own login: the app's routes for it (not required: the route name is the fact)
  const kind = /(^|\/)(register|sign-?up|signup)$/i.test(r.pattern) ? 'sign_up' : /(^|\/)(login|sign-?in|signin)$/i.test(r.pattern) ? 'sign_in' : /(forgot|reset)[-_]?password|password[-_]?reset/i.test(r.pattern) ? 'password_reset' : null;
  if (kind) addCand({ id: `auth:${kind}`, source: 'auth', kind, evidence: { path: r.evidence.path, line: r.evidence.line, symbol: r.pattern.split('/').pop() } });
}
for (const p of payProviders) for (const c of p.calls.filter((x) => x.kind === 'checkout' || x.kind === 'webhook').sort((a, b) => byPlace(a.evidence, b.evidence))) addCand({ id: `payment:${c.kind}`, source: 'payment', kind: c.kind, evidence: c.evidence, required: true });
for (const w of [...(reads.browser_writes ?? [])].sort(byPlace)) addCand(w.route ? { id: `browser_write:${w.route}`, source: 'browser_write', kind: 'request', route: w.route, handler: w.handler, evidence: { path: w.path, line: w.line, symbol: w.symbol } }
  : { id: `browser_write:${w.kind}:${w.table}`, source: 'browser_write', kind: w.kind, table: w.table, evidence: { path: w.path, line: w.line, symbol: w.symbol } });
for (const td of [...trigDefs.values()].filter((t) => t.place).sort((a, b) => byPlace(a.place, b.place))) {
  if (td.when !== 'after' || /^everydeck/i.test(td.fn) || /^everydeck/i.test(td.name) || !mergedTables.some((t) => t.name === td.table) || (merge?.everydeck_tables ?? []).some((y) => y.table === td.table)) continue;
  addCand({ id: `trigger:${td.table}:${td.name}`, source: 'trigger', kind: td.event, table: td.table, evidence: { ...td.place, symbol: td.name } });
}
const flowCandidates = candidates.slice(0, 500).map((c) => { const old = (merge?.flow_candidates ?? []).find((x) => x.id === c.id); return old?.left_out ? { ...c, left_out: old.left_out } : c; });
// ── Page descriptions (screens[].described) from facts: the file behind the route (or the route file of the framework) and its own imports, two levels
//    deep, without modules more than three pages share; the tables they show and the flows of the app map that start there. The agent's description stays.
const pageFileOf = new Map((reads.page_files ?? []).map((x) => [`${x.path}:${x.line}`, x.file]));
const closureOf = (file) => { const out = [file]; let frontier = [file]; for (let d = 0; d < 2; d++) { const next = []; for (const f of frontier) for (const g of (reads.import_graph ?? {})[f] ?? []) if (!out.includes(g)) { out.push(g); next.push(g); } frontier = next; } return out; };
const pageClosures = screens.map((sc) => { const f = pageFileOf.get(`${sc.evidence.path}:${sc.evidence.line}`) ?? (/^app\//.test(sc.evidence.path) ? sc.evidence.path : null); return f ? closureOf(f) : null; });
const sharedBy = new Map(); for (const c of pageClosures) for (const f of c ?? []) sharedBy.set(f, (sharedBy.get(f) ?? 0) + 1);
const shownIn = new Map(); for (const x of reads.shown) { if (!shownIn.has(x.path)) shownIn.set(x.path, new Set()); shownIn.get(x.path).add(x.table); }
const describedOf = (i) => { const c = pageClosures[i]; if (!c) return null; const own = new Set(c.filter((f, j) => j === 0 || (sharedBy.get(f) ?? 0) <= 3));
  return { works_with: [...new Set([...own].flatMap((f) => [...(shownIn.get(f) ?? [])]))].sort(), flows: (merge?.flows ?? []).filter((fl) => own.has(fl.start?.path)).map((fl) => fl.id).sort() }; };
// ── Services the backend calls by their API address (a host that starts with api): a component with the address as its package; the column <service>_id of a
//    table <service>_* that the app writes in a file naming that address carries the service's identifier (external_id). Payment and AI addresses are money and ai_calls.
const SKIP_HOSTS = /stripe\.com|paddle\.com|lemonsqueezy\.com|revenuecat\.com|midtrans\.com|xendit\.co|paypal\.com|mollie\.com|razorpay\.com|openai\.com|anthropic\.com|googleapis\.com|openrouter\.ai|mistral\.ai|groq\.com|together\.xyz|supabase\.(co|com|in)|localhost/i;
const services = new Map();   // id → { host, evidence, files }
for (const f of codeFiles) { const r0 = rel(f); if (!(/(^|\/)(backend|server|api|functions|supabase)(\/|$)/.test(r0) || f.endsWith('.py'))) continue;
  text(f).split('\n').forEach((l, i) => { for (const m of l.matchAll(/["'`]https?:\/\/((api[\w-]*)\.([\w-]+\.)*([\w-]+)\.[a-z]{2,6})(?=[\/"'`:])/gi)) { const host = m[1].toLowerCase(); if (SKIP_HOSTS.test(host)) continue;
    const parts = host.split('.'); const id = parts[parts.length - 2].replace(/[^a-z0-9_-]/g, ''); if (!id) continue;
    const s0 = services.get(id) ?? { host, evidence: { path: r0, line: i + 1, symbol: host }, files: new Set() }; s0.files.add(r0); services.set(id, s0); } }); }
for (const [id, sv] of services) {
  if (!components.some((c) => c.id === id)) components.push({ id, package: sv.host, evidence: sv.evidence });
  for (const t of mergedTables.filter((x) => x.name.startsWith(`${id}_`))) { const c = t.columns.find((x) => x.name === `${id}_id`); if (!c || c.pk || c.fk || c.external_id) continue;
    const w = [...reads.column_writes, ...(reads.column_inserts ?? [])].filter((x) => x.table === t.name && x.column === c.name).sort(byPlace).find((x) => sv.files.has(x.path)) ?? [...reads.column_writes, ...(reads.column_inserts ?? [])].filter((x) => x.table === t.name && x.column === c.name).sort(byPlace)[0];
    if (w) c.external_id = { component: id, evidence: { path: w.path, line: w.line, symbol: c.name } }; } }
// The icon the app itself ships (skeleton part, new on every run; the agent's descriptions under `app` stay)
const icon = findIcon(repo, files);
const appOut = (() => { const { icon: _old, ...rest } = merge?.app ?? {}; const a = { ...rest, ...(icon ? { icon } : {}) }; return Object.keys(a).length ? a : null; })();
const out = { schema_version: '1.12-r0', release_key: merge?.release_key ?? `git:${commit.slice(0, 12)}`, commit, ...(appOut ? { app: appOut } : {}),
  components: [...components.map((c) => ({ ...c, ...(merge?.components?.find((x) => x.package === c.package)?.call ? { call: merge.components.find((x) => x.package === c.package).call } : {}) })), ...(merge?.components ?? []).filter((x) => !components.some((c) => c.package === x.package))], platforms: merge?.platforms ?? platforms, screens: screens.map((x, i) => { const d = merge?.screens?.find((y) => y.pattern === x.pattern)?.described ?? describedOf(i); return d ? { ...x, described: d } : x; }), api_routes,   // a page's description (described) stays as long as the page exists
    // components added by the agent (e.g. a package in an Edge Function) stay
  // tables of the everydeck installation named by the agent stay (as long as the table exists)
  ...(reads.reach.unreachable.length ? { unreachable: reads.reach.unreachable.slice(0, 500) } : {}),
  ...((reads.display_ends ?? []).filter((e) => !e.element.startsWith('contact_')).length ? { display_ends: reads.display_ends.filter((e) => !e.element.startsWith('contact_')) } : {}),   // a contact place without a column is not a display fact   // display places whose value cannot be traced to a column (fact, never guessed)   // files no entry point of the app reaches: no page, no display place
  ...(merge?.everydeck_tables ? { everydeck_tables: merge.everydeck_tables.filter((y) => mergedTables.some((t) => t.name === y.table)) } : {}),
  ...(merge?.works_with ? { works_with: merge.works_with.filter((w) => tables.has(w.table) && (!w.part_of || tables.has(w.part_of))) } : {}),   // the agent's description stays; entries for tables that no longer exist in the final state are dropped
  identity: (() => { const id = identityOut; if (!id) return null; const { name_rule: _old, ...rest } = id; const rule = nameRuleOf(id); return rule ? { ...rest, name_rule: rule } : rest; })(), tables: mergedTables, functions: merge?.functions ?? [], flows: merge?.flows ?? [], ...(flowCandidates.length ? { flow_candidates: flowCandidates } : {}), money, ...(aiOut.length ? { ai_calls: aiOut } : {}), ...(merge?.channels ? { channels: merge.channels } : {}), ...(merge?.jobs ? { jobs: merge.jobs } : {}), ...(merge?.payments !== undefined ? { payments: merge.payments } : {}), ...(merge?.adapters ? { adapters: merge.adapters } : {}),
  checklist: merge?.checklist ?? BLOCKS.map((block) => ({ block, present: false })) };
// --types prints the object type names as everydeck derives them (singular of the table name), for triggers, actions, door and cleanup list before submitting
if (args.includes('--types')) {
  const singular = (n) => (/ies$/.test(n) ? n.replace(/ies$/, 'y') : /(ses|xes|zes|ches|shes)$/.test(n) ? n.replace(/es$/, '') : /[^s]s$/.test(n) ? n.replace(/s$/, '') : n);
  const slugOf = (x) => x.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 63) || 'x';
  process.stdout.write(JSON.stringify(Object.fromEntries(out.tables.map((t) => [t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name, slugOf(singular(t.name))])), null, 1) + '\n'); process.exit(0);
}
// Never write into the repo unasked: without --out the app map goes to stdout
const outPath = opt('--out');
if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n'); else process.stdout.write(JSON.stringify(out, null, 1) + '\n');
console.error(JSON.stringify({ out: outPath, tables: out.tables.length, columns: out.tables.reduce((n, t) => n + t.columns.length, 0), shown: out.tables.filter((t) => (t.shown ?? []).length || t.columns.some((c) => (c.shown ?? []).length)).length, not_shown: out.tables.reduce((n, t) => n + (t.not_shown ?? []).length, 0), components: out.components.length, api_routes: api_routes.length, screens: screens.length, platforms: out.platforms.length, routes_with_reads: reads.routes.filter((r) => r.reads.length).length, views: reads.views.length, sql_functions: reads.sql_functions.length, merged: !!merge }));
