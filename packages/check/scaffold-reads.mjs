// Display places through the syntax tree instead of text patterns. Part of the app map scaffold (scaffold.mjs), facts only:
//   frontend reads a table directly:      supabase.from('x' as never).select(…), .table('x'), Firestore collection(db, 'x'), prisma.x.findMany(), db.select().from(x), SQL in strings
//   through an SQL function:               .rpc('fn')            → the tables fn reads in the final state of the migrations (FROM/JOIN, not DELETE/INSERT/UPDATE)
//   through an Edge Function:              functions.invoke('n') → the tables supabase/functions/n reads
//   through a Realtime subscription:       .on('postgres_changes', { table: 'x' })
//   through a view:                        .from('v') with CREATE VIEW v AS SELECT … FROM a JOIN b → a and b
//   through an API route:                  fetch(`${API_BASE}/persons/${id}`) / api.get('/events') → normalized to /persons/:p and matched against the backend
//                                          routes (FastAPI: path parameters, APIRouter(prefix), include_router(prefix) along the imports; Express: app.use('/p', router));
//                                          what counts is what the handler reads, also through called functions in other modules
//   Writes (insert/update/delete/upsert, POST/PUT/PATCH/DELETE) are not display places; they and every other mention of a table name
//   in a frontend string appear, for tables without a display place, as tables[].not_shown[] with a reason and place (cross-check in everydeck-check).
// TypeScript compiler API for TS/JS/TSX/JSX (from the app's repo or next to this tool), `ast` for Python (scaffold-ast.py). If a tool is missing,
// the skeleton stops with a message; nothing is dropped silently.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
// Import resolution and reachability from the app's entry point: the same rule as in everydeck-check (bundled)
import { codeMention, moduleResolver, reachability } from './rules/everydeck-rules.mjs';   // rule bundle inside the package (build output)
// follow the value to the display place (image, link, date, text field, text with line breaks)
import { analyseDisplay } from './scaffold-display.mjs';

