#!/usr/bin/env node
// B29 – Befund-Gerüst aus dem Repo: ein Werkzeug für den Coding-Agenten, das nur Fakten mit Fundstelle ausliest (Datei:Zeile) und nichts bewertet.
//   node agent/befund-skeleton.mjs <repo> [--db <url der Datenbank, Leserolle genügt>] [--out everydeck/everydeck-befund.json] [--merge <bestehender Befund>]   (ohne --out: Ausgabe auf stdout, nichts wird ins Repo geschrieben)
// B31 Schnitt D: mit --db (oder EVERYDECK_SCHEMA_DB_URL) liest das Gerüst das Schema zuerst aus der Datenbank (befund-db.mjs); die Migrationen sind die Fundstelle.
// Liest: Tabellen und Spalten aus SQL-Migrationen (CREATE TABLE … (…), ALTER TABLE … ADD COLUMN, CHECK (col IN (…)), REFERENCES, DEFAULT; Endzustand: DROP TABLE und DROP COLUMN entfernen, RENAME COLUMN benennt um, CREATE TABLE … AS SELECT * FROM übernimmt die Spalten; Schema außer public; auth.users als Fremdschlüssel, auch aus Policies auth.uid() = spalte),
//        Alembic (op.create_table) und Firestore-Regeln (match /name/{id}); Pakete aus package.json/requirements*.txt (nur Anbieterpakete,
//        die everydeck-check kennt); API-Routen (Express/Fastify/Hono-Aufrufe, FastAPI-Dekoratoren, Next.js app/api/**/route.ts); Seiten
//        (Next.js app/**/page.tsx, Expo Router app/**.tsx, React Router <Route path>); Plattformen (capacitor.config.*, app.json, ios/, android/).
//        Anzeigestellen aus jedem Datenzugriff des Frontends über den Syntaxbaum (befund-reads.mjs: TypeScript-Compiler-API, Python ast) – auch .rpc, functions.invoke,
//        Realtime, Sichten, API-Aufrufe mit Vorlagenstrings gegen die Routen des Backends; Schreibzugriffe und Nennungen als not_shown[] mit Grund.
// Was das Werkzeug nicht lesen kann (sichtbare Elemente, Setzstellen, Funktionen mit Rechten, Abläufe, Identität, Kanäle), trägt der Agent
// mit Fundstellen nach; `--merge` behält diese Teile aus einem bestehenden Befund und erneuert nur die Gerüstteile.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analyseReads } from './befund-reads.mjs';
import { findIcon } from './befund-icon.mjs';

const args = process.argv.slice(2); const repo = args[0]; if (!repo) { console.error('usage: befund-skeleton.mjs <repo> [--db <url>] [--out file] [--merge file]'); process.exit(2); }
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.expo', 'coverage', '__pycache__', '.venv', 'venv', 'Pods', '.everydeck', 'everydeck', 'everydeck-outbox', 'supabase_types']);
const files = [];
(function walk(dir, depth) { if (depth > 7) return; for (const n of readdirSync(dir)) { if (SKIP.has(n)) continue; const p = join(dir, n); const st = statSync(p); if (st.isDirectory()) walk(p, depth + 1); else if (st.size < 2_000_000) files.push(p); } })(repo, 0);
const rel = (p) => relative(repo, p);
const text = (p) => readFileSync(p, 'utf8');
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const commit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); } catch { return '0'.repeat(40); } })();

// ── Tabellen aus SQL ──
const tables = new Map(); const dropLater = new Set();
const addTable = (name, kind, evidence, schema) => { if (!tables.has(name)) tables.set(name, { name, ...(schema && schema.toLowerCase() !== 'public' ? { schema } : {}), kind, defined: evidence, columns: [] }); return tables.get(name); };
const qualified = (schema, name) => (schema && schema.toLowerCase() !== 'public' ? `${schema}.${name}` : name);   // Fremdschlüssel auf andere Schemata (auth.users) bleiben benannt
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
function enumValues(list, file, baseLine) {   // je Wert die Zeile, in der er steht (Listen über mehrere Zeilen); NULL ist kein Wert
  const out = []; let line = baseLine;
  for (const raw of list.split(',')) { const nl = (raw.match(/\n/g) ?? []).length; const before = (raw.slice(0, raw.search(/\S|$/)).match(/\n/g) ?? []).length; const v = raw.trim().replace(/^'|'$/g, ''); if (v && !/^null$/i.test(v) && /^'/.test(raw.trim())) out.push({ value: v, evidence: { path: rel(file), line: line + before } }); line += nl; }
  return out;
}
function applyEnum(t, colName, list, file, line) { const c = t.columns.find((x) => x.name === colName); if (c) c.enum = enumValues(list, file, line); }
const stripSql = (src) => src.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));   // Kommentare entfernen, Zeilennummern bleiben
// Migrationen in Dateireihenfolge: nur der Endzustand des Schemas zählt – eine später gelöschte Tabelle (DROP TABLE) steht nicht im Befund
for (const f of files.filter((p) => p.endsWith('.sql')).sort()) {
  const src = stripSql(text(f));
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?\s+as\s+select\s+\*\s+from\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) {   // CREATE TABLE … AS SELECT * FROM y: dieselben Spalten wie y
    const t = addTable(m[2], 'table', { path: rel(f), line: lineOf(src, m.index), symbol: m[2] }, m[1]); const from = tables.get(m[3]); if (from && !t.columns.length) t.columns = from.columns.map((c) => ({ ...c }));
  }
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?\s+as\b/gi)) addTable(m[2], 'table', { path: rel(f), line: lineOf(src, m.index), symbol: m[2] }, m[1]);   // CREATE TABLE … AS: ohne Spaltenliste
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?\s*\(/gi)) {
    const start = m.index + m[0].length; let depth = 1, i = start; while (i < src.length && depth > 0) { if (src[i] === '(') depth++; if (src[i] === ')') depth--; i++; }
    const existed = tables.has(m[2]); const t = addTable(m[2], 'table', { path: rel(f), line: lineOf(src, m.index), symbol: m[2] }, m[1]);
    if (!existed) parseColumns(src.slice(start, i - 1), f, lineOf(src, start), t);   // CREATE TABLE IF NOT EXISTS auf eine vorhandene Tabelle ändert nichts (wie in Postgres; Migrationskopien in zwei Ordnern)
  }
  for (const m of src.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) tables.delete(m[1]);
  // B36: ALTER TABLE x RENAME TO y – ab hier heißt die Tabelle y (Fundstelle: die Umbenennung, dort steht der Name); Verweise anderer Tabellen ziehen mit
  for (const m of src.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+rename\s+to\s+"?([A-Za-z_]\w*)"?/gi)) {
    const t = tables.get(m[1]); if (!t || tables.has(m[2])) continue;
    tables.delete(m[1]); t.name = m[2]; t.defined = { path: rel(f), line: lineOf(src, m.index), symbol: m[2] }; tables.set(m[2], t);
    for (const o of tables.values()) for (const c of o.columns) if (c.fk?.table === m[1]) c.fk.table = m[2];
  }
  // Endzustand auch je Spalte: ALTER TABLE … DROP COLUMN entfernt, RENAME COLUMN benennt um (auch mehrere Aktionen je ALTER)
  for (const m of src.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+([^;]+)/gi)) {
    const t = tables.get(m[1]); if (!t) continue;
    for (const d of m[2].matchAll(/drop\s+column\s+(?:if\s+exists\s+)?"?([A-Za-z_]\w*)"?/gi)) t.columns = t.columns.filter((c) => c.name !== d[1]);
    for (const r of m[2].matchAll(/rename\s+(?:column\s+)?"?([A-Za-z_]\w*)"?\s+to\s+"?([A-Za-z_]\w*)"?/gi)) { const c = t.columns.find((x) => x.name === r[1]); if (c && !t.columns.some((x) => x.name === r[2])) c.name = r[2]; }
  }
  // Zeilenrechte, die eine Spalte mit der angemeldeten Person vergleichen (auth.uid() = spalte): ein Verweis auf die Nutzertabelle des Anbieters
  for (const m of src.matchAll(/create\s+policy\s+"[^"]*"\s+on\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?[\s\S]*?(?:auth\.uid\(\)\s*=\s*"?([A-Za-z_]\w*)"?|"?([A-Za-z_]\w*)"?\s*=\s*auth\.uid\(\))/gi)) {
    const t = tables.get(m[1]); const c = t?.columns.find((x) => x.name === (m[2] ?? m[3])); if (c && !c.fk) c.fk = { table: 'auth.users', column: 'id' };
  }
  for (const m of src.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+((?:add\s+(?:column\s+)?[^;]+))/gi)) {
    const t = tables.get(m[1]); if (!t) continue;
    for (const part of m[2].split(/,\s*(?=add\s+)/i)) { const c = /add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([A-Za-z_]\w*)"?\s+(.+)$/is.exec(part.trim()); if (!c || /^constraint$/i.test(c[1]) || t.columns.some((x) => x.name === c[1])) continue; parseColumns(`${c[1]} ${c[2].replace(/,\s*$/, '')}`, f, lineOf(src, m.index + m[0].indexOf(part)), t); }
  }
  for (const m of src.matchAll(/alter\s+table\s+(?:only\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+add\s+constraint\s+\w+\s+check\s*\(\s*"?(\w+)"?\s+in\s*\(([^)]*)\)/gi)) { const t = tables.get(m[1]); if (t) applyEnum(t, m[2], m[3], f, lineOf(src, m.index + m[0].indexOf(m[3]))); }
}
// ── Änderungsspalte (B30 Schnitt A): eine Spalte, die die Datenbank bei jeder Änderung setzt – ein BEFORE UPDATE-Trigger, dessen Funktion NEW.spalte = now()
//    setzt oder moddatetime('spalte') ist. Fakt mit Fundstelle (columns[].updated); der Lese-Umfang bekommt sie als `changed` und erlaubt changed_since.
{
  const setters = new Map();   // Funktionsname → Spalte(n), die der Körper auf now()/current_timestamp setzt
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
// ── Alembic (B29 vierte Runde: in Dateireihenfolge, auch op.drop_table und SQL in op.execute("…") – nur der Endzustand zählt) ──
const upgradeBody = (s) => { const m = /\ndef upgrade\b[^\n]*\n/.exec(s); if (!m) return s; const start = m.index + m[0].length; const rest = s.slice(start); const end = /\n(?=def |class )/.exec(rest); const stop = start + (end ? end.index : rest.length); return s.slice(0, start).replace(/[^\n]/g, ' ') + s.slice(start, stop) + s.slice(stop).replace(/[^\n]/g, ' '); };   // alles außerhalb ausgeblendet, Zeilen bleiben   // nur upgrade() zählt – downgrade() macht alles rückgängig
for (const f of files.filter((p) => p.endsWith('.py') && /alembic|migrations|versions/.test(p)).sort()) {
  const src = upgradeBody(text(f));
  for (const m of src.matchAll(/op\.drop_table\(\s*['"]([A-Za-z_]\w*)['"]|op\.execute\(\s*(?:f?r?(?:\"\"\"|'''|"|'))\s*(drop\s+table\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?)/gi)) {
    const name = m[1] ?? m[3]; const createdBefore = [...src.matchAll(/op\.create_table\(\s*['"]([A-Za-z_]\w*)['"]/g)].some((c) => c[1] === name && c.index < m.index);   // in derselben Datei vorher angelegt: fällt gleich mit weg
    if (name && (tables.has(name) || createdBefore)) tables.delete(name); if (name) dropLater.add(name + '@' + m.index + '@' + f);
  }
  for (const m of src.matchAll(/op\.create_table\(\s*['"]([A-Za-z_]\w*)['"]/g)) {
    if ([...dropLater].some((k) => { const [n, at, file] = k.split('@'); return n === m[1] && file === f && Number(at) > m.index; })) continue;   // in derselben Datei später gelöscht
    const t = addTable(m[1], 'table', { path: rel(f), line: lineOf(src, m.index), symbol: m[1] });
    const start = m.index; let depth = 0, i = start; do { if (src[i] === '(') depth++; if (src[i] === ')') depth--; i++; } while (i < src.length && depth > 0);
    const body = src.slice(start, i);
    for (const c of body.matchAll(/sa\.Column\(\s*['"]([A-Za-z_]\w*)['"]\s*,\s*(?:sa\.|postgresql\.)?([A-Za-z_]+)(?:\([^)]*\))?([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
      const col = { name: c[1], type: c[2].toLowerCase() }; const rest = c[3];
      if (/primary_key=True/.test(rest)) col.pk = true; if (/nullable=True/.test(rest)) col.nullable = true;
      const fk = /ForeignKey\(\s*['"]([A-Za-z_]\w*)\.([A-Za-z_]\w*)['"]/.exec(rest); if (fk) col.fk = { table: fk[1], column: fk[2] };
      if (/server_default=.*now\(\)|func\.now/.test(rest)) col.computed = { path: rel(f), line: lineOf(src, start + c.index) };
      if (/onupdate\s*=\s*(?:sa\.)?func\.now\(\)/.test(rest)) col.updated = { path: rel(f), line: lineOf(src, start + c.index) };   // B30 Schnitt A: SQLAlchemy setzt die Spalte bei jeder Änderung
      if (!t.columns.some((x) => x.name === col.name)) t.columns.push(col);
    }
  }
}
// ── SQLAlchemy-Modelle (Column / mapped_column) und Python-Enums (Werte mit Zeile) ──
const pyEnums = new Map();   // Klassenname → [{ value, evidence }]
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
      if (/onupdate\s*=\s*(?:sa\.)?func\.now\(\)/.test(rest)) col.updated = { path: rel(f), line: i + 1 };   // B30 Schnitt A
      const en = c[2] && /^(?:Optional\[)?(\w+Enum)\]?$/.exec(c[2].replace(/\s/g, '')); if (en && pyEnums.has(en[1])) col.enum = pyEnums.get(en[1]);
      if (!t.columns.some((x) => x.name === name)) t.columns.push(col);
    }
  }
}
// ── Firestore ──
for (const f of files.filter((p) => p.endsWith('.rules'))) { const src = text(f); for (const m of src.matchAll(/match\s+\/([A-Za-z_]\w*)\/\{/g)) if (!['databases', 'documents'].includes(m[1])) addTable(m[1], 'collection', { path: rel(f), line: lineOf(src, m.index), symbol: m[1] }); }
// ── B31 Schnitt D: das Schema aus der Datenbank (--db <url> oder EVERYDECK_SCHEMA_DB_URL; die Leserolle genügt – pg_catalog liest jede Rolle). Die Datenbank ist
//    die Wahrheit: Tabellen ohne CREATE TABLE im Repo erscheinen mit Fundstelle „database“, Spalten, Typen, Schlüssel, Fremdschlüssel und Wertelisten kommen
//    aus dem Katalog; Tabellen und Spalten, die es dort nicht gibt, fallen weg. Fundstellen der Migrationen bleiben, wo es sie gibt.
const dbUrl = opt('--db') ?? process.env.EVERYDECK_SCHEMA_DB_URL ?? null;
let catalog = null;
if (dbUrl) {
  const { readCatalog, checkValues } = await import('./befund-db.mjs');
  catalog = await readCatalog(dbUrl, repo, files);
  const dbEv = (symbol) => ({ path: 'database', line: 1, symbol: symbol.slice(0, 160) });
  const key = (schema, name) => `${schema}.${name}`;
  const fromDb = new Set(catalog.tables.map((t) => key(t.schema, t.name)));
  const known = [...tables.values()].filter((t) => fromDb.has(key(t.schema ?? 'public', t.name)));
  if (tables.size && !known.length) throw new Error(`the database at --db has none of the ${tables.size} tables of the migrations – is it the database of this app?`);
  for (const [name, t] of [...tables]) if (t.kind === 'table' && !fromDb.has(key(t.schema ?? 'public', t.name))) tables.delete(name);   // im Repo, nicht in der Datenbank: es gibt sie nicht
  for (const dt of catalog.tables) {
    let t = tables.get(dt.name);
    if (t && (t.schema ?? 'public') !== dt.schema) continue;   // gleicher Name in einem anderen Schema: die Tabelle des Repos bleibt maßgeblich
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
      else if (old?.fk) col.fk = old.fk;   // auth.uid() = spalte aus einer Policy der Migrationen
      const vals = enums.get(dc.name); if (vals) col.enum = vals.slice(0, 60).map((v) => old?.enum?.find((e) => e.value === v) ?? { value: v.slice(0, 80), evidence: dbEv(`${dt.name}.${dc.name}`) }).filter((e) => e.value);
      if (old?.computed) col.computed = old.computed; else if (dc.generated || /^(now\(\)|CURRENT_TIMESTAMP|timezone\(.*now\(\)\))/i.test(dc.default ?? '')) col.computed = dbEv(`${dt.name}.${dc.name}`);
      if (old?.updated) col.updated = old.updated;
      return col;
    });
  }
  // Zeilenrechte: auth.uid() = spalte ist ein Verweis auf die Nutzertabelle des Anbieters
  for (const pl of catalog.policies) { const t = tables.get(pl.table); if (!t) continue; for (const m of `${pl.qual ?? ''} ${pl.check ?? ''}`.matchAll(/auth\.uid\(\)\s*\)?\s*=\s*\(?"?([A-Za-z_]\w*)"?|"?([A-Za-z_]\w*)"?\s*=\s*\(?\s*auth\.uid\(\)/g)) { const c = t.columns.find((x) => x.name === (m[1] ?? m[2])); if (c && !c.fk && !c.pk) c.fk = { table: 'auth.users', column: 'id' }; } }
  // Änderungsspalte aus den Triggern der Datenbank (BEFORE UPDATE … NEW.spalte = now() / moddatetime)
  const fnSrc = new Map(catalog.functions.map((f) => [f.name, f]));
  for (const dt of catalog.tables) { const t = tables.get(dt.name); if (!t) continue;
    for (const g of dt.triggers) { if (!g.before || !g.update) continue; const cols = g.function === 'moddatetime' ? [.../moddatetime\(([^)]*)\)/i.exec(g.def)?.[1]?.matchAll(/'?([A-Za-z_]\w*)'?/g) ?? []].map((x) => x[1]) : [...(fnSrc.get(g.function)?.src ?? '').matchAll(/\bnew\.(?:"?)([A-Za-z_]\w*)(?:"?)\s*:?=\s*(?:now\(\)|current_timestamp|clock_timestamp\(\))/gi)].map((x) => x[1]);
      for (const cn of cols) { const c = t.columns.find((x) => x.name === cn); if (c && !c.updated) c.updated = dbEv(`trigger ${g.name}`); } } }
}
// ── B31 E1: Spalten, die die Datenbank selbst berechnet – Guthaben, Zähler, Salden. Fakten mit Fundstelle (columns[].computed), Endzustand der Migrationen
//    (CREATE OR REPLACE: die letzte Fassung zählt; DROP FUNCTION / DROP TRIGGER entfernen):
//    – eine SQL-Funktion setzt die Spalte aus ihrem eigenen Wert oder einer lokalen Variablen, ohne einen Parameter (UPDATE … SET credits_used = v_new_used,
//      credits_total = GREATEST(COALESCE(credits_total, 0), 100)); schreibt sie einen Parameter, ist sie eine Tür, keine Berechnung;
//    – ein BEFORE-Trigger setzt NEW.spalte aus anderen Werten (nicht nur aus derselben Spalte, nicht now()).
//    Die Vorgabe lock.computed sperrt sie; der Wert bleibt bei der App.
const fnDefs = new Map(); const trigDefs = new Map();   // B46b Punkt 2: auch für die Kopien von Kontaktdaten unten
{
  for (const f of files.filter((p) => p.endsWith('.sql')).sort()) {
    const src = stripSql(text(f)); const ops = [];
    for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\(/gi)) {
      let depth = 1, i = m.index + m[0].length; while (i < src.length && depth > 0) { if (src[i] === '(') depth++; if (src[i] === ')') depth--; i++; }   // Argumente mit Klammern (numeric(10,2), default now())
      const args = src.slice(m.index + m[0].length, i - 1); const rest = src.slice(i); const tag = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(rest); if (!tag) continue;
      const bodyStart = i + tag.index + tag[0].length; const bodyEnd = src.indexOf(tag[1], bodyStart); if (bodyEnd < 0) continue;
      ops.push({ at: m.index, run: () => fnDefs.set(m[1].toLowerCase(), { name: m[1], args, trigger: /returns\s+trigger/i.test(rest.slice(0, tag.index)), body: src.slice(bodyStart, bodyEnd), bodyAt: bodyStart, src, file: rel(f) }) });
    }
    for (const m of src.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => fnDefs.delete(m[1].toLowerCase()) });
    for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?trigger\s+"?(\w+)"?\s+(before|after|instead\s+of)\s+[\s\S]*?\bon\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?[\s\S]*?execute\s+(?:function|procedure)\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => trigDefs.set(`${m[3]}:${m[1]}`.toLowerCase(), { table: m[3], when: m[2].toLowerCase(), fn: m[4].toLowerCase() }) });
    for (const m of src.matchAll(/drop\s+trigger\s+(?:if\s+exists\s+)?"?(\w+)"?\s+on\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => trigDefs.delete(`${m[2]}:${m[1]}`.toLowerCase()) });
    for (const m of src.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => { for (const k of [...trigDefs.keys()]) if (k.startsWith(`${m[1].toLowerCase()}:`)) trigDefs.delete(k); } });
    for (const op of ops.sort((a, b) => a.at - b.at)) op.run();
  }
  // B31 Schnitt D: Funktionen und Trigger, die nur in der Datenbank stehen (nicht in den Migrationen) – Fundstelle „database“
  if (catalog) {
    for (const f of catalog.functions) if (!fnDefs.has(f.name.toLowerCase())) fnDefs.set(f.name.toLowerCase(), { name: f.name, args: f.args ?? '', trigger: !!f.returns_trigger, body: f.src ?? '', bodyAt: 0, src: f.src ?? '', file: 'database' });
    for (const dt of catalog.tables) for (const g of dt.triggers) { const k = `${dt.name}:${g.name}`.toLowerCase(); if (!trigDefs.has(k)) trigDefs.set(k, { table: dt.name, when: g.before ? 'before' : 'after', fn: g.function.toLowerCase() }); }
  }
  const refers = (expr, name) => new RegExp(`(^|[^A-Za-z0-9_.])"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?([^A-Za-z0-9_]|$)`, 'i').test(expr);
  for (const fd of fnDefs.values()) {
    // Parameter und alles, was aus ihnen folgt (NEW/OLD im Trigger, lokale Variablen aus einem Parameter): wer sie schreibt, ist eine Tür
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
        if (refers(expr, c.name) || locals.some((l) => refers(expr, l) && selfCols.get(l.toLowerCase())?.has(c.name.toLowerCase()))) { c.computed = at; continue; }   // aus dem eigenen bisherigen Wert: Guthaben, Zähler
        if ([...fromParam].some((p) => refers(expr, p)) || /\$\d/.test(expr)) { if (!fd.trigger) { c.written ??= []; if (c.written.length < 5) c.written.push(at); } continue; }   // schreibt einen Parameter: eine Tür (Setzstelle)
        if (!refers(expr, c.name) && !locals.some((l) => refers(expr, l))) continue;   // weder der eigene Wert noch eine berechnete lokale Variable
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
// ── Komponenten (Anbieterpakete, die everydeck-check kennt) ──
const KNOWN = /^(stripe|@stripe\/|@paddle\/|@lemonsqueezy\/|paddle$|openai$|@anthropic-ai\/|@google\/generative-ai$|@google\/genai$|google-generativeai$|resend$|postmark$|postmarker$|nodemailer$|@sendgrid\/mail$|sendgrid$|mailgun|@aws-sdk\/client-ses$|next-auth$|@auth\/|@supabase\/supabase-js$|@supabase\/ssr$|supabase$|firebase$|firebase-admin$|@clerk\/|passport$|lucia$|expo-notifications$|expo-server-sdk$|exponent-server-sdk$|@capacitor\/push-notifications$|@capacitor-firebase\/messaging$|@react-native-firebase\/messaging$|pyfcm$|web-push$|@aws-sdk\/client-s3$|boto3$|cloudinary$|multer$|busboy$|formidable$|node-cron$|cron$|bullmq$|bull$|pg-boss$|celery$|apscheduler$|rq$|pg$|postgres$|@prisma\/client$|drizzle-orm$|asyncpg$|sqlalchemy$|psycopg|algoliasearch$|meilisearch$|typesense$|@elastic\/|@capacitor\/core$|expo$|react-native$|electron$|@tauri-apps\/|bcrypt|argon2|jsonwebtoken$|jose$|iron-session$|python-jose$|pyjwt$|passlib$|sharp$|jimp$|@supabase\/storage-js$|uploadthing$|@uploadthing\/|pillow$|socket\.io$|pusher|ably$|stream-chat$|@stream-io\/|sendbird|@sendbird\/|@paypal\/|razorpay$|@mollie\/|cohere-ai$|@mistralai\/|langchain$|@langchain\/|@ai-sdk\/|^ai$|@getbrevo\/|node-mailjet$|@workos-inc\/|auth0$|@auth0\/|@oslojs\/|agenda$|@temporalio\/|@onesignal\/|react-native-onesignal$|@react-native-firebase\/messaging$)/;
const components = [];
for (const f of files.filter((p) => p.endsWith('package.json'))) {
  const src = text(f); let pkg; try { pkg = JSON.parse(src); } catch { continue; }
  for (const dep of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) if (KNOWN.test(dep) && !components.some((c) => c.package === dep)) { const idx = src.indexOf(`"${dep}"`); components.push({ id: dep.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+/, '').slice(0, 60), package: dep, evidence: { path: rel(f), line: lineOf(src, idx) } }); }
}
for (const f of files.filter((p) => /requirements[^/]*\.txt$|pyproject\.toml$/.test(p))) {
  const src = text(f); src.split('\n').forEach((l, i) => { const raw = l.trim().split(/[=<>!\[ ;#"']/)[0]; const name = raw.toLowerCase(); if (name && KNOWN.test(name) && !components.some((c) => c.package.toLowerCase() === name)) components.push({ id: name.replace(/[^A-Za-z0-9_.-]/g, '-'), package: raw, evidence: { path: rel(f), line: i + 1 } }); });
}
// ── Routen und Seiten ──
const api_routes = []; const screens = [];
const pattern = (p) => p.replace(/\[\.\.\.[^\]]+\]/g, '*').replace(/\[([^\]]+)\]/g, ':$1').replace(/\{(\w+):path\}/g, '*').replace(/\{(\w+)(?::[^}]*)?\}/g, ':$1').replace(/\([^)]*\)\/?/g, '').replace(/\/$/, '') || '/';
const TEST_PATH = /\.(test|spec|stories)\.[tj]sx?$|(^|\/)(__tests__|e2e|cypress|tests?)\/|(^|\/)test_[^/]*\.py$/;   // B31 (S7): Seiten und Routen aus Tests sind keine der App
for (const f of files.filter((p) => /\.(ts|tsx|js|mjs|cjs|py)$/.test(p) && !TEST_PATH.test(relative(repo, p)))) {
  const src = text(f); const r = rel(f);
  const re = f.endsWith('.py') ? /@(?:app|router|api|[a-z_]+_router)\.(get|post|put|patch|delete)\(\s*['"](\/[^'"\s]*)['"]/g : /\b(?:app|router|server|fastify|api|r)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`\s]*)['"`]/g;
  for (const m of src.matchAll(re)) { if (m[2].includes('${')) continue; /* Vorlagenstrings sind Client-Aufrufe, keine Routen */ const pat = pattern(m[2]); if (!api_routes.some((x) => x.pattern === pat && x.method === m[1].toUpperCase())) api_routes.push({ pattern: pat, method: m[1].toUpperCase(), evidence: { path: r, line: lineOf(src, m.index) } }); }
  const parts = r.split('/');
  if (parts.includes('api') && /^route\.(ts|js)$/.test(parts.at(-1))) { const i = parts.indexOf('api'); const pat = pattern('/' + parts.slice(i, -1).join('/')); if (!api_routes.some((x) => x.pattern === pat)) api_routes.push({ pattern: pat, evidence: { path: r, line: 1 } }); }
  if (/^app\//.test(r) && /\/page\.(tsx|jsx|ts|js)$/.test(r) && !parts.includes('api')) { const pat = pattern('/' + parts.slice(1, -1).join('/')); if (!screens.some((x) => x.pattern === pat)) screens.push({ pattern: pat, evidence: { path: r, line: 1 } }); }
  if (/^app\//.test(r) && /\.(tsx|jsx)$/.test(r) && !/\/page\.|_layout|\+not-found|\+html/.test(r) && !parts.includes('api') && !/\.test\./.test(r) && existsSync(join(repo, 'app.json'))) { const pat = pattern('/' + r.replace(/^app\//, '').replace(/\.(tsx|jsx)$/, '').replace(/\/index$/, '')); if (!screens.some((x) => x.pattern === pat)) screens.push({ pattern: pat, evidence: { path: r, line: 1 } }); }
  for (const m of src.matchAll(/<Route\s+[^>]*path=["'](\/[^"']*)["']/g)) { const pat = pattern(m[1]); if (!screens.some((x) => x.pattern === pat)) screens.push({ pattern: pat, evidence: { path: r, line: lineOf(src, m.index) } }); }
  for (const m of src.matchAll(/\{\s*path:\s*['"](\/[^'"]*)['"]/g)) { const pat = pattern(m[1]); if (!screens.some((x) => x.pattern === pat)) screens.push({ pattern: pat, evidence: { path: r, line: lineOf(src, m.index) } }); }
}
// ── Plattformen ──
const platforms = [];
const cap = files.find((p) => /capacitor\.config\.(ts|js|json)$/.test(p)); if (cap) { platforms.push({ id: 'web', runtime: 'browser', evidence: { path: rel(cap), line: 1 } }); if (existsSync(join(repo, 'ios'))) platforms.push({ id: 'ios', runtime: 'capacitor', evidence: { path: rel(cap), line: 1 } }); if (existsSync(join(repo, 'android'))) platforms.push({ id: 'android', runtime: 'capacitor', evidence: { path: rel(cap), line: 1 } }); }
const appJson = files.find((p) => /(^|\/)app\.json$/.test(p) && text(p).includes('"expo"')); if (appJson) for (const id of ['web', 'ios', 'android']) platforms.push({ id, runtime: 'expo', evidence: { path: rel(appJson), line: 1 } });
if (!platforms.length && files.some((p) => /package\.json$/.test(p))) platforms.push({ id: 'web', runtime: 'browser', evidence: { path: rel(files.find((p) => /package\.json$/.test(p))), line: 1 } });
if (components.some((c) => /^(pg|postgres|asyncpg|sqlalchemy|psycopg|@prisma\/client|drizzle-orm)/.test(c.package))) platforms.push({ id: 'server', runtime: files.some((p) => p.endsWith('.py')) ? 'python' : 'node', evidence: components.find((c) => /^(pg|postgres|asyncpg|sqlalchemy|psycopg|@prisma\/client|drizzle-orm)/.test(c.package)).evidence });

const BLOCKS = ['login', 'people_roles', 'organizations', 'content_status', 'moderation', 'chats', 'uploads', 'search', 'payments', 'email', 'push', 'ai', 'jobs', 'imports', 'bookings', 'settings', 'platforms'];
const merge = opt('--merge') && existsSync(opt('--merge')) ? JSON.parse(readFileSync(opt('--merge'), 'utf8')) : null;
// ── Anzeigestellen: jeder Datenzugriff im Frontend, über den Syntaxbaum (B29 Abnahme, vierte Runde; befund-reads.mjs) ──
// Direkt (supabase.from('x' as never), Firestore, ORM, SQL), über .rpc('fn') → Tabellen der SQL-Funktion, functions.invoke('n') → Tabellen der Edge
// Function, Realtime postgres_changes, Sichten → Basistabellen, API-Aufrufe (`${API_BASE}/persons/${id}` → /persons/:p) → Tabellen, die der Handler der
// Route liest (FastAPI: Pfadparameter, APIRouter(prefix), include_router; Express: app.use). Jede Stelle: shown[] { path, line, element: "data", via, symbol }.
// Schreibzugriffe und sonstige Nennungen eines Tabellennamens im Frontend stehen für Tabellen ohne Anzeigestelle als not_shown[] { path, line, reason } –
// die Gegenprobe von everydeck-check (eigener Zeichenketten-Scanner) verlangt für jede Nennung einer Tabelle ohne Anzeigestelle genau so einen Eintrag.
const tableKey = (n) => (tables.has(n) ? n : [...tables.keys()].find((k) => k.toLowerCase() === n.toLowerCase()) ?? null);
const addShown = (name, entry) => { const t = tables.get(name); if (!t) return; t.shown ??= []; if (t.shown.length < 60 && !t.shown.some((x) => x.path === entry.path && x.line === entry.line)) t.shown.push({ path: entry.path, line: entry.line, element: 'data', ...(entry.symbol ? { symbol: entry.symbol } : {}), ...(entry.via ? { via: entry.via } : {}) }); };
// Endzustand: ein Fremdschlüssel auf eine Tabelle, die es im Endzustand nicht gibt (DROP TABLE … CASCADE), existiert nicht mehr; Schemata außerhalb (auth.users) bleiben
for (const t of tables.values()) for (const c of t.columns) if (c.fk && !c.fk.table.includes('.') && !tableKey(c.fk.table)) delete c.fk;
const reads = analyseReads({ repo, files, tables, tableKey });
// Routen mit vollem Muster (FastAPI: APIRouter(prefix) + include_router(prefix) + Pfad; Express: app.use-Präfix) aus der Analyse; Regex-Funde, die darin aufgehen, fallen weg
for (const r of reads.routes) { const entry = { pattern: r.pattern, method: r.method, evidence: { path: r.file, line: r.line } };
  const i = api_routes.findIndex((x) => x.evidence.path === r.file && x.evidence.line === r.line && (!x.method || x.method === r.method));   // dieselbe Fundstelle (der Dekorator): volles Muster statt Pfad
  if (i >= 0) api_routes[i] = entry; else if (!api_routes.some((x) => x.pattern === r.pattern && x.method === r.method)) api_routes.push(entry); }
for (let i = api_routes.length - 1; i >= 0; i--) if (api_routes.findIndex((x) => x.pattern === api_routes[i].pattern && x.method === api_routes[i].method) !== i) api_routes.splice(i, 1);   // ein Muster je Methode
// B32 (O4): Seiten nur aus Dateien, die der Einstieg der App erreicht; die übrigen stehen als unreachable[] im Befund (dieselbe Regel prüft everydeck-check)
const unreachablePaths = new Set(reads.reach.unreachable.map((u) => u.path));
for (let i = screens.length - 1; i >= 0; i--) if (unreachablePaths.has(screens[i].evidence.path)) screens.splice(i, 1);
for (const s of reads.shown) addShown(s.table, s);
// B31 Schnitt A: Anzeigestellen je Spalte (element data, Stelle = wo die Spalte genannt oder ausgelesen wird) – der Lese-Umfang enthält nur Spalten mit Anzeigestelle
// B31 E1: Setzstellen (columns[].written) und Kennungen anderer Systeme (columns[].external_id: der Wert stammt aus dem Aufruf eines Anbieterpakets oder wird ihm übergeben)
for (const w of reads.column_writes) { const c = tables.get(w.table)?.columns.find((x) => x.name === w.column); if (!c || c.pk) continue;
  if (w.self) { c.computed ??= { path: w.path, line: w.line }; continue; }   // die App berechnet den Wert aus dem bisherigen (Guthaben, Zähler): gehalten von der App
  c.written ??= []; if (c.written.length < 5 && !c.written.some((x) => x.path === w.path && x.line === w.line)) c.written.push({ path: w.path, line: w.line }); }
for (const pc of reads.provider_columns) {
  const comp = components.find((x) => x.package.toLowerCase() === pc.provider.toLowerCase()); if (!comp) continue;   // nur Pakete, die das Gerüst als Anbieter kennt
  // Tabellen, die die Funktion liest; liest sie keine mit dieser Spalte, nur die eine Tabelle, die eine Spalte dieses Namens hat – bei mehreren bleibt es offen
  const named = [...tables.keys()].filter((t) => tables.get(t).columns.some((x) => x.name === pc.column));
  const cands = pc.table ? [pc.table] : (pc.tables ?? []).some((t) => named.includes(t)) ? pc.tables : named.length === 1 ? named : [];
  for (const tn of cands) { const c = tables.get(tn)?.columns.find((x) => x.name === pc.column); if (c && !c.pk && !c.fk && !c.external_id) c.external_id = { component: comp.id, evidence: { path: pc.path, line: pc.line } }; }
}
for (const cs of reads.columns_shown) { const c = tables.get(cs.table)?.columns.find((x) => x.name === cs.column); if (!c) continue; c.shown ??= []; if (c.shown.length < 3 && !c.shown.some((x) => x.path === cs.path && x.line === cs.line)) c.shown.push({ path: cs.path, line: cs.line, element: 'data', symbol: cs.column, via: cs.via }); }
// B32 (O3): Geld – wo die App einen Wert als Währung formatiert (befund-reads.mjs: Intl.NumberFormat/toLocaleString mit style currency, eigene Funktionen
// nur mit so einem Aufruf im Körper). Die Eigenschaft gehört zur Spalte desselben Namens, wenn die Spalte eine Zahl ist und das Frontend ihre Tabelle liest;
// die Währung steht im Aufruf (currency) oder in einer Spalte derselben Tabelle (currency_column) – sonst keine Währung, nichts geraten.
const readTables = new Set(reads.columns_shown.map((x) => x.table));
for (const m of reads.money) for (const [tn, t] of tables) { if (!readTables.has(tn)) continue; const c = t.columns.find((x) => x.name === m.prop); if (!c || c.pk || c.fk || !/int|numeric|decimal|real|double|float|money|number/i.test(c.type)) continue;
  c.shown ??= []; if (c.shown.filter((x) => x.element === 'money').length >= 2 || c.shown.some((x) => x.element === 'money' && x.path === m.path && x.line === m.line)) continue;
  const curCol = m.currency_prop && t.columns.some((x) => x.name === m.currency_prop) ? m.currency_prop : null;
  c.shown.push({ path: m.path, line: m.line, element: 'money', ...(m.currency ? { currency: m.currency } : curCol ? { currency_column: curCol } : {}), symbol: m.prop, via: m.via }); }
// B35 Punkt 1: Anzeigeart aus der Stelle, an der die App den Wert zeigt (befund-display.mjs: <img src>, Hintergrundbild, <a href>, <textarea>, Text mit
// Zeilenumbrüchen oder Markdown, Datumsformatierer), über Abbildungen, Variablen und Props bis zur Eigenschaft; die Eigenschaft gehört zur Spalte desselben
// Namens in einer Tabelle, die das Frontend liest, mit einem Typ, der den Wert halten kann. Was sich nicht verfolgen lässt, steht in display_ends[].
const holds = { image: /char|text|json|\[\]/i, link: /char|text/i, textarea: /char|text/i, long_text: /char|text/i, date: /date|time|char|text/i };
// B46 Punkt 2: Kontaktangabe (mailto:/tel:/sms:/wa.me, Eingabefeld type email/tel) – Fakt columns[].contact mit der Stelle, keine Anzeigestelle
for (const d of reads.display ?? []) { const kind = d.element === 'contact_email' ? 'email' : d.element === 'contact_phone' ? 'phone' : null; if (!kind) continue;
  for (const [tn, t] of tables) { if (!readTables.has(tn) || (d.tables && !d.tables.includes(tn))) continue; const c = t.columns.find((x) => x.name === d.prop); if (!c || c.pk || c.fk || !/char|text/i.test(c.type) || c.contact) continue;
    c.contact = { kind, evidence: { path: d.path, line: d.line, ...(d.symbol ? { symbol: d.symbol } : {}) } }; } }
for (const d of reads.display ?? []) for (const [tn, t] of tables) { if (!readTables.has(tn) || (d.tables && !d.tables.includes(tn))) continue; const c = t.columns.find((x) => x.name === d.prop); if (!c || c.pk || c.fk || !holds[d.element]?.test(c.type)) continue;
  c.shown ??= []; if (c.shown.filter((x) => x.element === d.element).length >= 3 || c.shown.some((x) => x.element === d.element && x.path === d.path && x.line === d.line)) continue;
  c.shown.push({ path: d.path, line: d.line, element: d.element, symbol: d.symbol, via: d.via }); }   // Symbol: der Ausdruck an der Anzeigestelle (everydeck-check findet ihn dort)
// B35 Punkt 2: Bezeichnungen der App für Werte (Zuordnung im Code: Objekt[x], switch, i18n-Schlüssel aus dem Wert, <option value>), mit Sprache der
// Übersetzungsdatei und Fundstelle; bei festen Werten (enum, Status) nur für diese Werte
for (const l of reads.value_labels ?? []) for (const [tn, t] of tables) { if (!l.tables?.includes(tn)) continue; const c = t.columns.find((x) => x.name === l.column); if (!c || c.pk || c.fk) continue;
  const known = [...(c.enum ?? []).map((e) => e.value), ...(t.status_column === c.name ? (t.statuses ?? []).map((x) => x.value) : [])]; if (known.length && !known.includes(l.value)) continue;
  c.value_labels ??= []; if (c.value_labels.length >= 400 || c.value_labels.some((x) => x.value === l.value && (x.lang ?? null) === (l.lang ?? null) && x.label === l.label)) continue;
  c.value_labels.push({ value: l.value, label: l.label.slice(0, 120), ...(l.lang ? { lang: l.lang } : {}), evidence: { path: l.path, line: l.line } }); }
// B35 Punkt 3: Anzeigename einer Person – die Regel der App aus angezeigten Ausdrücken, die mit der Namensspalte der Personentabelle beginnen
// (Zusammensetzung, Ersatzstufen); mehrere Stellen: der gemeinsame Anfang; ein fester Text als letzte Stufe ist kein Name der Person
const nameRuleOf = (identity) => { const nameCol = identity?.fields?.display_name?.column; if (!identity?.table || !nameCol) return null;
  const chains = (reads.name_chains ?? []).filter((c) => c.table === identity.table && c.steps[0]?.columns.includes(nameCol)); if (!chains.length) return null;
  const key = (st) => JSON.stringify(st); let steps = chains[0].steps;
  for (const c of chains.slice(1)) { let i = 0; while (i < steps.length && i < c.steps.length && key(steps[i]) === key(c.steps[i])) i++; steps = steps.slice(0, i); }
  return steps.length ? { steps, evidence: [...chains].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line).slice(0, 5).map((c) => ({ path: c.path, line: c.line, symbol: c.symbol })) } : null; };
for (const m of reads.not_shown) { const t = tables.get(m.table); if (!t) continue; t.not_shown ??= []; if (t.not_shown.length < 100 && !t.not_shown.some((x) => x.path === m.path && x.line === m.line)) t.not_shown.push({ path: m.path, line: m.line, fact: m.fact }); }

// B31: Tabellen des bestehenden Befunds, die das Gerüst nicht kennt (vom Agenten ergänzt), bleiben – außer die Datenbank sagt, dass es sie nicht gibt
const keptOld = (merge?.tables ?? []).filter((x) => !tables.has(x.name) && (!catalog || catalog.tables.some((d) => d.name === x.name)));
const mergedTables = [...[...tables.values()].map((t) => { const old = merge?.tables?.find((x) => x.name === t.name); if (!old) return t; const keep = (old.shown ?? []).filter((x) => x.element !== 'data'); const { not_shown: _dropped, shown: _old, ...rest } = old; return { ...rest, defined: t.defined, ...(keep.length || t.shown ? { shown: [...keep, ...(t.shown ?? [])].slice(0, 60) } : {}), ...(t.not_shown ? { not_shown: t.not_shown } : {}), columns: [...t.columns.map((c) => { const oc = old.columns.find((x) => x.name === c.name); if (!oc) return c; const keepShown = (oc.shown ?? []).filter((x) => x.element !== 'data' && !(c.shown ?? []).some((y) => y.element === x.element && y.path === x.path && y.line === x.line));   /* B32: was das Gerüst selbst wieder findet (Geld), nicht doppelt */ const shownAll = [...keepShown, ...(c.shown ?? [])].slice(0, 12); return { ...c, ...(oc.external_id && !c.external_id ? { external_id: oc.external_id } : {}), ...(oc.contact && !c.contact ? { contact: oc.contact } : {}), ...(shownAll.length ? { shown: shownAll } : {}) };   /* B46b: der Fakt contact des Agenten bleibt */ }), ...old.columns.filter((x) => !t.columns.some((c) => c.name === x.name) && !(catalog && t.kind === 'table'))] }; }), ...keptOld];   // B31: Spalten-Anzeigestellen des Agenten (heading, money …) bleiben, data-Stellen erneuert das Gerüst; mit --db zählen nur die Spalten der Datenbank   // Gerüstteile (data-Anzeigestellen, not_shown) werden erneuert; Agenten-Einträge und vom Agenten ergänzte Spalten (z. B. Firestore) bleiben
// ── B46b Punkt 2 (B46 Fund 2): Kopien von Kontaktdaten und Nachrichten. Schreibt eine SQL-Funktion der App einen als contact belegten Wert – auch gekürzt
//    oder umgeformt (left(NEW.content, 140)) – in eine andere Spalte, ist diese Spalte derselbe Fakt: NEW./OLD. der Tabelle eines Triggers, lokale Variablen
//    daraus, und INSERT … SELECT aus der Tabelle selbst. Fundstelle ist die Stelle, an der die Funktion die Spalte schreibt (die Spalte steht dort). Kopien
//    von Kopien zählen auch (bis drei Stufen). Der Agent belegt die Quelle (z. B. messages.content als message), das Gerüst folgt mit --merge.
{
  const byName = new Map(mergedTables.map((t) => [t.name, t]));
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = (x) => new RegExp(`(^|[^A-Za-z0-9_."])"?${esc(x)}"?(?![A-Za-z0-9_])`, 'i');
  // Teile auf oberster Ebene (Kommas außerhalb von Klammern und Zeichenketten), je mit Versatz
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
      // Quellen: { re, kind, table, column } – NEW./OLD. der Tabellen, deren Trigger diese Funktion aufrufen
      const refs = [];
      for (const td of trigDefs.values()) if (td.fn === fd.name.toLowerCase()) for (const c of contactCols(td.table)) refs.push({ re: new RegExp(`\\b(?:new|old)\\s*\\.\\s*"?${esc(c.name)}"?(?![A-Za-z0-9_])`, 'i'), kind: c.contact.kind, table: td.table, column: c.name });
      const taint = (expr, extra = []) => [...refs, ...extra].find((r) => r.re.test(expr)) ?? null;
      // lokale Variablen aus einer Quelle (v := lower(NEW.email))
      for (let i = 0; i < 3; i++) for (const a of body.matchAll(/(?:^|[;\s])([A-Za-z_]\w*)\s*:=\s*([^;]+);/g)) { if (/^new$|^old$/i.test(a[1])) continue; const r = taint(a[2]); if (r && !refs.some((x) => x.local === a[1].toLowerCase())) refs.push({ ...r, re: word(a[1]), local: a[1].toLowerCase() }); }
      // BEFORE-Trigger: NEW.andere_spalte := Ausdruck aus der Quelle (dieselbe Tabelle)
      for (const td of trigDefs.values()) if (td.fn === fd.name.toLowerCase()) for (const a of body.matchAll(/\bnew\s*\.\s*"?([A-Za-z_]\w*)"?\s*:=\s*([^;]+);/gi)) { const r = taint(a[2]); if (r && setContact(td.table, a[1], r.kind, place(fd, a.index + a[0].indexOf(a[1])), r)) changed = true; }
      // INSERT INTO x (spalten) VALUES (…) | SELECT … FROM quelle
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
      // UPDATE x SET spalte = Ausdruck aus der Quelle
      for (const u of body.matchAll(/\bupdate\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+set\s+/gi)) {
        const start = u.index + u[0].length; const seg = body.slice(start).split(';')[0]; const end = /\b(?:where|returning|from)\b/i.exec(masked(seg));
        for (const [part, off] of splitTop(seg.slice(0, end ? end.index : seg.length))) { const a = /^\s*"?([A-Za-z_]\w*)"?\s*=\s*([\s\S]+)$/.exec(part); if (!a) continue; const r = taint(a[2]); if (r && setContact(u[1], a[1], r.kind, place(fd, start + off + part.indexOf(a[1])), r)) changed = true; }
      }
    }
  }
}
// B38 Punkt 1: das Icon, das die App selbst ausliefert (Gerüstteil, bei jedem Lauf neu; Beschreibungen des Agenten unter `app` bleiben)
const icon = findIcon(repo, files);
const appOut = (() => { const { icon: _old, ...rest } = merge?.app ?? {}; const a = { ...rest, ...(icon ? { icon } : {}) }; return Object.keys(a).length ? a : null; })();
const out = { schema_version: '1.12-r0', release_key: merge?.release_key ?? `git:${commit.slice(0, 12)}`, commit, ...(appOut ? { app: appOut } : {}),
  components: [...components.map((c) => ({ ...c, ...(merge?.components?.find((x) => x.package === c.package)?.call ? { call: merge.components.find((x) => x.package === c.package).call } : {}) })), ...(merge?.components ?? []).filter((x) => !components.some((c) => c.package === x.package))], platforms: merge?.platforms ?? platforms, screens: screens.map((x) => { const d = merge?.screens?.find((y) => y.pattern === x.pattern)?.described; return d ? { ...x, described: d } : x; }), api_routes,   // B37: die Beschreibung einer Seite (described) bleibt, solange es die Seite gibt
    // vom Agenten ergänzte Komponenten (z. B. ein Paket in einer Edge Function) bleiben
  // B31: vom Agenten genannte Tabellen der everydeck-Installation bleiben (solange es die Tabelle gibt)
  ...(reads.reach.unreachable.length ? { unreachable: reads.reach.unreachable.slice(0, 500) } : {}),
  ...((reads.display_ends ?? []).filter((e) => !e.element.startsWith('contact_')).length ? { display_ends: reads.display_ends.filter((e) => !e.element.startsWith('contact_')) } : {}),   // B46: eine Kontaktstelle ohne Spalte ist kein Fakt der Anzeige   // B35 Punkt 1: Anzeigestellen, deren Wert sich nicht bis zu einer Spalte verfolgen lässt (Fakt, nie geraten)   // B32 (O4): Dateien, die kein Einstieg der App erreicht – keine Seite, keine Anzeigestelle
  ...(merge?.everydeck_tables ? { everydeck_tables: merge.everydeck_tables.filter((y) => mergedTables.some((t) => t.name === y.table)) } : {}),
  ...(merge?.works_with ? { works_with: merge.works_with.filter((w) => tables.has(w.table) && (!w.part_of || tables.has(w.part_of))) } : {}),   // Beschreibung des Agenten bleibt; Einträge zu Tabellen, die es im Endzustand nicht mehr gibt, fallen weg
  identity: (() => { const id = merge?.identity ?? null; if (!id) return null; const { name_rule: _old, ...rest } = id; const rule = nameRuleOf(id); return rule ? { ...rest, name_rule: rule } : rest; })(), tables: mergedTables, functions: merge?.functions ?? [], flows: merge?.flows ?? [], ...(merge?.channels ? { channels: merge.channels } : {}), ...(merge?.jobs ? { jobs: merge.jobs } : {}), ...(merge?.payments !== undefined ? { payments: merge.payments } : {}), ...(merge?.adapters ? { adapters: merge.adapters } : {}),
  checklist: merge?.checklist ?? BLOCKS.map((block) => ({ block, present: false })) };
// B31 (S9/S24): --types nennt die Namen der Objektarten, wie everydeck sie ableitet (Einzahl des Tabellennamens) – für Trigger, Aktionen, Tür und Aufräumliste vor dem Einreichen
if (args.includes('--types')) {
  const singular = (n) => (/ies$/.test(n) ? n.replace(/ies$/, 'y') : /(ses|xes|zes|ches|shes)$/.test(n) ? n.replace(/es$/, '') : /[^s]s$/.test(n) ? n.replace(/s$/, '') : n);
  const slugOf = (x) => x.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 63) || 'x';
  process.stdout.write(JSON.stringify(Object.fromEntries(out.tables.map((t) => [t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name, slugOf(singular(t.name))])), null, 1) + '\n'); process.exit(0);
}
// Nie ungefragt ins Repo schreiben: ohne --out geht der Befund auf stdout (B29 Abnahme, Kleinkram)
const outPath = opt('--out');
if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n'); else process.stdout.write(JSON.stringify(out, null, 1) + '\n');
console.error(JSON.stringify({ out: outPath, tables: out.tables.length, columns: out.tables.reduce((n, t) => n + t.columns.length, 0), shown: out.tables.filter((t) => (t.shown ?? []).length || t.columns.some((c) => (c.shown ?? []).length)).length, not_shown: out.tables.reduce((n, t) => n + (t.not_shown ?? []).length, 0), components: out.components.length, api_routes: api_routes.length, screens: screens.length, platforms: out.platforms.length, routes_with_reads: reads.routes.filter((r) => r.reads.length).length, views: reads.views.length, sql_functions: reads.sql_functions.length, merged: !!merge }));