export const BACKEND_DIR = /(^|\/)(backend|server|api|functions|supabase|migrations|scripts|prisma|db|database|test|tests|__tests__|e2e|cypress)(\/|$)/;
const TEST_FILE = /\.(test|spec|stories)\.[tj]sx?$|(^|\/)(__tests__|e2e|cypress|tests?)\//;
// Type files do not count as frontend source (generated Supabase types, *.d.ts, types.ts), neither for display places nor for the cross-check
export const isTypeFile = (r, src) => /\.d\.ts$|(^|\/)(types|.*\.types|database\.types|database|supabase-types|schema)\.ts$/.test(r) || (/\.ts$/.test(r) && /\bTables:\s*\{/.test(src ?? ''));
export const isFrontendFile = (r, src) => !BACKEND_DIR.test(r) && !TEST_FILE.test(r) && !isTypeFile(r, src)
  && (/\.(tsx|jsx|vue|svelte)$/.test(r) || (/\.(ts|js|mjs)$/.test(r) && /^(src|app|pages|components|lib|frontend|client|web|hooks|contexts|utils|features)\//.test(r)))
  && !(/\.(ts|js|mjs)$/.test(r) && REGISTERS_ROUTES.test(src ?? ''));   // a file that registers routes is backend, wherever it is; whether a helper module counts is decided by reachability from a page
export const isBackendJs = (r, src) => /\.(ts|js|mjs|cjs)$/.test(r) && !TEST_FILE.test(r) && !/\.d\.ts$/.test(r)
  && (BACKEND_DIR.test(r) || /\/route\.[tj]s$/.test(r) || REGISTERS_ROUTES.test(src ?? '') || (!/\.(tsx|jsx)$/.test(r) && SERVER_IMPORT.test(src ?? '')));
// app.get('/x', handler) registers a route (the second argument is a function); api.get('/x') is a client call
const REGISTERS_ROUTES = /\b(app|router|server|fastify|r|hono|routes)\.(get|post|put|patch|delete|all)\(\s*['"`]\/[^'"`]*['"`]\s*,\s*(async\b|\(|function\b|[A-Za-z_]\w*\s*[,)])/;
const NAVIGATION = /^(navigate|push|replace|redirect|go|open|assign|matchPath|useMatch|startsWith|endsWith|includes|indexOf|split|test|match|exec|join|concat|require|import|resolve|normalize|basename|dirname|relative|localeCompare|t|i18n|useTranslation|log|warn|error|info|debug)$/;
// a file that loads Node built-ins or server packages is server code, not frontend, whatever folder it is in
export const SERVER_IMPORT = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)['"](?:node:[a-z_]+|fs|fs\/promises|path|crypto|http|https|http2|net|os|child_process|worker_threads|stream|zlib|pg|postgres|mysql2?|better-sqlite3|express|fastify|@fastify\/[^'"]+|koa|hono|firebase-admin|firebase-functions|next\/server)['"]/;
const WRITE_METHODS = new Set(['insert', 'update', 'delete', 'upsert']);
const ORM_READ = /^(find\w*|count|aggregate|groupBy|findMany|findFirst|findUnique)$/; const ORM_WRITE = /^(create\w*|update\w*|delete\w*|upsert)$/;
const FIRESTORE_WRITE = new Set(['addDoc', 'setDoc', 'updateDoc', 'deleteDoc']); const FIRESTORE_READ = new Set(['getDocs', 'getDoc', 'onSnapshot', 'query', 'where', 'orderBy', 'limit', 'startAfter', 'doc']);
const SQL_READ = /\b(from|join)\s+(?:"?[A-Za-z_]\w*"?\.)?"?([A-Za-z_]\w*)"?/gi;
const SQL_NOISE = new Set(['select', 'where', 'values', 'lateral', 'only', 'the', 'a', 'an', 'your', 'this', 'that']);
const SQL_WORDS = new Set('select from where join on as and or not null is in distinct case when then else end count sum min max avg coalesce now true false left right inner outer order by group limit asc desc with lower upper cast interval having exists any all like ilike between offset over partition filter nulls first last using lateral only returning values set into default row array jsonb json text int integer uuid bigint numeric date timestamp timestamptz boolean'.split(' '));
/** Columns of an SQL query per table read (SELECT list up to FROM; alias.column → table of the alias, otherwise a candidate for every table of the query; "*" = all). lineAt(index) → line. */
export function sqlColumns(text, lineAt) {
  const out = {};
  for (const m of text.matchAll(/\bselect\b([\s\S]*?)\bfrom\b([\s\S]*?)(?=\bwhere\b|\bgroup\b|\border\b|\blimit\b|;|\)|$)/gi)) {
    const tables = {};
    for (const t of m[2].trim().matchAll(/(?:^|\bjoin\b|,)\s*(?:"?[A-Za-z_]\w*"?\.)?"?([A-Za-z_]\w*)"?(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi)) { const [, name, alias] = t; if (!name || SQL_WORDS.has(name.toLowerCase())) continue; tables[name] = name; if (alias && !SQL_WORDS.has(alias.toLowerCase())) tables[alias] = name; }
    const names = [...new Set(Object.values(tables))]; if (!names.length) continue;
    const listAt = m.index + m[0].indexOf(m[1]);
    for (const it of m[1].matchAll(/(?:([A-Za-z_]\w*)\.)?(\*|[A-Za-z_]\w*)/g)) { const [, alias, col] = it; if (col !== '*' && SQL_WORDS.has(col.toLowerCase())) continue;
      const targets = alias && tables[alias] ? [tables[alias]] : names.sort();
      for (const t of targets) { if (out[t] === '*') continue; if (col === '*') { out[t] = '*'; continue; } out[t] ??= []; if (!out[t].some((c) => c.name === col)) out[t].push({ name: col, line: lineAt(listAt + it.index) }); } }
  }
  return out;
}

export function pattern(p) { return p.replace(/\[\.\.\.[^\]]+\]/g, '*').replace(/\[([^\]]+)\]/g, ':$1').replace(/\{(\w+):path\}/g, '*').replace(/\{(\w+)(?::[^}]*)?\}/g, ':$1').replace(/\([^)]*\)\/?/g, '').replace(/\/+$/, '') || '/'; }
const joinPath = (...parts) => ('/' + parts.filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/\/$/, '') || '/';

/** TypeScript from the app's repo (also in subfolders with a package.json) or next to this tool; without TypeScript no analysis, with a message. */
export function loadTypescript(repo, files) {
  const roots = [repo, ...files.filter((f) => f.endsWith('package.json')).map((f) => dirname(f))].map((d) => join(d, 'package.json'));
  for (const r of [...roots, import.meta.url]) { try { return createRequire(r)('typescript'); } catch { /* next */ } }
  return null;
}

/** SQL views and functions in the final state of the migrations: view → base tables, function → tables read (the last definition counts; DROP removes). */
export function sqlKnowledge(sqlTexts) {
  const views = new Map(); const fns = new Map();
  const readsIn = (body) => { const deleted = new Set([...body.matchAll(/\bdelete\s+from\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)].map((m) => m[1])); const out = [];
    for (const m of body.matchAll(SQL_READ)) { const before = body.slice(Math.max(0, m.index - 12), m.index).toLowerCase().trimEnd(); if (m[1].toLowerCase() === 'from' && before.endsWith('delete') && deleted.has(m[2])) continue; if (!SQL_NOISE.has(m[2].toLowerCase()) && !out.includes(m[2])) out.push(m[2]); } return out; };
  for (const src0 of sqlTexts) {
    const src = src0.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
    // in file order: CREATE and DROP in the order they appear (DROP VIEW x; CREATE VIEW x … in the same file)
    const ops = [];
    for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?[\s\S]*?\bas\b([\s\S]*?);/gi)) ops.push({ at: m.index, run: () => views.set(m[1], readsIn(m[2])) });
    for (const m of src.matchAll(/drop\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => views.delete(m[1]) });
    for (const m of src.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\(/gi)) {
      const rest = src.slice(m.index + m[0].length); const tag = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(rest); if (!tag) continue;
      const bodyStart = tag.index + tag[0].length; const bodyEnd = rest.indexOf(tag[1], bodyStart); if (bodyEnd < 0) continue;
      const body = rest.slice(bodyStart, bodyEnd); ops.push({ at: m.index, run: () => fns.set(m[1], { reads: readsIn(body), calls: [...new Set([...body.matchAll(/\b(?:public\.)?([A-Za-z_]\w*)\s*\(/g)].map((x) => x[1]))] }) });
    }
    for (const m of src.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?/gi)) ops.push({ at: m.index, run: () => fns.delete(m[1]) });
    for (const op of ops.sort((a, b) => a.at - b.at)) op.run();
  }
  return { views, fns };
}

/** Everything an analysis returns: { shown[], not_shown[], routes[] }; table names are already mapped to the app map (tableKey). */
export function analyseReads({ repo: repo0, files: files0, tables, tableKey }) {
  const repo = resolve(repo0); const files = files0.map((f) => resolve(f));   // absolute paths: imports resolve to absolute paths
  const rel = (p) => relative(repo, p); const text = (p) => readFileSync(p, 'utf8');
  const srcOf = new Map(); const read = (p) => { if (!srcOf.has(p)) srcOf.set(p, text(p)); return srcOf.get(p); };
  const { views, fns } = sqlKnowledge([...files.filter((p) => p.endsWith('.sql')).sort().map(read), ...files.filter((p) => p.endsWith('.py') && /alembic|migrations|versions/.test(p)).sort().map(read)]);
  // view → tables of the app map (recursive through views), SQL function → tables (recursive through called functions)
  const viewTables = (name, seen = new Set()) => { if (seen.has(name)) return []; seen.add(name); const k = tableKey(name); if (k) return [k]; const v = views.get(name); return v ? v.flatMap((t) => viewTables(t, seen)) : []; };
  const fnTables = (name, seen = new Set()) => { if (seen.has(name)) return []; seen.add(name); const f = fns.get(name); if (!f) return []; return [...f.reads.flatMap((t) => viewTables(t, new Set(seen))), ...f.calls.filter((c) => fns.has(c)).flatMap((c) => fnTables(c, seen))]; };
  const uniq = (xs) => [...new Set(xs)];
  const codeFiles = files.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(p));
  const frontend = codeFiles.filter((p) => isFrontendFile(rel(p), read(p)));
  const backendJs = codeFiles.filter((p) => isBackendJs(rel(p), read(p)));
  const pyFiles = files.filter((p) => p.endsWith('.py'));
  const ts = frontend.length || backendJs.length ? loadTypescript(repo, files) : null;
  if ((frontend.length || backendJs.length) && !ts) throw new Error('typescript not found: install it in the app (npm i -D typescript) or run the generator from the everydeck bundle');

  // ── TypeScript: syntax tree per file ──
  const sfCache = new Map();
  const parse = (p) => { if (sfCache.has(p)) return sfCache.get(p); let src = read(p); const r = rel(p);
    if (/\.(vue|svelte)$/.test(r)) src = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');   // only the script part
    const kind = /\.tsx$/.test(r) ? ts.ScriptKind.TSX : /\.jsx$/.test(r) ? ts.ScriptKind.JSX : /\.(js|mjs|cjs)$/.test(r) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(r, src, ts.ScriptTarget.Latest, true, kind); sfCache.set(p, sf); return sf; };
  const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const lineIn = (sf, node, idx) => { const text = node.text ?? ''; const before = text.slice(0, Math.max(0, idx)); const head = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? 0 : 0; return lineOf(sf, node) + (before.match(/\n/g) ?? []).length + head; };   // line of the match in a multi-line template
  const unwrap = (n) => { while (n && (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n))) n = n.expression; return n; };
  const strOf = (n) => { n = unwrap(n); return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null; };
  const calleeName = (call) => (ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ts.isIdentifier(call.expression) ? call.expression.text : null);
  const receiver = (call) => (ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : null);
  /** The call `.name(…)` in the chain after `call` (supabase.from('x').select('a, b')) */
  const chainCall = (call, name) => { let cur = call; while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur && cur.parent.parent && ts.isCallExpression(cur.parent.parent) && cur.parent.parent.expression === cur.parent) { if (cur.parent.name.text === name) return cur.parent.parent; cur = cur.parent.parent; } return null; };
  /** Columns of a supabase select: the line per name; embedded relations rel(…) as separate reads; "*" = all */
  const selectColumns = (sf, node) => { const text = node ? strOf(node) : null; if (!node || text === null) return { columns: '*', embeds: [] }; const strNode = unwrap(node);
    const parse = (str, offset) => { const cols = []; const embeds = []; let depth = 0; let cur = ''; let start = 0;
      const flush = (item, at) => { const t0 = item.trim(); if (!t0) return; const lead = item.search(/\S/);
        const paren = t0.indexOf('(');
        if (paren > 0 && t0.endsWith(')')) { const head = t0.slice(0, paren).split(':').pop().split('!')[0].trim(); const inner = t0.slice(paren + 1, -1); const sub = parse(inner, offset + at + lead + paren + 1); embeds.push({ name: head, columns: sub.columns, line: lineIn(sf, strNode, offset + at + lead) }, ...sub.embeds); return; }
        if (t0 === '*' || t0.endsWith('.*')) { cols.push('*'); return; }
        const name = t0.split('::')[0].split(':').pop().split(/->|\s/)[0].replace(/"/g, '').trim();
        if (/^[A-Za-z_]\w*$/.test(name)) cols.push({ name, line: lineIn(sf, strNode, offset + at + item.indexOf(name)) }); };
      for (let i = 0; i < str.length; i++) { const ch = str[i]; if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { flush(cur, start); cur = ''; start = i + 1; } else cur += ch; }
      flush(cur, start); return { columns: cols.includes('*') || !cols.length ? '*' : cols, embeds }; };
    return parse(text, 0); };
  const chainMethods = (call) => { const out = []; let cur = call; while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur && cur.parent.parent && ts.isCallExpression(cur.parent.parent) && cur.parent.parent.expression === cur.parent) { out.push(cur.parent.name.text); cur = cur.parent.parent; } return out; };
  const enclosingCall = (n) => { let p = n.parent; while (p && !ts.isCallExpression(p) && (ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isBinaryExpression(p) || ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isAsExpression(p))) p = p.parent; return p && ts.isCallExpression(p) ? p : null; };
  const requestMethod = (call) => { if (!call) return 'GET'; const name = calleeName(call); if (name && /^(post|put|patch|delete|del)$/i.test(name)) return name.toUpperCase(); if (name && /^(get|head)$/i.test(name)) return 'GET';
    const opts = call.arguments[1]; if (opts && ts.isObjectLiteralExpression(opts)) for (const pr of opts.properties) if (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) && pr.name.text === 'method') { const m = strOf(pr.initializer); return m ? m.toUpperCase() : 'GET'; } return 'GET'; };
  /** String, template or concatenation → path: ${…} becomes :p, a leading base (${API_BASE}, http://host, API + '/x') is dropped */
  const pathOf = (n) => { n = unwrap(n); if (!n) return null; let parts = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts = [{ lit: n.text }];
    else if (ts.isTemplateExpression(n)) parts = [{ lit: n.head.text }, ...n.templateSpans.flatMap((s) => [{ expr: true }, { lit: s.literal.text }])];
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { const flat = []; (function walk(b) { if (ts.isBinaryExpression(b) && b.operatorToken.kind === ts.SyntaxKind.PlusToken) { walk(b.left); walk(b.right); } else { const s = strOf(b); flat.push(s !== null ? { lit: s } : { expr: true }); } })(n); parts = flat; }
    if (!parts) return null;
    let s = ''; let first = true;
    for (const p of parts) { if (p.expr) { s += first && s === '' ? '' : ':p'; } else s += p.lit; if (p.lit !== '' || p.expr) first = false; }
    s = s.replace(/^https?:\/\/[^/]*/, '').replace(/[?#].*$/, '').replace(/([^/]):p/g, '$1');   // `/guests${qs}` → /guests; `/users/${id}` stays /users/:p
    if (!s.startsWith('/') || !/\/[A-Za-z]/.test(s) || /\.(js|mjs|css|png|jpe?g|svg|gif|ico|woff2?|ttf|json|map|webp|html|txt)$/i.test(s) || s.startsWith('/@') || s.startsWith('//')) return null;
    return pattern(s); };
  const hasBase = (n) => { n = unwrap(n); if (ts.isTemplateExpression(n)) return n.head.text === '' || /^https?:\/\//.test(n.head.text); if (ts.isBinaryExpression(n)) { let l = n; while (ts.isBinaryExpression(l)) l = l.left; return strOf(l) === null || /^https?:\/\//.test(strOf(l)); } return /^https?:\/\//.test(strOf(n) ?? ''); };
  /** Data accesses in a subtree: { table|view|fn|edge|route, kind read|write, line, via, symbol } */
  const collect = (sf, root, out) => {
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n); const rec = receiver(n);
        if ((name === 'from' || name === 'table') && n.arguments.length && !(rec && ts.isPropertyAccessExpression(rec) && rec.name.text === 'storage') && !(rec && ts.isIdentifier(rec) && /^[A-Z]/.test(rec.text))) {
          const s = strOf(n.arguments[0]); if (s) { const methods = chainMethods(n); const write = methods.find((m) => WRITE_METHODS.has(m));
            const sel = write ? null : selectColumns(sf, chainCall(n, 'select')?.arguments[0] ?? null);
            out.push({ name: s, what: 'table_or_view', kind: write ? 'write' : 'read', line: lineOf(sf, n.arguments[0]), via: write ? `${name}(…).${write}(…)` : name === 'from' ? 'from' : 'table', symbol: s, file: sf.fileName, ...(sel ? { columns: sel.columns } : {}) });
            for (const e of sel?.embeds ?? []) out.push({ name: e.name, what: 'table_or_view', kind: 'read', line: e.line, via: `from(${s}) embedded`, symbol: e.name, file: sf.fileName, columns: e.columns }); }
        }
        if (name === 'rpc' && n.arguments.length) { const s = strOf(n.arguments[0]); if (s) out.push({ name: s, what: 'fn', kind: 'read', line: lineOf(sf, n.arguments[0]), via: `rpc ${s}`, symbol: s }); }
        if (name === 'invoke' && rec && ts.isPropertyAccessExpression(rec) && rec.name.text === 'functions' && n.arguments.length) { const s = strOf(n.arguments[0]); if (s) out.push({ name: s, what: 'edge', kind: 'read', line: lineOf(sf, n.arguments[0]), via: `function ${s}`, symbol: s }); }
        if (name === 'on' && n.arguments.length >= 2 && strOf(n.arguments[0]) === 'postgres_changes' && ts.isObjectLiteralExpression(unwrap(n.arguments[1]))) for (const pr of unwrap(n.arguments[1]).properties) if (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) && pr.name.text === 'table') { const s = strOf(pr.initializer); if (s) out.push({ name: s, what: 'table_or_view', kind: 'read', line: lineOf(sf, pr.initializer), via: 'realtime postgres_changes', symbol: s }); }
        if ((name === 'collection' && n.arguments.length) || (name === 'doc' && n.arguments.length >= 2 && strOf(n.arguments[1]) && !(rec && ts.isCallExpression(rec)))) { const s = name === 'doc' ? strOf(n.arguments[1]) : strOf(n.arguments[n.arguments.length - 1]); if (s) { let p = n.parent; let kind = 'read'; let via = name;
            for (let i = 0; i < 3 && p; i++, p = p.parent) if (ts.isCallExpression(p)) { const cn = calleeName(p); if (cn && FIRESTORE_WRITE.has(cn)) { kind = 'write'; via = `${name}(…) in ${cn}(…)`; break; } if (cn && FIRESTORE_READ.has(cn) && cn !== 'doc') break; }
            out.push({ name: s, what: 'table_or_view', kind, line: lineOf(sf, name === 'doc' ? n.arguments[1] : n.arguments[n.arguments.length - 1]), via, symbol: s }); } }
        if (name && rec && ts.isPropertyAccessExpression(rec) && ts.isIdentifier(rec.expression) && /^(prisma|db|client|orm)$/.test(rec.expression.text) && (ORM_READ.test(name) || ORM_WRITE.test(name))) { const t = rec.name.text; out.push({ name: t, what: 'table_or_view', kind: ORM_WRITE.test(name) ? 'write' : 'read', line: lineOf(sf, rec.name), via: ORM_WRITE.test(name) ? `${rec.expression.text}.${t}.${name}(…)` : `${rec.expression.text}.${t}.${name}(…)`, symbol: t }); }
        const pathArg = name && NAVIGATION.test(name) || ts.isNewExpression(n.parent) ? null : n.arguments.find((a) => pathOf(a) !== null);
        if (pathArg) { const p = pathOf(pathArg); const m = requestMethod(n); if (p) out.push({ name: p, what: 'route', kind: m === 'GET' ? 'read' : 'write', line: lineOf(sf, pathArg), via: `${m} ${p}`, symbol: p, method: m, base: hasBase(pathArg) }); }
      }
      // a string outside a call counts only with a base (`${API_BASE}/x`, `http://host/x`): a path without a base is usually a page, not a request
      if ((ts.isTemplateExpression(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)) && !(n.parent && (ts.isCallExpression(n.parent) && n.parent.arguments.includes(n) || ts.isImportDeclaration(n.parent) || ts.isJsxAttribute(n.parent) || ts.isBinaryExpression(n.parent) || ts.isTemplateSpan(n.parent)))) {
        const p = pathOf(n); if (p && hasBase(n)) out.push({ name: p, what: 'route', kind: 'read', line: lineOf(sf, n), via: `GET ${p}`, symbol: p, method: 'GET', loose: true, base: true }); }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        const sqlCols = sqlColumns(n.text, (idx) => lineIn(sf, n, idx));
        for (const t of sqlIn(n.text)) out.push({ name: t.name, what: 'table_or_view', kind: 'read', line: lineIn(sf, n, t.at), via: 'sql', symbol: t.name, sql: true, file: sf.fileName, columns: sqlCols[t.name] ?? '*' });
        for (const w of sqlWrites(n.text)) out.push({ name: w.table, what: 'table_or_view', kind: 'write', line: lineIn(sf, n, w.at), via: `sql ${w.kind}`, symbol: w.table, sql: true });
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
  };
  /** UPDATE x SET a = …, b = … → columns with position */
  const sqlUpdates = (s) => [...s.matchAll(/\bupdate\s+(?:"?[A-Za-z_]\w*"?\.)?"?([A-Za-z_]\w*)"?\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|\bfrom\b|;|$)/gi)].map((m) => { const base = m.index + m[0].indexOf(m[2]); const cols = []; for (const c of m[2].matchAll(/(?:^|,)\s*"?([A-Za-z_]\w*)"?\s*=/g)) cols.push({ name: c[1], at: base + c.index + c[0].indexOf(c[1]) }); return { table: m[1], columns: cols }; });
  const sqlWrites = (s) => [...s.matchAll(/\b(insert\s+into|update|delete\s+from)\s+(?:"?[A-Za-z_]\w*"?\.)?"?([A-Za-z_]\w*)"?/gi)].filter((m) => !SQL_NOISE.has(m[2].toLowerCase()) && !/^(set|the|a|an|your)$/i.test(m[2])).map((m) => ({ kind: m[1].split(/\s+/)[0].toLowerCase(), table: m[2], at: m.index }));
  const sqlIn = (s) => { if (s.length < 12 || !/^\s*(select|with)\b|\bselect\b[\s\S]+\bfrom\b|\n\s*(from|join)\b/i.test(s)) return []; const out = [];
    for (const m of s.matchAll(SQL_READ)) { const before = s.slice(Math.max(0, m.index - 12), m.index).toLowerCase().trimEnd(); const after = s.slice(m.index + m[0].length); if (m[1].toLowerCase() === 'from' && before.endsWith('delete')) continue;
      if (!/^\s*(;|$|\n|where\b|join\b|on\b|order\b|group\b|limit\b|as\b|left\b|right\b|inner\b|cross\b|using\b|,|\)|[A-Za-z_]\w*\s*(where|join|on|order|left|right|inner|group|limit|;|$|\n))/i.test(after)) continue;   // after the name, SQL must continue, not a sentence
      if (!SQL_NOISE.has(m[2].toLowerCase()) && !out.some((x) => x.name === m[2])) out.push({ name: m[2], at: m.index }); } return out; };

  // ── Function resolution in TS/JS: calls inside a handler into the same file and through imports ──
  // Aliases from tsconfig.json (compilerOptions.paths, e.g. "@/*": ["./src/*"]); without an entry @/ means src/ or the root next to the tsconfig
  const fsx = { repo, files, read, isFile: (p) => existsSync(p) && statSync(p).isFile() };
  const resolveModule = moduleResolver(fsx);   // aliases from tsconfig.json (paths, baseUrl), @/ and ~/
  const importsOf = (sf, file) => { const m = new Map(); for (const st of sf.statements) { if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) { const f = resolveModule(file, st.moduleSpecifier.text); if (!f) continue; const cl = st.importClause; if (!cl) continue; if (cl.name) m.set(cl.name.text, { file: f, name: 'default' }); if (cl.namedBindings) { if (ts.isNamespaceImport(cl.namedBindings)) m.set(cl.namedBindings.name.text, { file: f, ns: true }); else for (const el of cl.namedBindings.elements) m.set(el.name.text, { file: f, name: (el.propertyName ?? el.name).text }); } } } return m; };
  const fnDecls = (sf) => { const m = new Map(); const add = (name, node) => { if (name && !m.has(name)) m.set(name, node); };
    const visit = (n) => { if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n); if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(unwrap(d.initializer)) || ts.isFunctionExpression(unwrap(d.initializer)) || ts.isCallExpression(unwrap(d.initializer)))) add(d.name.text, unwrap(d.initializer)); if (ts.isExportAssignment(n)) add('default', n.expression); ts.forEachChild(n, visit); }; visit(sf); return m; };
  const declCache = new Map(); const declsOf = (file) => { if (!declCache.has(file)) declCache.set(file, fnDecls(parse(file))); return declCache.get(file); };
  const importCache = new Map(); const impOf = (file) => { if (!importCache.has(file)) importCache.set(file, importsOf(parse(file), file)); return importCache.get(file); };
  /** Data accesses of a function node including the called functions (depth ≤ 4) */
  const accessOfFn = (file, node, depth = 0, seen = new Set()) => { const out = []; const sf = parse(file); collect(sf, node, out);
    if (depth >= 4) return out; const decls = declsOf(file); const imps = impOf(file);
    const visit = (n) => { if (ts.isCallExpression(n)) { let target = null; const ex = n.expression;
        if (ts.isIdentifier(ex)) { if (decls.has(ex.text)) target = { file, name: ex.text }; else if (imps.get(ex.text) && !imps.get(ex.text).ns) target = { file: imps.get(ex.text).file, name: imps.get(ex.text).name }; }
        else if (ts.isPropertyAccessExpression(ex) && ts.isIdentifier(ex.expression) && imps.get(ex.expression.text)?.ns) target = { file: imps.get(ex.expression.text).file, name: ex.name.text };
        if (target) { const key = `${target.file}#${target.name}`; if (!seen.has(key)) { seen.add(key); const d = declsOf(target.file).get(target.name); if (d) out.push(...accessOfFn(target.file, d, depth + 1, seen)); } } }
      ts.forEachChild(n, visit); }; visit(node); return out; };

  // ── Backend routes (JS/TS): X.get('/path', handler…) with the prefix from app.use('/p', router) and Next.js route.ts ──
  const routes = [];   // { pattern, method, file, line, access[] }
  const usePrefix = new Map();   // file → prefix (through app.use('/p', importedRouter))
  for (const p of backendJs) { const sf = parse(p); const imps = impOf(p);
    const visit = (n) => { if (ts.isCallExpression(n) && calleeName(n) === 'use' && n.arguments.length >= 2) { const pre = strOf(n.arguments[0]); const target = unwrap(n.arguments[1]); if (pre && pre.startsWith('/') && ts.isIdentifier(target) && imps.get(target.text)) usePrefix.set(imps.get(target.text).file, joinPath(usePrefix.get(p) ?? '', pre)); } ts.forEachChild(n, visit); }; visit(sf); }
  for (const p of backendJs) { const sf = parse(p); const r = rel(p);
    if (/\/route\.[tj]s$/.test(r) && r.split('/').includes('api')) { const parts = r.split('/'); const i = parts.indexOf('api'); const pat = pattern('/' + parts.slice(i, -1).join('/')); const decls = declsOf(p); const get = decls.get('GET'); routes.push({ pattern: pat, method: 'GET', file: r, line: 1, access: get ? accessOfFn(p, get) : (() => { const o = []; collect(sf, sf, o); return o; })() }); continue; }
    const visit = (n) => { if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(get|post|put|patch|delete|all)$/.test(n.expression.name.text) && n.arguments.length >= 2 && ts.isIdentifier(n.expression.expression) && /^(app|router|server|fastify|api|r|hono|routes)$/.test(n.expression.expression.text)) {
        const path = strOf(n.arguments[0]); if (path && path.startsWith('/')) { const method = n.expression.name.text.toUpperCase(); const access = []; const decls = declsOf(p); const imps = impOf(p);
          for (const a of n.arguments.slice(1)) { const u = unwrap(a); if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) access.push(...accessOfFn(p, u)); else if (ts.isIdentifier(u)) { const d = decls.get(u.text); if (d) access.push(...accessOfFn(p, d)); else if (imps.get(u.text) && !imps.get(u.text).ns) { const dd = declsOf(imps.get(u.text).file).get(imps.get(u.text).name); if (dd) access.push(...accessOfFn(imps.get(u.text).file, dd)); } } else if (ts.isObjectLiteralExpression(u)) for (const pr of u.properties) if (ts.isPropertyAssignment(pr) && pr.initializer && (ts.isArrowFunction(unwrap(pr.initializer)) || ts.isFunctionExpression(unwrap(pr.initializer)))) access.push(...accessOfFn(p, unwrap(pr.initializer))); }
          routes.push({ pattern: pattern(joinPath(usePrefix.get(p) ?? '', path)), method, file: r, line: lineOf(sf, n), access }); } }
      ts.forEachChild(n, visit); }; visit(sf); }

  // ── Backend routes (Python): facts from scaffold-ast.py, prefixes through APIRouter(prefix) and include_router(prefix) along the imports ──
  let py = {};
  if (pyFiles.length) { try { py = JSON.parse(execFileSync('python3', ['-I', new URL('./scaffold-ast.py', import.meta.url).pathname, repo, '-'], { input: pyFiles.join('\n'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })); } catch (e) { throw new Error(`python3 with the ast module is required for ${pyFiles.length} Python files: ${String(e.message ?? e).split('\n')[0]}`); } }
  const pyRel = Object.keys(py); const pyFile = (r) => py[r];
  const pyModuleFile = (fromRel, mod) => {   // 'app.routers.persons' / '.services' → file (relative to an ancestor of the importing file)
    let base = fromRel.split('/').slice(0, -1); if (mod.startsWith('.')) { const up = mod.match(/^\.+/)[0].length - 1; base = base.slice(0, base.length - up); mod = mod.slice(up + 1); }
    const parts = mod.split('.').filter(Boolean); const roots = mod.startsWith('.') || !mod ? [base] : [[], ...fromRel.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1))];
    for (const root of roots.reverse()) for (const cand of [[...root, ...parts].join('/') + '.py', [...root, ...parts, '__init__'].join('/') + '.py']) if (pyRel.includes(cand)) return cand; return null; };
  const pyResolve = (fromRel, dottedName) => {   // 'persons.router' | 'dashboard_router' | 'svc.list_events' | 'list_events' → { file, name }
    const [head, ...rest] = dottedName.split('.'); const imp = pyFile(fromRel)?.imports?.[head]; if (!imp) return pyFile(fromRel)?.functions?.[head] || pyFile(fromRel)?.routers?.[head] ? { file: fromRel, name: head } : null;
    if (imp.includes(':')) { const [mod, name] = imp.split(':'); const sub = pyModuleFile(fromRel, (mod.endsWith('.') ? mod : mod + '.') + name);   // from pkg import module
      if (sub) return { file: sub, name: rest.join('.') || null }; const f = pyModuleFile(fromRel, mod); return f ? { file: f, name: [name, ...rest].join('.') } : null; }   // from module import name
    const f = pyModuleFile(fromRel, imp); return f ? { file: f, name: rest.join('.') || null } : null; };
  const includePrefix = new Map();   // `file#router` → prefix from include_router (recursive)
  for (let round = 0; round < 3; round++) for (const r of pyRel) for (const inc of pyFile(r).includes ?? []) { const t = inc.arg && pyResolve(r, inc.arg); if (!t || !t.name) continue; const parent = inc.receiver && pyFile(r).routers?.[inc.receiver]; const own = parent ? joinPath(includePrefix.get(`${r}#${inc.receiver}`) ?? '', parent.prefix) : ''; includePrefix.set(`${t.file}#${t.name}`, joinPath(own, inc.prefix)); }
  const modelTable = new Map(); for (const r of pyRel) for (const [cls, t] of Object.entries(pyFile(r).models ?? {})) modelTable.set(cls, t);
  const pyAccessOfFn = (fileRel, fnName, depth = 0, seen = new Set()) => { const f = pyFile(fileRel)?.functions?.[fnName]; if (!f) return []; const out = [];
    for (const t of f.tables) out.push({ name: t.name, what: 'table_or_view', kind: t.kind ?? 'read', line: t.line, via: t.via ?? 'table', symbol: t.name, file: fileRel, columns: t.columns ?? '*' });
    for (const t of f.rpcs) out.push({ name: t.name, what: 'fn', kind: 'read', line: t.line, via: `rpc ${t.name}`, symbol: t.name, file: fileRel });
    for (const t of f.sql) out.push({ name: t.name, what: 'table_or_view', kind: 'read', line: t.line, via: 'sql', symbol: t.name, file: fileRel, columns: t.columns ?? '*' });
    for (const m of f.models) { const t = modelTable.get(m.name.split('.').pop()); if (t) out.push({ name: t, what: 'table_or_view', kind: 'read', line: m.line, via: `model ${m.name}`, symbol: m.name.split('.').pop(), file: fileRel }); }
    for (const nm of f.names) { const c = pyFile(fileRel)?.consts?.[nm]; if (c) for (const t of c) out.push({ name: t, what: 'table_or_view', kind: 'read', line: f.line, via: `sql ${nm}`, symbol: nm, file: fileRel }); }
    if (depth >= 4) return out;
    for (const call of f.calls) { const t = pyResolve(fileRel, call); if (!t || !t.name) continue; const key = `${t.file}#${t.name}`; if (seen.has(key)) continue; seen.add(key); out.push(...pyAccessOfFn(t.file, t.name, depth + 1, seen)); }
    return out; };
  for (const r of pyRel) for (const rt of pyFile(r).routes ?? []) { const router = rt.receiver && pyFile(r).routers?.[rt.receiver]; const pre = joinPath(includePrefix.get(`${r}#${rt.receiver}`) ?? '', router?.prefix ?? ''); routes.push({ pattern: pattern(joinPath(pre, rt.path)), method: rt.method, file: r, line: rt.line, access: pyAccessOfFn(r, rt.handler) }); }

  // ── Access → tables of the app map (view, function, Edge Function, route) ──
  const edgeCache = new Map();
  const edgeTables = (name) => { if (edgeCache.has(name)) return edgeCache.get(name); edgeCache.set(name, []); const dir = files.find((p) => /\/functions\/[^/]+\/index\.[tj]s$/.test(p) && p.split('/').at(-2) === name); if (!dir) return [];
    const acc = accessOfFn(dir, parse(dir)); const t = uniq(acc.filter((a) => a.kind === 'read' && a.what !== 'route').flatMap((a) => tablesOf(a).map((x) => x.table))); edgeCache.set(name, t); return t; };
  // per read also the columns read (cols: [{ name, line, file }] with the place where the column is named, or '*' = all)
  const colsOf = (a) => (!a.columns || a.columns === '*' ? '*' : a.columns.map((c) => ({ ...c, file: a.file })));
  const mergeCols = (x, y) => (x === '*' || y === '*' ? '*' : [...x, ...y.filter((c) => !x.some((d) => d.name === c.name))]);
  const tablesOf = (a) => {   // → [{ table, via, cols }]
    if (a.what === 'table_or_view') { const k = tableKey(a.name); if (k) return [{ table: k, via: a.via, cols: colsOf(a) }]; return viewTables(a.name).map((t) => ({ table: t, via: `view ${a.name}`, cols: '*' })); }
    if (a.what === 'fn') return fnTables(a.name).map((t) => ({ table: t, via: a.via, cols: '*' }));
    if (a.what === 'edge') return edgeTables(a.name).map((t) => ({ table: t, via: a.via, cols: '*' }));
    if (a.what === 'route') { const rt = matchRoute(a.name, a.base); if (!rt) return []; const by = new Map();   // a path in the handler is not a database read
      for (const x of rt.access.filter((x) => x.kind === 'read' && x.what !== 'route')) for (const y of tablesOf(x)) by.set(y.table, by.has(y.table) ? mergeCols(by.get(y.table), y.cols) : y.cols);
      return [...by].map(([t, cols]) => ({ table: t, via: `route ${rt.pattern}`, symbol: rt.pattern, cols })); }
    return []; };
  const segs = (p) => p.split('/').filter(Boolean);
  const matchRoute = (clientPath, base = false) => { const cs = segs(clientPath); let best = null;
    for (const rt of routes) { const pat = rt.pattern; const rs = segs(pat); if (!rs.length) continue;
      // aligned at the end: a proxy prefix in the client (/api/v1) does not matter; with a base variable (API_BASE = …/api) the route may also be longer
      if (rs.length > cs.length && !base) continue; const offC = Math.max(0, cs.length - rs.length); const offR = Math.max(0, rs.length - cs.length); const len = Math.min(rs.length, cs.length);
      let ok = true; let score = 0; let literal = 0;
      for (let i = 0; i < len && ok; i++) { const r = rs[offR + i]; const c = cs[offC + i]; if (r === '*') { score += 1; break; } if (r.startsWith(':')) { score += 1; continue; } if (c === r) { score += 3; literal++; continue; } ok = false; }
      if (ok && (offC + offR === 0 || literal > 0) && (!best || score > best.score || (score === best.score && offR < best.offR))) best = { rt, score, offR }; }   // a route made only of parameters (/:id) does not match any arbitrary end
    return best?.rt ?? null; };

  // ── Reachability: a frontend file counts only if an entry point of the app reaches it through imports (index.html → <script src>,
  //    route files of a framework, package.json main …). Without an entry point the rule decides nothing. everydeck-check checks the same rule.
  const reach = reachability(ts, fsx, frontend); const reachable = reach.reachable;
  // ── Pages: the file behind each route (React Router <Route path element={<C/>}>, a route object { path, element | Component | lazy }, also
  //    lazy(() => import('…'))), and the static imports of every frontend file an entry reaches (for the description of each page)
  const page_files = []; const import_graph = {};
  const dynImport = (x) => { let out = null; const v = (y) => { if (!out && ts.isCallExpression(y) && y.expression.kind === ts.SyntaxKind.ImportKeyword && y.arguments[0] && ts.isStringLiteralLike(y.arguments[0])) out = y.arguments[0].text; ts.forEachChild(y, v); }; v(x); return out; };
  for (const p of frontend) { if (!reachable.has(p)) continue; const sf = parse(p); const imps = importsOf(sf, p);
    import_graph[rel(p)] = [...new Set([...imps.values()].map((x) => rel(x.file)))];
    const lazyOf = new Map();
    const visitL = (n) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) { const c = unwrap(n.initializer); if (ts.isCallExpression(c) && /^(lazy|loadable|dynamic|lazyWithRetry|lazyRetry)$/.test(calleeName(c) ?? '') && c.arguments[0]) { const spec = dynImport(c.arguments[0]); const f = spec ? resolveModule(p, spec) : null; if (f) lazyOf.set(n.name.text, f); } } ts.forEachChild(n, visitL); }; visitL(sf);
    // a component defined in the routes file itself (function PropertyRoute() { … return <PropertyPage /> }): the first imported page it renders
    const localDecl = new Map();
    for (const st of sf.statements) { if (ts.isFunctionDeclaration(st) && st.name) localDecl.set(st.name.text, st); if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(unwrap(d.initializer)) || ts.isFunctionExpression(unwrap(d.initializer)))) localDecl.set(d.name.text, d.initializer); }
    const firstImported = (node) => { let out = null; const v = (x) => { if (out) return; if (ts.isJsxSelfClosingElement(x) || ts.isJsxOpeningElement(x)) { const tag = x.tagName.getText(sf); const f = /^[A-Z]/.test(tag) ? lazyOf.get(tag) ?? imps.get(tag)?.file : null; if (f) { out = f; return; } } ts.forEachChild(x, v); }; v(node); return out; };
    const fileOf = (name) => (name ? lazyOf.get(name) ?? imps.get(name)?.file ?? (localDecl.has(name) ? firstImported(localDecl.get(name)) : null) : null);
    const compOf = (x) => { x = x && unwrap(x); if (!x) return null; if (ts.isConditionalExpression(x)) return compOf(x.whenTrue); if (ts.isJsxSelfClosingElement(x)) return x.tagName.getText(sf); if (ts.isJsxElement(x)) return x.openingElement.tagName.getText(sf); if (ts.isIdentifier(x)) return x.text; return null; };
    const visit = (n) => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === 'Route') {
        let path = null, comp = null;
        for (const a of n.attributes.properties) { if (!ts.isJsxAttribute(a) || !a.initializer) continue; const nm = a.name.getText(sf); const init = ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
          if (nm === 'path' && init && ts.isStringLiteralLike(init)) path = init.text; if ((nm === 'element' || nm === 'component' || nm === 'Component') && init) comp = compOf(init); }
        const f = fileOf(comp); if (path && f) page_files.push({ path: rel(p), line: lineOf(sf, n), pattern: path, file: rel(f) });
      }
      if (ts.isObjectLiteralExpression(n)) {
        let path = null, comp = null, lazySpec = null;
        for (const pr of n.properties) { if (!ts.isPropertyAssignment(pr) || !pr.name) continue; const nm = pr.name.getText(sf);
          if (nm === 'path' && ts.isStringLiteralLike(pr.initializer)) path = pr.initializer.text; if (nm === 'element' || nm === 'component' || nm === 'Component') comp = compOf(pr.initializer); if (nm === 'lazy') lazySpec = dynImport(pr.initializer); }
        const f = fileOf(comp) ?? (lazySpec ? resolveModule(p, lazySpec) : null); if (path && path.startsWith('/') && f) page_files.push({ path: rel(p), line: lineOf(sf, n), pattern: path, file: rel(f) });
      }
      ts.forEachChild(n, visit); };
    visit(sf); }
  // ── Frontend: display places (reads) and mentions (for not_shown) ──
  const shown = []; const mentions = [];   // mentions: { table, path, line, reason }
  const colReads = [];   // { table, cols, path, line, via } per frontend read
  const props = new Map();   // property names the frontend accesses (x.name, x?.name, x['name'], { name } = x) → file → first place in it
  const rendering = new Set();   // frontend files that render (JSX)
  const nameRes = [...tables.keys()].map((t) => [t, new RegExp(`(^|[^A-Za-z0-9_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`)]);
  // Writes of the browser (flow candidates): a write to a table (insert/update/upsert/delete, Firestore, ORM, SQL) or a request with POST/PUT/PATCH/DELETE to a
  // route of the app's own backend (with the handler's place), in files an entry of the app reaches
  const browser_writes = [];
  const writeKind = (via) => { const m = /\.(insert|update|upsert|delete)\(|\bin (addDoc|setDoc|updateDoc|deleteDoc)\(|\.(create\w*|update\w*|delete\w*|upsert)\(…\)$|^sql (insert|update|delete)/.exec(via ?? ''); if (!m) return null;
    if (m[1]) return m[1]; if (m[2]) return { addDoc: 'insert', setDoc: 'upsert', updateDoc: 'update', deleteDoc: 'delete' }[m[2]]; if (m[3]) return /^create/.test(m[3]) ? 'insert' : /^update/.test(m[3]) ? 'update' : /^delete/.test(m[3]) ? 'delete' : 'upsert'; return m[4]; };
  for (const p of frontend) { const sf = parse(p); const r = rel(p); const acc = []; collect(sf, sf, acc);
    if (reachable.has(p)) for (const a of acc) { if (a.kind !== 'write') continue;
      if (a.what === 'table_or_view') { const t = tableKey(a.name); const k = writeKind(a.via); if (t && k) browser_writes.push({ table: t, kind: k, path: r, line: a.line, symbol: a.name }); }
      else if (a.what === 'route' && a.method && a.method !== 'GET') { const rt = matchRoute(a.name, a.base); if (rt) browser_writes.push({ kind: 'request', route: `${a.method} ${rt.pattern}`, handler: { path: rt.file, line: rt.line }, path: r, line: a.line, symbol: a.name }); } }
    const seenRead = new Set(); const unreachable = !reachable.has(p);
    if (!unreachable) for (const a of acc) {
      if (a.what === 'route' && a.loose && acc.some((b) => !b.loose && b.what === 'route' && b.line === a.line && b.name === a.name)) continue;
      if (a.kind !== 'read') continue;
      for (const h of tablesOf(a)) { colReads.push({ table: h.table, cols: h.cols, path: r, line: a.line, via: h.via }); const key = `${h.table}|${r}|${a.line}`; if (seenRead.has(key)) continue; seenRead.add(key); shown.push({ table: h.table, path: r, line: a.line, via: h.via, symbol: a.what === 'route' ? h.symbol : a.symbol }); }
    }
    if (!unreachable) { const note = (name, node) => { if (!props.has(name)) props.set(name, new Map()); const at = props.get(name); if (!at.has(r)) at.set(r, { path: r, line: lineOf(sf, node) }); };
      const pv = (n) => { if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) rendering.add(r);
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) note(n.name.text, n.name);
        else if (ts.isElementAccessExpression(n) && n.argumentExpression && strOf(n.argumentExpression)) note(strOf(n.argumentExpression), n.argumentExpression);
        // { name } = x counts, a destructured parameter does not: jwt({ token, user }) or ({ title }) => … takes a caller's arguments, not a row read
        else if (ts.isBindingElement(n) && n.parent && ts.isObjectBindingPattern(n.parent) && !(n.parent.parent && ts.isParameter(n.parent.parent))) { const k = n.propertyName ?? n.name; if (ts.isIdentifier(k) || ts.isStringLiteral(k)) note(k.text, k); }
        ts.forEachChild(n, pv); }; pv(sf); }
    // Mentions in text: every string that contains a table name as a word, with the reason from the context (the cross-check in everydeck-check finds the same places)
    const writesAt = (t, line) => acc.find((a) => a.kind === 'write' && a.what === 'table_or_view' && Math.abs(a.line - line) <= 1 && tableKey(a.name) === t);
    const writeRequestAt = (line) => acc.find((a) => a.kind === 'write' && a.what === 'route' && Math.abs(a.line - line) <= 1);
    const visit = (n) => { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) { for (const [t, re] of nameRes) { const m0 = re.exec(n.text); if (!m0 || !codeMention(n.text, t)) continue;   /* code only, no prose */ const line = lineIn(sf, n, m0.index + m0[1].length); if (mentions.some((m) => m.table === t && m.path === r && Math.abs(m.line - line) <= 3)) continue;
          const w = writesAt(t, line); const wr = writeRequestAt(line);
          const fact = unreachable ? 'module no screen or component imports (not reachable from the frontend), the code runs outside the frontend' : w ? `written here (${w.via}), not read` : wr ? `${wr.method} ${wr.name}: path of a write request, not a read` : n.parent && ts.isImportDeclaration(n.parent) ? 'import path, no data access' : 'string without data access (label, key or path), not read';
          mentions.push({ table: t, path: r, line, fact }); } } ts.forEachChild(n, visit); }; visit(sf);
  }
  const shownTables = new Set(shown.map((s) => s.table));
  // ── Write places: where the app changes a column after creation (fact with a place). TS/JS: supabase .update/.upsert({…}) (also through a
  //    variable holding an object), Firestore updateDoc(doc(db, 'x', id), {…}), Prisma x.update({ data: {…} }), SQL UPDATE x SET a = …; Python from scaffold-ast.py.
  //    Also provider IDs (Python): columns whose value comes from a provider call or is passed to a provider.
  const column_writes = []; const provider_columns = []; const column_inserts = [];
  const keysOf = (sf, obj) => (obj && ts.isObjectLiteralExpression(obj) ? obj.properties.filter((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))).map((p) => ({ name: p.name.text, line: lineOf(sf, p.name) })) : []);
  const varObject = (sf, name) => { let found = null; const v = (n) => { if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isObjectLiteralExpression(unwrap(n.initializer))) found = unwrap(n.initializer); ts.forEachChild(n, v); }; v(sf); return found; };
  for (const p of [...new Set([...frontend, ...backendJs])]) { const sf = parse(p); const r = rel(p);
    const visit = (n) => {
      if (ts.isCallExpression(n)) { const name = calleeName(n);
        if ((name === 'from' || name === 'table') && n.arguments.length) { const t = tableKey(strOf(n.arguments[0]) ?? ''); const up = chainCall(n, 'update') ?? chainCall(n, 'upsert');
          if (t && up && up.arguments[0]) { const a = unwrap(up.arguments[0]); const obj = ts.isIdentifier(a) ? varObject(sf, a.text) : a; for (const k of keysOf(sf, obj)) column_writes.push({ table: t, column: k.name, path: r, line: k.line, via: `${name}(…).${calleeName(up)}(…)` }); } }
        if (name === 'updateDoc' && n.arguments.length >= 2) { const d = unwrap(n.arguments[0]); const t = d && ts.isCallExpression(d) && calleeName(d) === 'doc' && d.arguments.length >= 2 ? tableKey(strOf(d.arguments[1]) ?? '') : null; if (t) for (const k of keysOf(sf, unwrap(n.arguments[1]))) column_writes.push({ table: t, column: k.name, path: r, line: k.line, via: 'updateDoc' }); }
        const rec = receiver(n);
        if (name && /^(update|updateMany|upsert)$/.test(name) && rec && ts.isPropertyAccessExpression(rec) && ts.isIdentifier(rec.expression) && /^(prisma|db|client|orm|tx)$/.test(rec.expression.text) && n.arguments[0] && ts.isObjectLiteralExpression(unwrap(n.arguments[0]))) {
          const t = tableKey(rec.name.text); const dataProp = unwrap(n.arguments[0]).properties.find((pp) => ts.isPropertyAssignment(pp) && ts.isIdentifier(pp.name) && (pp.name.text === 'data' || pp.name.text === 'update'));
          if (t && dataProp) for (const k of keysOf(sf, unwrap(dataProp.initializer))) column_writes.push({ table: t, column: k.name, path: r, line: k.line, via: `${rec.expression.text}.${rec.name.text}.${name}(…)` }); }
      }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) for (const u of sqlUpdates(n.text)) { const t = tableKey(u.table); if (t) for (const c of u.columns) column_writes.push({ table: t, column: c.name, path: r, line: lineIn(sf, n, c.at), via: 'sql update' }); }
      ts.forEachChild(n, visit); };
    visit(sf); }
  for (const r of pyRel) for (const fn of Object.values(pyFile(r).functions ?? {})) {
    for (const w of fn.writes ?? []) { const t = tableKey(w.table); if (!t) continue; if (w.op === 'insert') column_inserts.push({ table: t, column: w.column, path: r, line: w.line }); if (w.op !== 'insert') column_writes.push({ table: t, column: w.column, path: r, line: w.line, via: `table(…).${w.op}(…)`, ...(w.self ? { self: true } : {}) }); if (w.provider) provider_columns.push({ table: t, column: w.column, provider: w.provider, path: r, line: w.line, how: 'result' }); }
    const readT = uniq((fn.tables ?? []).map((x) => tableKey(x.name)).filter(Boolean));
    for (const ps of fn.passes ?? []) provider_columns.push({ tables: readT, column: ps.column, provider: ps.provider, path: r, line: ps.line, how: 'passed' });
  }
  // Display places per column: the app shows a column if the frontend (or the handler of a route the frontend calls)
  // reads it explicitly (select list, SQL list; place = where the name is), or if a read returns all columns (*, no list, view,
  // SQL function) and the frontend accesses a property of that name (place = the access). What has no place, everydeck does not read.
  // The access must be where the rows go: the reading file and what it renders (its imports), or, for a file that renders nothing (a
  // hook, a data module), the files that import it and what they render. An access of that name anywhere else is no display place (the metadata of a
  // token table is not shown by the metadata of an admin log on another page).
  const importers = new Map(); for (const [f, imps] of Object.entries(import_graph)) for (const i of imps) { if (!importers.has(i)) importers.set(i, []); importers.get(i).push(f); }
  const down = (starts, depth) => { const seen = new Set(starts); let level = [...starts]; for (let d = 0; d < depth; d++) { const next = []; for (const f of level) for (const i of import_graph[f] ?? []) if (!seen.has(i)) { seen.add(i); next.push(i); } level = next; } return [...seen]; };
  const rowsGoTo = new Map();
  const filesFor = (f) => { if (!rowsGoTo.has(f)) { let up = [];
    if (!rendering.has(f)) { const first = importers.get(f) ?? []; up = [...first, ...first.filter((x) => !rendering.has(x)).flatMap((x) => importers.get(x) ?? [])]; }   // a hook used by a hook
    rowsGoTo.set(f, [...new Set([...down([f], 3), ...down([...new Set(up)], 2)])]); } return rowsGoTo.get(f); };
  const accessFor = (name, f) => { const at = props.get(name); if (!at) return null; for (const x of filesFor(f)) if (at.has(x)) return at.get(x); return null; };
  const columns_shown = [];
  for (const cr of colReads) { const t = tables.get(cr.table); if (!t) continue;
    for (const c of t.columns) {
      const hit = cr.cols === '*' ? (() => { const a = accessFor(c.name, cr.path); return a ? { ...a, via: `${cr.via} (all columns) at ${cr.path}:${cr.line}` } : null; })() : (() => { const x = cr.cols.find((y) => y.name === c.name); return x ? { path: x.file ? rel(resolve(repo, x.file)) : cr.path, line: x.line, via: `${cr.via} at ${cr.path}:${cr.line}` } : null; })();
      if (hit && !columns_shown.some((x) => x.table === cr.table && x.column === c.name && x.path === hit.path && x.line === hit.line)) columns_shown.push({ table: cr.table, column: c.name, path: hit.path, line: hit.line, via: hit.via.slice(0, 160) }); } }
  const not_shown = mentions.filter((m) => !shownTables.has(m.table));
  // ── Money from facts in the code. A value is money where the app formats it as a currency: Intl.NumberFormat(…, { style: 'currency' })
  //    (.format(x), also through a variable) or x.toLocaleString(…, { style: 'currency' }). An own function counts only if its body
  //    provably formats this way (also imported, also through another function), never by its name. Currency from the call: a literal, a
  //    property (→ column of the same table) or a parameter the caller fills; otherwise no currency (nothing guessed).
  const money = []; const helpers = new Map();   // helpers: `${file}#${name}` → { param, currency, currency_prop, currency_param, via }
  const fnLike = (n) => n && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n));
  const enclosingFn = (n) => { let p = n.parent; while (p && !fnLike(p)) p = p.parent; return p ?? null; };
  const fnName = (f) => { if (f.name && ts.isIdentifier(f.name)) return f.name.text; let p = f.parent; while (p && (ts.isCallExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) p = p.parent; return p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : null; };
  const paramIndex = (f, name) => f.parameters.findIndex((pp) => ts.isIdentifier(pp.name) && pp.name.text === name);
  const optsCurrency = (o) => { o = unwrap(o); if (!o || !ts.isObjectLiteralExpression(o)) return null; let style = null; let cur = null; let has = false;
    for (const pp of o.properties) { const k = pp.name && (ts.isIdentifier(pp.name) || ts.isStringLiteral(pp.name)) ? pp.name.text : null; if (k === 'style' && ts.isPropertyAssignment(pp)) style = strOf(pp.initializer); if (k === 'currency') { has = true; cur = ts.isShorthandPropertyAssignment(pp) ? pp.name : pp.initializer; } }
    return style === 'currency' && has ? { node: cur } : null; };
  /** Currency of a formatter: literal (IDR), property (row.currency) or parameter of the enclosing function */
  const currencyOf = (node, at) => { const n = unwrap(node); const lit = n ? strOf(n) : null; if (lit && /^[A-Za-z]{3}$/.test(lit)) return { currency: lit.toUpperCase() };
    if (n && ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) return { currency_prop: n.name.text };
    if (n && ts.isIdentifier(n)) { const f = enclosingFn(at); const i = f ? paramIndex(f, n.text) : -1; if (i >= 0) return { currency_param: i }; }
    return {}; };
  const describe = (c) => (c.currency ? `currency ${c.currency}` : c.currency_prop ? `currency from ${c.currency_prop}` : c.currency_param !== undefined ? 'currency from the caller' : 'no currency in the code');
  /** the value behind Number(x), parseFloat(x), x ?? 0, x / 100 … */
  const core = (n) => { for (;;) { n = unwrap(n); if (!n) return n;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(Number|parseFloat|parseInt|BigInt|Math\.round)$/.test(n.expression.text) && n.arguments[0]) { n = n.arguments[0]; continue; }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind)) { n = n.left; continue; }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.SlashToken, ts.SyntaxKind.AsteriskToken].includes(n.operatorToken.kind)) { n = ts.isNumericLiteral(unwrap(n.right)) ? n.left : ts.isNumericLiteral(unwrap(n.left)) ? n.right : null; continue; }
    return n; } };
  const bindingProp = (sf, name) => { let found = null; const v = (n) => { if (!found && ts.isBindingElement(n) && ts.isIdentifier(n.name) && n.name.text === name && n.parent && ts.isObjectBindingPattern(n.parent) && !(n.parent.parent && ts.isParameter(n.parent.parent))) { const k = n.propertyName ?? n.name; if (ts.isIdentifier(k) || ts.isStringLiteral(k)) found = k.text; } ts.forEachChild(n, v); }; v(sf); return found; };
  let changed = true;
  /** x is money (with currency c): a property → display place; a parameter → the enclosing function formats money */
  const moneyAt = (x, c, via, sf, file, display) => { const n = core(x); if (!n) return;
    const prop = ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name) ? n.name.text : ts.isElementAccessExpression(n) && strOf(n.argumentExpression) ? strOf(n.argumentExpression) : ts.isIdentifier(n) && !(enclosingFn(n) && paramIndex(enclosingFn(n), n.text) >= 0) ? bindingProp(sf, n.text) : null;
    if (prop) { if (display && !money.some((m) => m.prop === prop && m.path === rel(file) && m.line === lineOf(sf, n))) money.push({ prop, path: rel(file), line: lineOf(sf, n), ...(c.currency ? { currency: c.currency } : {}), ...(c.currency_prop ? { currency_prop: c.currency_prop } : {}), via: via.slice(0, 160) }); return; }
    if (ts.isIdentifier(n)) { const f = enclosingFn(n); const name = f && fnName(f); const i = f ? paramIndex(f, n.text) : -1; if (!name || i < 0) return; const key = `${file}#${name}`;
      if (!helpers.has(key)) { helpers.set(key, { param: i, ...c, via }); changed = true; } } };
  const helperAt = (call, file, imports) => { if (!ts.isIdentifier(call.expression)) return null; const name = call.expression.text; const local = helpers.get(`${file}#${name}`); if (local) return { name, h: local };
    const im = imports.get(name); return im && !im.ns ? (helpers.has(`${im.file}#${im.name}`) ? { name, h: helpers.get(`${im.file}#${im.name}`) } : null) : null; };
  for (let pass = 0; changed && pass < 8; pass++) { changed = false;
    for (const p of frontend) { const sf = parse(p); const imports = importsOf(sf, p); const display = reachable.has(p); const fmtVars = new Map();
      const visit = (n) => {
        const isIntl = (e) => (ts.isNewExpression(e) || ts.isCallExpression(e)) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'Intl' && e.expression.name.text === 'NumberFormat';
        if (isIntl(n) && n.arguments?.[1]) { const o = optsCurrency(n.arguments[1]);
          if (o) { const c = o.node ? currencyOf(o.node, n) : {}; const via = `Intl.NumberFormat ${describe(c)} at ${rel(p)}:${lineOf(sf, n)}`;
            const use = n.parent && ts.isPropertyAccessExpression(n.parent) && /^(format|formatToParts)$/.test(n.parent.name.text) && ts.isCallExpression(n.parent.parent) ? n.parent.parent : null;
            if (use?.arguments[0]) moneyAt(use.arguments[0], c, via, sf, p, display);
            if (n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) fmtVars.set(n.parent.name.text, { c, via }); } }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const m = n.expression.name.text; const rec = n.expression.expression;
          if (m === 'toLocaleString' && n.arguments[1]) { const o = optsCurrency(n.arguments[1]); if (o) { const c = o.node ? currencyOf(o.node, n) : {}; moneyAt(rec, c, `toLocaleString ${describe(c)} at ${rel(p)}:${lineOf(sf, n)}`, sf, p, display); } }
          if (/^(format|formatToParts)$/.test(m) && ts.isIdentifier(rec) && fmtVars.has(rec.text) && n.arguments[0]) { const f = fmtVars.get(rec.text); moneyAt(n.arguments[0], f.c, f.via, sf, p, display); } }
        if (ts.isCallExpression(n)) { const hit = helperAt(n, p, imports);
          if (hit && n.arguments[hit.h.param]) { const c = hit.h.currency_param !== undefined ? (n.arguments[hit.h.currency_param] ? currencyOf(n.arguments[hit.h.currency_param], n) : {}) : { ...(hit.h.currency ? { currency: hit.h.currency } : {}), ...(hit.h.currency_prop ? { currency_prop: hit.h.currency_prop } : {}) };
            moneyAt(n.arguments[hit.h.param], c, `${hit.name}(…) → ${hit.h.via}`, sf, p, display); } }
        ts.forEachChild(n, visit); };
      visit(sf); } }
  // ── Display kind from the place where the app shows the value; only columns of tables the frontend reads ──
  // Frontend data accesses per line (tables read there, also through API routes, RPC, views)
  const readsByLine = new Map(); for (const cr of colReads) { const k = `${cr.path}:${cr.line}`; if (!readsByLine.has(k)) readsByLine.set(k, new Set()); readsByLine.get(k).add(cr.table); }
  const readsAt = (file, line) => readsByLine.get(`${rel(file)}:${line}`) ?? null;
  const readColumns = new Map(); for (const cr of colReads) if (!readColumns.has(cr.table)) readColumns.set(cr.table, new Set((tables.get(cr.table)?.columns ?? []).map((c) => c.name)));
  const shownAs = ts && frontend.length ? analyseDisplay({ ts, files: frontend, reachable, parse, rel, lineOf, unwrap, strOf, resolveModule, tableColumns: readColumns, tableKey, readsAt, allFiles: files, read, valuesOf: (t, c) => { const tb = tables.get(t); const col = tb?.columns.find((x) => x.name === c); return [...new Set([...(col?.enum ?? []).map((e) => e.value), ...(tb?.status_column === c ? (tb.statuses ?? []).map((x) => x.value) : [])])]; } }) : { places: [], ends: [], labels: [] };
  for (const r of pyRel) for (const m of pyFile(r).money ?? []) money.push({ ...m, path: r, via: m.via.replace(/at line (\d+)/, `at ${r}:$1`).slice(0, 160) });   // Python: scaffold-ast.py money_places
  return { browser_writes, page_files, import_graph, column_inserts, display: shownAs.places, display_ends: shownAs.ends, value_labels: shownAs.labels ?? [], name_chains: shownAs.nameChains ?? [], reach: { decided: reach.decided, entries: reach.entries.map((e) => ({ path: rel(e.path), fact: e.fact })), unreachable: reach.unreachable }, shown, not_shown, columns_shown, money, column_writes, provider_columns, routes: routes.map((r) => ({ pattern: r.pattern, method: r.method, file: r.file, line: r.line, reads: uniq(r.access.filter((a) => a.kind === 'read' && a.what !== 'route').flatMap((a) => tablesOf(a).map((x) => x.table))) })), views: [...views.keys()], sql_functions: [...fns.keys()], unreachable: reach.unreachable.map((u) => u.path) };
}
