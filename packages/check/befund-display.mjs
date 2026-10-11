// B35 Punkt 1: dem Wert folgen – Teil des Befund-Gerüsts (befund-reads.mjs ruft es auf), nur Fakten aus dem Syntaxbaum (TypeScript-Compiler-API).
//
// Anzeigestelle (Fakt der Stelle, nie ein Name):
//   <img src={x}>, ein Hintergrundbild (style backgroundImage `url(${x})`)                → image
//   <a href={x}> (x ist der Wert selbst, keine Vorlage mit weiterem Text)                  → link
//   <textarea value|defaultValue={x}>                                                     → textarea
//   {x} in <pre>, in einem Element mit white-space pre-line/pre-wrap (Klasse whitespace-pre-*
//   oder style whiteSpace) oder in einer Markdown-Darstellung (react-markdown)             → long_text
//   ein Datumsformatierer: new Date(x).toLocaleDateString(…) u. a., eine Funktion aus date-fns, dayjs,
//   moment, luxon, Intl.DateTimeFormat(…).format(x)                                        → date
// Eine Komponente der App, die ihre Props an so ein Element weiterreicht (<textarea {...props}>), zählt wie das Element; eine Funktion der App,
// deren Parameter an so eine Stelle geht, macht ihre Aufrufe zu Anzeigestellen (wie Geld seit B32).
//
// Rückverfolgung des Werts x bis zu einer Eigenschaft (x.images → "images"): Variablen, Zerlegungen, .map/.filter/…-Parameter, Bedingungen, ?? und ||,
// Elemente von Listen, Props einer Komponente (<Card property={p}> → p), useState. Eine Eigenschaft gehört zur Spalte desselben Namens; heißt sie anders,
// folgt das Gerüst den Abbildungen der App (Objektliteral { imageUrl: item.images?.[0] } → imageUrl kommt aus images). Wo der Weg endet – beim Aufruf einer
// Funktion, bei einer Eigenschaft ohne Spalte, bei einem festen Wert –, steht das als Fakt in display_ends[] und wird nie geraten.

const ARRAY_PASS = new Set(['slice', 'filter', 'concat', 'reverse', 'toReversed', 'sort', 'toSorted', 'at', 'flat', 'find', 'findLast', 'toString', 'trim', 'valueOf']);
const ARRAY_CALLBACK = new Set(['map', 'forEach', 'filter', 'find', 'findLast', 'flatMap', 'some', 'every', 'sort', 'toSorted', 'findIndex']);
const DATE_METHODS = new Set(['toLocaleDateString', 'toLocaleTimeString', 'toDateString', 'toLocaleString']);
const DATE_PACKAGES = /^(date-fns|date-fns-tz|dayjs|moment|luxon)(\/|$)/;
const MARKDOWN_PACKAGES = /^(react-markdown|markdown-to-jsx)$/;
// Bibliotheken für Datenabfragen: `data` ist das Ergebnis der Abfragefunktion (queryFn bzw. Fetcher)
const QUERY_PACKAGES = /^(@tanstack\/react-query|@tanstack\/vue-query|react-query|swr)$/;

export function analyseDisplay({ ts, files, reachable, parse, rel, lineOf, unwrap: unwrap0, strOf, resolveModule, tableColumns, tableKey, readsAt = () => null, allFiles = [], read = null, valuesOf = () => [] }) {
  const columnNames = new Set([...tableColumns.values()].flatMap((c) => [...c]));
  const unwrap = (n) => { for (;;) { n = unwrap0(n); if (n && ts.isAwaitExpression(n)) { n = n.expression; continue; } return n; } };
  const at = (sf, n) => `${rel(sf.fileName.startsWith('/') ? sf.fileName : sf.fileName)}:${lineOf(sf, n)}`;
  const fileOfSf = new Map(); for (const p of files) fileOfSf.set(parse(p), p);
  const where = (n) => { const sf = n.getSourceFile(); return { sf, file: fileOfSf.get(sf), path: sf.fileName, line: lineOf(sf, n) }; };
  const place = (n) => { const w0 = where(n); return `${w0.path}:${w0.line}`; };
  const fnLike = (n) => n && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n));

  // ── Importe und Deklarationen je Datei ──
  const importCache = new Map();
  const importsOf = (file) => { if (importCache.has(file)) return importCache.get(file); const m = new Map(); const sf = parse(file);
    for (const st of sf.statements) { if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue; const spec = st.moduleSpecifier.text; const f = resolveModule(file, spec); const cl = st.importClause;
      const add = (local, name) => m.set(local, f ? { file: f, name } : { pkg: spec, name });
      if (cl.name) add(cl.name.text, 'default');
      if (cl.namedBindings) { if (ts.isNamespaceImport(cl.namedBindings)) add(cl.namedBindings.name.text, '*'); else for (const el of cl.namedBindings.elements) add(el.name.text, (el.propertyName ?? el.name).text); } }
    importCache.set(file, m); return m; };
  /** Funktion hinter einer Deklaration: function f(){}, const f = () => …, const f = forwardRef((…) => …), memo(…) */
  const fnOfInit = (init) => { init = unwrap(init); if (!init) return null; if (fnLike(init)) return init; if (ts.isCallExpression(init)) { const a = init.arguments.find((x) => fnLike(unwrap(x))); if (a) return unwrap(a); const inner = init.arguments.map((x) => fnOfInit(x)).find(Boolean); if (inner) return inner; } return null; };
  const declCache = new Map();
  const declsOf = (file) => { if (declCache.has(file)) return declCache.get(file); const m = new Map(); const sf = parse(file);
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) m.set(st.name.text, { fn: st, node: st });
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) m.set(d.name.text, { fn: d.initializer ? fnOfInit(d.initializer) : null, node: d });
      if (ts.isExportAssignment(st)) { const f = fnOfInit(st.expression); if (f) m.set('default', { fn: f, node: st }); else if (ts.isIdentifier(st.expression) && m.has(st.expression.text)) m.set('default', m.get(st.expression.text)); }
      if (ts.isFunctionDeclaration(st) && st.name && st.modifiers?.some((x) => x.kind === ts.SyntaxKind.DefaultKeyword)) m.set('default', { fn: st, node: st }); }
    declCache.set(file, m); return m; };
  /** Bezeichner an einer Stelle → Deklaration (Datei, Name), auch über Importe */
  const targetOf = (file, name) => { const local = declsOf(file).get(name); if (local) return { file, name, ...local }; const im = importsOf(file).get(name); if (im?.file) { const d = declsOf(im.file).get(im.name); if (d) return { file: im.file, name: im.name, ...d }; } return null; };

  // ── JSX: Verwendungen von Komponenten der App (<Card property={p}>) ──
  const usages = new Map();   // `${file}#${name}` → JsxOpeningLikeElement[]
  const jsxNodes = [];        // alle öffnenden JSX-Elemente erreichbarer Dateien
  for (const p of files) { if (!reachable.has(p)) continue; const sf = parse(p);
    const v = (n) => { if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) { jsxNodes.push({ n, file: p });
        if (ts.isIdentifier(n.tagName)) { const t = targetOf(p, n.tagName.text); if (t) { const k = `${t.file}#${t.name}`; if (!usages.has(k)) usages.set(k, []); usages.get(k).push(n); } } }
      ts.forEachChild(n, v); };
    v(sf); }
  const keyOfFn = (fn) => { const file = fileOfSf.get(fn.getSourceFile()); if (!file) return null; for (const [name, d] of declsOf(file)) if (d.fn === fn) return `${file}#${name}`; return null; };
  const isComponent = (fn) => { const k = keyOfFn(fn); return !!k && (usages.get(k)?.length ?? 0) > 0; };
  const attrOf = (el, name) => el.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
  const attrExpr = (a) => (!a?.initializer ? null : ts.isStringLiteral(a.initializer) ? a.initializer : ts.isJsxExpression(a.initializer) ? a.initializer.expression ?? null : null);

  // ── Wo ein Bezeichner herkommt (Gültigkeitsbereich über die Vorfahren) ──
  const bindingIn = (pattern, id, path = []) => { for (const [i, el] of pattern.elements.entries()) { if (ts.isOmittedExpression(el)) continue;
      const key = ts.isObjectBindingPattern(pattern) ? ((el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null)) : i;
      if (ts.isIdentifier(el.name) && el.name.text === id) return { path: [...path, { key, rest: !!el.dotDotDotToken }] };
      if (ts.isObjectBindingPattern(el.name) || ts.isArrayBindingPattern(el.name)) { const r = bindingIn(el.name, id, [...path, { key }]); if (r) return r; } } return null; };
  const lookup = (id) => { const name = id.text; let p = id.parent;
    while (p) {
      if (fnLike(p)) for (const [i, prm] of p.parameters.entries()) { if (ts.isIdentifier(prm.name) && prm.name.text === name) return { kind: 'param', fn: p, index: i }; if (!ts.isIdentifier(prm.name)) { const b = bindingIn(prm.name, name); if (b) return { kind: 'paramBinding', fn: p, index: i, path: b.path }; } }
      if (ts.isForOfStatement(p) && ts.isVariableDeclarationList(p.initializer)) for (const d of p.initializer.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return { kind: 'element', of: p.expression };
      const stmts = ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isModuleBlock(p) ? p.statements : null;
      if (stmts) for (const st of stmts) { if (!ts.isVariableStatement(st)) continue; for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return { kind: 'var', decl: d };
        if (!ts.isIdentifier(d.name)) { const b = bindingIn(d.name, name); if (b) return { kind: 'varBinding', decl: d, path: b.path }; } } }
      if (ts.isSourceFile(p)) { const im = importsOf(fileOfSf.get(p) ?? '').get(name); if (im) return { kind: 'import', ...im }; }
      p = p.parent; }
    return null; };

  // ── Rückverfolgung: Ausdruck → Eigenschaften (props), Parameter einer Funktion (params) oder Ende (ends) ──
  const callbackOf = (fn) => { const c = fn.parent; if (!c || !ts.isCallExpression(c) || !c.arguments.includes(fn) || !ts.isPropertyAccessExpression(c.expression)) return null; return ARRAY_CALLBACK.has(c.expression.name.text) ? c.expression.expression : null; };
  const calleeName = (call) => { const e = unwrap(call.expression); return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : e.getText().slice(0, 40); };
  function sourcesOf(e0, depth = 0, seen = new Set()) {
    const out = { props: [], params: [], ends: [] }; const e = unwrap(e0);
    if (!e || depth > 14 || seen.has(e)) return out; seen.add(e);
    const merge = (r) => { out.props.push(...r.props); out.params.push(...r.params); out.ends.push(...r.ends); };
    const end = (fact) => out.ends.push({ fact, at: place(e) });
    const viaUsages = (fn, prop) => { const k = keyOfFn(fn); const uses = k ? usages.get(k) ?? [] : [];
      if (!uses.length) { end(`the value is the prop ${prop} of a component no screen renders`); return; }
      for (const u of uses.slice(0, 20)) { const a = attrOf(u, prop); if (a) { const x = attrExpr(a); if (x) merge(sourcesOf(x, depth + 1, seen)); continue; }
        if (u.attributes.properties.some((s) => ts.isJsxSpreadAttribute(s))) out.props.push({ name: prop, at: place(u), via: [] }); } };
    if (ts.isPropertyAccessExpression(e) || (ts.isElementAccessExpression(e) && strOf(e.argumentExpression))) {
      const name = ts.isPropertyAccessExpression(e) ? e.name.text : strOf(e.argumentExpression); const rec = unwrap(e.expression);
      if (rec && ts.isIdentifier(rec)) { const r = lookup(rec); if (r?.kind === 'param' && r.index === 0 && isComponent(r.fn)) { viaUsages(r.fn, name); return out; } }
      out.props.push({ name, at: place(e), via: [], tables: tableOf(e.expression) }); return out; }
    if (ts.isElementAccessExpression(e)) { merge(sourcesOf(e.expression, depth + 1, seen)); return out; }   // Element einer Liste
    if (ts.isIdentifier(e)) { const r = lookup(e);
      if (!r) { end(`the value comes from ${e.text}, which the generator cannot resolve`); return out; }
      if (r.kind === 'var') { if (r.decl.initializer) merge(sourcesOf(r.decl.initializer, depth + 1, seen)); else end(`${e.text} is declared without a value`); return out; }
      if (r.kind === 'element') { merge(sourcesOf(r.of, depth + 1, seen)); return out; }
      if (r.kind === 'varBinding') { const init = unwrap(r.decl.initializer); const first = r.path[0];
        if (init && ts.isCallExpression(init) && calleeName(init) === 'useState' && first?.key === 0) { if (init.arguments[0]) merge(sourcesOf(init.arguments[0], depth + 1, seen)); else end(`${e.text} starts empty (useState())`); return out; }
        const last = r.path[r.path.length - 1]; if (typeof last?.key === 'string' && !last.rest) { out.props.push({ name: last.key, at: place(r.decl), via: [] }); return out; }
        if (init) merge(sourcesOf(init, depth + 1, seen)); else end(`${e.text} is declared without a value`); return out; }
      if (r.kind === 'param') { const rec = callbackOf(r.fn); if (rec && r.index === 0) { merge(sourcesOf(rec, depth + 1, seen)); return out; }
        if (r.index === 0 && isComponent(r.fn)) { end(`the value is the whole props object of a component`); return out; }
        const k = keyOfFn(r.fn); if (k) { out.params.push({ fn: k, index: r.index }); return out; }
        end(`the value is a parameter of an anonymous function`); return out; }
      if (r.kind === 'paramBinding') { const last = r.path[r.path.length - 1]; const key = typeof last?.key === 'string' && !last.rest ? last.key : null;
        if (r.index === 0 && isComponent(r.fn) && r.path.length === 1 && key) { viaUsages(r.fn, key); return out; }
        if (key) { out.props.push({ name: key, at: place(e), via: [] }); return out; }
        const rec = callbackOf(r.fn); if (rec) { merge(sourcesOf(rec, depth + 1, seen)); return out; }
        end(`the value comes from a parameter of ${keyOfFn(r.fn) ?? 'an anonymous function'}`); return out; }
      if (r.kind === 'import') { end(`the value is ${e.text} imported from ${r.pkg ?? rel(r.file)}`); return out; }
      return out; }
    if (ts.isConditionalExpression(e)) { merge(sourcesOf(e.whenTrue, depth + 1, seen)); merge(sourcesOf(e.whenFalse, depth + 1, seen)); return out; }
    if (ts.isBinaryExpression(e)) { const k = e.operatorToken.kind;
      if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken) { merge(sourcesOf(e.left, depth + 1, seen)); merge(sourcesOf(e.right, depth + 1, seen)); return out; }
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) { merge(sourcesOf(e.right, depth + 1, seen)); return out; }
      end(`the value is computed with ${e.operatorToken.getText()}`); return out; }
    if (ts.isTemplateExpression(e)) { if (!e.head.text && e.templateSpans.length === 1 && !e.templateSpans[0].literal.text) { merge(sourcesOf(e.templateSpans[0].expression, depth + 1, seen)); return out; }
      end('the value is part of a text template'); return out; }
    if (ts.isArrayLiteralExpression(e)) { for (const x of e.elements) merge(sourcesOf(ts.isSpreadElement(x) ? x.expression : x, depth + 1, seen)); return out; }
    if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Date' && e.arguments?.[0]) { merge(sourcesOf(e.arguments[0], depth + 1, seen)); return out; }
    if (ts.isCallExpression(e)) { const ex = unwrap(e.expression);
      if (ts.isPropertyAccessExpression(ex) && ARRAY_PASS.has(ex.name.text)) { merge(sourcesOf(ex.expression, depth + 1, seen)); return out; }
      if (ts.isPropertyAccessExpression(ex) && ex.name.text === 'map' && e.arguments[0]) { const cb = unwrap(e.arguments[0]); if (cb && ts.isArrowFunction(cb) && !ts.isBlock(cb.body)) { merge(sourcesOf(cb.body, depth + 1, seen)); return out; } }
      if (ts.isIdentifier(ex) && /^(String|decodeURIComponent)$/.test(ex.text) && e.arguments[0]) { merge(sourcesOf(e.arguments[0], depth + 1, seen)); return out; }
      // eine Funktion der App, die einen ihrer Parameter zurückgibt (safeStr(v): … return v): der Wert ist das Argument
      if (ts.isIdentifier(ex)) { const t = targetOf(fileOfSf.get(e.getSourceFile()) ?? '', ex.text); const idx = t?.fn ? passThrough(t.fn) : [];
        if (idx.length) { for (const i of idx) if (e.arguments[i]) merge(sourcesOf(e.arguments[i], depth + 1, seen)); return out; } }
      end(`the path ends at the call of ${calleeName(e)}`); return out; }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) { end('the value is fixed in the code'); return out; }
    end(`the path ends at ${ts.SyntaxKind[e.kind]}`); return out;
  }

  const passMemo = new Map();
  /** Parameter, die eine Funktion unverändert zurückgibt (in mindestens einem Zweig) */
  function passThrough(fn) { if (passMemo.has(fn)) return passMemo.get(fn); passMemo.set(fn, []); const rets = [];
    if (fn.body && !ts.isBlock(fn.body)) rets.push(fn.body); else if (fn.body) { const v = (n) => { if (ts.isReturnStatement(n) && n.expression) rets.push(n.expression); if (fnLike(n) && n !== fn) return; ts.forEachChild(n, v); }; ts.forEachChild(fn.body, v); }
    const idx = new Set(); for (const r of rets) { const x = unwrap(r); if (x && ts.isIdentifier(x)) { const i = fn.parameters.findIndex((pp) => ts.isIdentifier(pp.name) && pp.name.text === x.text); if (i >= 0) idx.add(i); } }
    const out = [...idx]; passMemo.set(fn, out); return out; }

  // ── Aus welcher Tabelle ein Objekt stammt: supabase.from('jobs'), .map-Parameter, Props, Argumente einer Funktion der App; null = nicht feststellbar ──
  const tableMemo = new Map();
  const callsOf = (fnKey) => { const out = []; const [file, name] = [fnKey.slice(0, fnKey.lastIndexOf('#')), fnKey.slice(fnKey.lastIndexOf('#') + 1)];
    for (const p of files) { if (!reachable.has(p)) continue; const v = (n) => { if (ts.isCallExpression(n)) { const ex = unwrap(n.expression);
          if (ts.isIdentifier(ex)) { const t = targetOf(p, ex.text); if (t && t.file === file && t.name === name) out.push({ kind: 'call', node: n }); }
          if (ts.isPropertyAccessExpression(ex) && ARRAY_CALLBACK.has(ex.name.text)) for (const a of n.arguments) { const ua = unwrap(a); if (ua && ts.isIdentifier(ua)) { const t = targetOf(p, ua.text); if (t && t.file === file && t.name === name) out.push({ kind: 'callback', node: n, receiver: ex.expression }); } } }
        ts.forEachChild(n, v); }; v(parse(p)); }
    return out; };
  // ── Typangaben als Fakt: ein Objekt vom Typ T stammt aus den Tabellen, aus deren Zeilen die Funktionen der App T bauen ((item): T => ({ … })) ──
  const typeDecl = (file, name) => { const sf = parse(file);
    for (const st of sf.statements) if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name.text === name) return { file, name, node: st };
    const im = importsOf(file).get(name); if (im?.file && im.name !== '*') { const d = parse(im.file).statements.find((st) => (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name.text === im.name); if (d) return { file: im.file, name: im.name, node: d }; }
    return null; };
  /** der benannte Typ hinter einer Typangabe (T, T[], T | null, Promise<T>, Array<T>), aufgelöst zur Deklaration */
  const typeOfNode = (file, t) => { if (!t) return null;
    if (ts.isArrayTypeNode(t)) return typeOfNode(file, t.elementType);
    if (ts.isUnionTypeNode(t)) { const xs = t.types.filter((x) => !(x.kind === ts.SyntaxKind.NullKeyword || x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword))); return xs.length === 1 ? typeOfNode(file, xs[0]) : null; }
    if (ts.isParenthesizedTypeNode(t)) return typeOfNode(file, t.type);
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) { const n = t.typeName.text; if (/^(Promise|Array|ReadonlyArray)$/.test(n) && t.typeArguments?.[0]) return typeOfNode(file, t.typeArguments[0]); const d = typeDecl(file, n); return d ? `${d.file}#${d.name}` : null; }
    return null; };
  const memberType = (file, t, key) => { if (!t) return null;
    const members = ts.isTypeLiteralNode(t) ? t.members : null; if (members) { const m = members.find((x) => ts.isPropertySignature(x) && x.name.getText().replace(/['"]/g, '') === key); return m ? { file, type: m.type } : null; }
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) { const d = typeDecl(file, t.typeName.text); if (!d) return null;
      if (ts.isInterfaceDeclaration(d.node)) { const m = d.node.members.find((x) => ts.isPropertySignature(x) && x.name.getText().replace(/['"]/g, '') === key); return m ? { file: d.file, type: m.type } : null; }
      return memberType(d.file, d.node.type, key); }
    return null; };
  const declaredTypeOf = (id, depth = 0) => { if (depth > 6) return null; const r = lookup(id); const file = fileOfSf.get(id.getSourceFile()); if (!r || !file) return null;
    if (r.kind === 'var') { if (r.decl.type) return typeOfNode(file, r.decl.type); const init = unwrap(r.decl.initializer);
      if (init && ts.isCallExpression(init)) { const ex = unwrap(init.expression); if (ts.isIdentifier(ex)) { const t = targetOf(file, ex.text); if (t?.fn?.type) return typeOfNode(t.file, t.fn.type); } } return null; }
    if (r.kind === 'varBinding') { const init = unwrap(r.decl.initializer); if (init && ts.isCallExpression(init) && calleeName(init) === 'useState' && init.typeArguments?.[0]) return typeOfNode(file, init.typeArguments[0]); return null; }
    if (r.kind === 'param') { const prm = r.fn.parameters[r.index]; if (prm?.type) return typeOfNode(file, prm.type); const rec = callbackOf(r.fn); if (rec && ts.isIdentifier(unwrap(rec))) return declaredTypeOf(unwrap(rec), depth + 1); return null; }
    if (r.kind === 'paramBinding' && r.path.length === 1 && typeof r.path[0].key === 'string') { const prm = r.fn.parameters[r.index]; const m = memberType(file, prm?.type, r.path[0].key); return m ? typeOfNode(m.file, m.type) : null; }
    return null; };
  const typeOriginMemo = new Map();
  const typeOrigin = (typeKey) => { if (typeOriginMemo.has(typeKey)) return typeOriginMemo.get(typeKey); typeOriginMemo.set(typeKey, null); const found = [];
    for (const p of files) { if (!reachable.has(p)) continue; for (const [, d] of declsOf(p)) { const fn = d.fn; if (!fn?.type || typeOfNode(p, fn.type) !== typeKey) continue;
        const body = fn.body && ts.isBlock(fn.body) ? null : unwrap(fn.body); const builds = (body && ts.isObjectLiteralExpression(body)) || (fn.body && ts.isBlock(fn.body) && fn.body.statements.some((st) => ts.isReturnStatement(st) && st.expression && ts.isObjectLiteralExpression(unwrap(st.expression))));
        const prm = fn.parameters[0]; if (!builds || !prm || !ts.isIdentifier(prm.name)) continue; const t = tableOf(prm.name); if (t) found.push(t); } }
    const r = found.length ? new Set(found.flatMap((x) => [...x])) : null; typeOriginMemo.set(typeKey, r); return r; };

  /** Tabellen dessen, was eine Funktion zurückgibt (Ausdruckskörper oder return) */
  function returnsTable(fn, depth) { const rets = []; if (fn.body && !ts.isBlock(fn.body)) rets.push(fn.body); else if (fn.body) { const v = (n) => { if (ts.isReturnStatement(n) && n.expression) rets.push(n.expression); if (fnLike(n) && n !== fn) return; ts.forEachChild(n, v); }; ts.forEachChild(fn.body, v); }
    const known = rets.slice(0, 8).map((x) => tableOf(x, depth + 1)).filter(Boolean); return known.length ? new Set(known.flatMap((x) => [...x])) : null; }

  function tableOf(e0, depth = 0) {
    const e = unwrap(e0); if (!e || depth > 10) return null; if (tableMemo.has(e)) return tableMemo.get(e); tableMemo.set(e, null);
    const union = (xs) => { const all = xs.filter((x) => x !== undefined); if (all.some((x) => x === null) || !all.length) return null; return new Set(all.flatMap((x) => [...x])); };
    let r = null;
    if (ts.isCallExpression(e)) { const ex = unwrap(e.expression);
      // eine Abfrage: …from('jobs')… in der Aufrufkette
      let c = e; while (c && ts.isCallExpression(c)) { const x = unwrap(c.expression); if (ts.isPropertyAccessExpression(x) && /^(from|table)$/.test(x.name.text) && strOf(c.arguments[0])) { const k = tableKey(strOf(c.arguments[0])); r = k ? new Set([k]) : null; break; } c = ts.isPropertyAccessExpression(x) ? unwrap(x.expression) : null; }
      // ein Datenzugriff, den das Gerüst an dieser Zeile erkannt hat (API-Route, deren Handler die Tabelle liest; RPC; Sicht …)
      if (!r) { const w0 = where(e); const hit = readsAt(w0.file, w0.line); if (hit?.size) r = new Set(hit); }
      if (!r && ts.isPropertyAccessExpression(ex) && (ARRAY_PASS.has(ex.name.text) || /^(map|json|then)$/.test(ex.name.text))) r = tableOf(ex.expression, depth + 1);
      if (!r && ts.isIdentifier(ex)) { const t = targetOf(fileOfSf.get(e.getSourceFile()) ?? '', ex.text);
        if (t?.fn) r = returnsTable(t.fn, depth + 1) ?? (e.arguments.length ? tableOf(e.arguments[0], depth + 1) : null); }   // Funktion der App: was sie zurückgibt, sonst die Zeile, aus der sie baut
    } else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) r = tableOf(e.expression, depth + 1);
    else if (ts.isConditionalExpression(e)) r = union([tableOf(e.whenTrue, depth + 1), tableOf(e.whenFalse, depth + 1)]);
    else if (ts.isObjectLiteralExpression(e)) {   // die Felder eines Objekts stammen aus ausgebreiteten Zeilen (…data) und Feldzuweisungen (title: data.title); ein verschachteltes Objekt (profiles: profileData) zählt nicht
      const field = (x) => { x = unwrap(x); while (x && ts.isBinaryExpression(x) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(x.operatorToken.kind)) x = unwrap(x.left); return x && (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) ? x : null; };
      const xs = e.properties.map((pp) => ts.isSpreadAssignment(pp) ? tableOf(pp.expression, depth + 1) : ts.isPropertyAssignment(pp) && field(pp.initializer) ? tableOf(field(pp.initializer), depth + 1) : null).filter(Boolean);
      r = xs.length ? new Set(xs.flatMap((x) => [...x])) : null; }
    else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) r = tableOf(e.left, depth + 1) ?? tableOf(e.right, depth + 1);
    else if (ts.isIdentifier(e)) { const l = lookup(e);
      if (l?.kind === 'var' && l.decl.initializer) r = tableOf(l.decl.initializer, depth + 1);
      else if (l?.kind === 'varBinding' && l.decl.initializer) { const init = unwrap(l.decl.initializer);
        if (ts.isCallExpression(init) && calleeName(init) === 'useState') { // Zustand: der Anfangswert und jeder Aufruf des Setters (derselbe Typ)
          const setter = ts.isArrayBindingPattern(l.decl.name) && l.decl.name.elements[1] && !ts.isOmittedExpression(l.decl.name.elements[1]) && ts.isIdentifier(l.decl.name.elements[1].name) ? l.decl.name.elements[1].name.text : null;
          const xs = [init.arguments[0] ? tableOf(init.arguments[0], depth + 1) : null];
          if (setter) { const v = (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === setter && n.arguments[0] && !fnLike(unwrap(n.arguments[0]))) xs.push(tableOf(n.arguments[0], depth + 1)); ts.forEachChild(n, v); }; v(e.getSourceFile()); }
          const known = xs.filter(Boolean); r = known.length ? new Set(known.flatMap((x) => [...x])) : null; }
        else if (ts.isCallExpression(init) && ts.isIdentifier(unwrap(init.expression)) && QUERY_PACKAGES.test(importsOf(fileOfSf.get(e.getSourceFile()) ?? '').get(unwrap(init.expression).text)?.pkg ?? '') && l.path[0]?.key === 'data') {
          const o = unwrap(init.arguments[0]); const qf = o && ts.isObjectLiteralExpression(o) ? o.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText() === 'queryFn') : null;
          const fn = qf ? unwrap(qf.initializer) : init.arguments.map((a) => unwrap(a)).find((a) => fnLike(a));   // useQuery({ queryFn }) bzw. useSWR(key, fetcher)
          r = fn ? returnsTable(fn, depth + 1) : null; }
        else r = tableOf(init, depth + 1); }
      else if (l?.kind === 'element') r = tableOf(l.of, depth + 1);
      else if (l?.kind === 'param' || l?.kind === 'paramBinding') { const rec = callbackOf(l.fn);
        if (rec) r = tableOf(rec, depth + 1);
        else if (l.index === 0 && isComponent(l.fn)) { const k = keyOfFn(l.fn); const key = l.kind === 'paramBinding' && l.path.length === 1 ? l.path[0].key : null;
          r = key ? union((usages.get(k) ?? []).slice(0, 20).map((u) => { const a = attrOf(u, key); const x = a ? attrExpr(a) : null; return x ? tableOf(x, depth + 1) : null; })) : null; }
        else { const k = keyOfFn(l.fn); if (k) r = union(callsOf(k).slice(0, 20).map((c) => c.kind === 'callback' ? tableOf(c.receiver, depth + 1) : c.node.arguments[l.index] ? tableOf(c.node.arguments[l.index], depth + 1) : null)); } } }
    if (!r && ts.isIdentifier(e)) { const t = declaredTypeOf(e); if (t) r = typeOrigin(t); }   // Typangabe der App
    tableMemo.set(e, r); return r; }

  // ── Abbildungen der App: { imageUrl: item.images?.[0] } → imageUrl kommt aus images ──
  const assigns = new Map();   // Eigenschaftsname → Initialisierer
  for (const p of files) { if (!reachable.has(p)) continue; const v = (n) => {
      if (ts.isPropertyAssignment(n) && n.parent && ts.isObjectLiteralExpression(n.parent) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) { const k = n.name.text; if (!assigns.has(k)) assigns.set(k, []); assigns.get(k).push(n.initializer); }
      if (ts.isShorthandPropertyAssignment(n)) { const k = n.name.text; if (!assigns.has(k)) assigns.set(k, []); assigns.get(k).push(n.name); }
      ts.forEachChild(n, v); }; v(parse(p)); }
  /** Eigenschaft → Spalten (gleicher Name, sonst über die Abbildungen der App), mit dem Weg als Text */
  // tables: Tabellen, aus denen das Objekt nachweislich stammt (null = nicht feststellbar: jede gelesene Tabelle mit dieser Spalte)
  const columnsOf = (name, tables, chain = [], seen = new Set()) => {
    const inTables = tables ? [...tables].filter((t) => tableColumns.get(t)?.has(name)) : [...tableColumns.keys()].filter((t) => tableColumns.get(t).has(name));
    // genau eine Tabelle (aus der Herkunft des Objekts, ohne Herkunft unter allen gelesenen) hat die Spalte – sonst sagt der Code nicht, welche (Fakt, nicht geraten)
    // nur mit feststehender Herkunft (Abfrage, Route, Abbildung, Typangabe) und genau einer Tabelle dieser Herkunft mit der Spalte; sonst ein Fakt
    if (tables && inTables.length === 1) return [{ column: name, tables: inTables, chain }];
    if (inTables.length) return [{ ambiguous: name, tables: inTables, known: !!tables, chain }];
    if (seen.has(name) || seen.size > 12) return []; seen.add(name); const out = [];
    for (const init of (assigns.get(name) ?? []).slice(0, 20)) for (const s of sourcesOf(init).props) if (s.name !== name) out.push(...columnsOf(s.name, s.tables ?? tables, [...chain, `${name} ← ${s.name} at ${place(init)}`], seen));
    return out; };

  // ── Anzeigestellen ──
  const places = []; const ends = []; const helpers = new Map();   // `${file}#${name}` → [{ index, element, via }]
  let changed = true;
  const record = (valueNode, element, via, siteNode) => { const r = sourcesOf(valueNode); const site = where(siteNode); let found = false;
    for (const s of r.props) { const all = columnsOf(s.name, s.tables ?? null); const cols = all.filter((c) => c.column);
      for (const a of all.filter((c) => c.ambiguous)) if (!cols.length && !ends.some((x) => x.element === element && x.path === site.path && x.line === site.line)) ends.push({ element, path: site.path, line: site.line, fact: a.known ? `the value is the property ${a.ambiguous} of a record from ${a.tables.slice(0, 4).join(', ')}${a.tables.length > 4 ? ' …' : ''} – several of them have such a column` : `the value is the property ${a.ambiguous}; the code does not say which table the record comes from (a column ${a.ambiguous} exists in ${a.tables.slice(0, 4).join(', ')}${a.tables.length > 4 ? ' …' : ''})` });
      for (const c of cols) { found = true;
        const same = places.find((x) => x.prop === c.column && x.element === element && x.path === site.path && x.line === site.line);
        if (!same) places.push({ prop: c.column, tables: c.tables, element, path: site.path, line: site.line, symbol: valueNode.getText().split('\n')[0].trim().slice(0, 160), via: [via, ...c.chain].join('; ').slice(0, 160) });
        else { for (const step of c.chain) if (!same.via.includes(step)) same.via = `${same.via}; ${step}`.slice(0, 160); same.tables = [...new Set([...same.tables, ...c.tables])]; } }
      if (!all.length && !ends.some((x) => x.element === element && x.path === site.path && x.line === site.line)) ends.push({ element, path: site.path, line: site.line, fact: `the value is the property ${s.name}, which is no column of a table the frontend reads` }); }
    for (const pr of r.params) { const list = helpers.get(pr.fn) ?? []; if (!list.some((h) => h.index === pr.index && h.element === element)) { list.push({ index: pr.index, element, via }); helpers.set(pr.fn, list); changed = true; } found = true; }
    if (!found) for (const e of r.ends.slice(0, 1)) if (!ends.some((x) => x.element === element && x.path === site.path && x.line === site.line)) ends.push({ element, path: site.path, line: site.line, fact: `${e.fact} (${e.at})` }); };

  // Komponente → Element, an das sie ihre Props weiterreicht (<textarea {...props}>)
  const forwardCache = new Map();
  const forwardsTo = (tagName, file) => { const t = ts.isIdentifier(tagName) ? targetOf(file, tagName.text) : null; if (!t?.fn) return null; const k = `${t.file}#${t.name}`; if (forwardCache.has(k)) return forwardCache.get(k);
    forwardCache.set(k, null); const fn = t.fn; const names = new Set();
    for (const prm of fn.parameters.slice(0, 1)) { if (ts.isIdentifier(prm.name)) names.add(prm.name.text); else if (ts.isObjectBindingPattern(prm.name)) for (const el of prm.name.elements) if (el.dotDotDotToken && ts.isIdentifier(el.name)) names.add(el.name.text); }
    let tag = null; const v = (n) => { if (tag) return; if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a) && ts.isIdentifier(unwrap(a.expression)) && names.has(unwrap(a.expression).text))) tag = n.tagName.getText(); ts.forEachChild(n, v); };
    if (names.size) v(fn); forwardCache.set(k, tag && /^[a-z]/.test(tag) ? tag : null); return forwardCache.get(k); };
  const pkgOf = (file, tagName) => { if (!ts.isIdentifier(tagName)) return null; const im = importsOf(file).get(tagName.text); return im?.pkg ?? null; };
  const LONG_CLASS = /(^|\s)whitespace-pre-(line|wrap)(\s|$)/;
  const textOf = (n) => { n = unwrap(n); if (!n) return ''; if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text; if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' '); if (ts.isCallExpression(n)) return n.arguments.map(textOf).join(' '); if (ts.isBinaryExpression(n)) return `${textOf(n.left)} ${textOf(n.right)}`; if (ts.isConditionalExpression(n)) return `${textOf(n.whenTrue)} ${textOf(n.whenFalse)}`; return ''; };
  const styleProp = (el, prop) => { const x = unwrap(attrExpr(attrOf(el, 'style'))); if (!x || !ts.isObjectLiteralExpression(x)) return null; const pp = x.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText().replace(/['"]/g, '') === prop); return pp ? pp.initializer : null; };
  const multiline = (el, file) => { const tag = el.tagName.getText(); if (tag === 'pre') return 'pre';
    if (LONG_CLASS.test(textOf(attrExpr(attrOf(el, 'className')) ?? attrExpr(attrOf(el, 'class'))))) return 'class whitespace-pre-*';
    const ws = strOf(styleProp(el, 'whiteSpace')); if (ws === 'pre-line' || ws === 'pre-wrap') return `style whiteSpace ${ws}`;
    const pkg = pkgOf(file, el.tagName); if (pkg && MARKDOWN_PACKAGES.test(pkg)) return `Markdown (${pkg})`; return null; };

  const scanSinks = () => {
    for (const { n: el, file } of jsxNodes) { const sf = el.getSourceFile(); const raw = el.tagName.getText(); const tag = /^[a-z]/.test(raw) ? raw : forwardsTo(el.tagName, file) ?? raw;
      const here = (what) => `${what} at ${rel(file)}:${lineOf(sf, el)}`;
      if (tag === 'img' || tag === 'source') { const x = attrExpr(attrOf(el, 'src')); if (x && !ts.isStringLiteral(x)) record(x, 'image', here(`<${raw} src>`), x); }
      const bg = styleProp(el, 'backgroundImage') ?? styleProp(el, 'background');
      if (bg && ts.isTemplateExpression(unwrap(bg))) { const t = unwrap(bg); const i = t.templateSpans.findIndex((s, k) => /url\(\s*['"]?$/.test(k === 0 ? t.head.text : t.templateSpans[k - 1].literal.text)); if (i >= 0) record(t.templateSpans[i].expression, 'image', here('background image'), t.templateSpans[i].expression); }
      if (tag === 'a') { const x = attrExpr(attrOf(el, 'href')); const u = unwrap(x); if (u && !ts.isStringLiteral(u) && !(ts.isTemplateExpression(u) && (u.head.text || u.templateSpans.length !== 1 || u.templateSpans[0].literal.text))) record(u, 'link', here(`<${raw} href>`), u); }
      if (tag === 'textarea') for (const a of ['value', 'defaultValue']) { const x = attrExpr(attrOf(el, a)); if (x && !ts.isStringLiteral(x)) record(x, 'textarea', here(`<${raw} ${a}>`), x); }
      const html = unwrap(attrExpr(attrOf(el, 'dangerouslySetInnerHTML')));
      if (html && ts.isObjectLiteralExpression(html)) { const pp = html.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText() === '__html'); let x = pp ? unwrap(pp.initializer) : null;
        // HTML aus einem Paket (Sanitizer, Markdown-Renderer: DOMPurify.sanitize(x), marked(x)) – der gezeigte Text ist dessen erstes Argument
        const pk = x && ts.isCallExpression(x) ? (ts.isIdentifier(unwrap(x.expression)) ? importsOf(file).get(unwrap(x.expression).text) : ts.isPropertyAccessExpression(unwrap(x.expression)) && ts.isIdentifier(unwrap(unwrap(x.expression).expression)) ? importsOf(file).get(unwrap(unwrap(x.expression).expression).text) : null) : null;
        if (pk?.pkg && x.arguments[0]) x = x.arguments[0];
        if (x) record(x, 'long_text', here(`HTML (dangerouslySetInnerHTML${pk?.pkg ? `, ${pk.pkg}` : ''})`), x); }
      const ml = multiline(el, file);
      if (ml) { const owner = el.parent; const kids = ts.isJsxElement(owner) ? owner.children : [];
        for (const k of kids) if (ts.isJsxExpression(k) && k.expression) record(k.expression, 'long_text', here(ml), k.expression);
        for (const a of ['children', 'source']) { const x = attrExpr(attrOf(el, a)); if (x && !ts.isStringLiteral(x) && /Markdown/.test(ml)) record(x, 'long_text', here(ml), x); } } }
    // Datumsformatierer und Funktionen der App, die ihren Parameter zeigen
    for (const p of files) { if (!reachable.has(p)) continue; const sf = parse(p); const imps = importsOf(p);
      const dateArg = (x) => { x = unwrap(x); if (x && ts.isNewExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'Date' && x.arguments?.[0]) return x.arguments[0]; if (x && ts.isCallExpression(x) && ts.isIdentifier(x.expression) && DATE_PACKAGES.test(imps.get(x.expression.text)?.pkg ?? '') && x.arguments[0]) return dateArg(x.arguments[0]); return x; };
      const v = (n) => {
        if (ts.isCallExpression(n)) { const ex = unwrap(n.expression);
          if (ts.isPropertyAccessExpression(ex) && DATE_METHODS.has(ex.name.text)) { const rec = unwrap(ex.expression); const isDate = rec && ts.isNewExpression(rec) && ts.isIdentifier(rec.expression) && rec.expression.text === 'Date';
            const noCurrency = !(ex.name.text === 'toLocaleString' && n.arguments[1] && /currency/.test(n.arguments[1].getText()));
            if (isDate && rec.arguments?.[0] && noCurrency) record(rec.arguments[0], 'date', `Date#${ex.name.text} at ${rel(p)}:${lineOf(sf, n)}`, rec.arguments[0]); }
          if (ts.isIdentifier(ex) && DATE_PACKAGES.test(imps.get(ex.text)?.pkg ?? '') && n.arguments[0] && !(n.parent && ts.isCallExpression(n.parent) && ts.isIdentifier(n.parent.expression) && DATE_PACKAGES.test(imps.get(n.parent.expression.text)?.pkg ?? ''))) {
            const arg = dateArg(n.arguments[0]); if (arg) record(arg, 'date', `${ex.text} (${imps.get(ex.text).pkg}) at ${rel(p)}:${lineOf(sf, n)}`, arg); }
          if (ts.isPropertyAccessExpression(ex) && ex.name.text === 'format' && n.arguments[0] && /\bIntl\.DateTimeFormat\b/.test(ex.expression.getText())) { const arg = dateArg(n.arguments[0]); if (arg) record(arg, 'date', `Intl.DateTimeFormat at ${rel(p)}:${lineOf(sf, n)}`, arg); }
          if (ts.isIdentifier(ex)) { const t = targetOf(p, ex.text); const hs = t ? helpers.get(`${t.file}#${t.name}`) : null;
            for (const h of hs ?? []) if (n.arguments[h.index]) record(n.arguments[h.index], h.element, `${ex.text}(…) → ${h.via}`, n.arguments[h.index]); } }
        ts.forEachChild(n, v); };
      v(sf); } };
  for (let pass = 0; changed && pass < 6; pass++) { changed = false; scanSinks(); }

  // ── B35 Punkt 2: Bezeichnungen der App für Werte ─────────────────────────────────────────────────────────────────────────────────────────
  // Übersetzungsdateien: JSON, die das Frontend lädt (import … from './x.json', import(`./translations/${l}.json`)); Sprache aus dem Datei- oder
  // Ordnernamen (en.json, en/jobs.json), Namensraum = Dateiname im Sprachordner (i18next "jobs:key")
  const LANG = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/;
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/')); const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.json$/, '');
  const norm = (p) => { const out = []; for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg !== '.' && seg !== '') out.push(seg); } return '/' + out.join('/'); };
  const trFiles = new Set();
  for (const p of files) { if (!reachable.has(p)) continue; const v = (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.endsWith('.json')) { const f = resolveModule(p, n.moduleSpecifier.text) ?? norm(`${dirOf(p)}/${n.moduleSpecifier.text}`); if (allFiles.includes(f)) trFiles.add(f); }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isTemplateExpression(n.arguments[0])) { const t = n.arguments[0]; const tail = t.templateSpans[t.templateSpans.length - 1].literal.text;
        if (t.templateSpans.length === 1 && tail.endsWith('.json') && t.head.text.includes('/')) { const dir = norm(`${dirOf(p)}/${t.head.text}`); const pre = t.head.text.endsWith('/') ? '' : baseOf(t.head.text);
          for (const f of allFiles) if (f.endsWith(tail) && dirOf(f) === (t.head.text.endsWith('/') ? dir : dirOf(dir)) && baseOf(f).startsWith(pre)) trFiles.add(f); } }
      ts.forEachChild(n, v); }; v(parse(p)); }
  const trIndex = [];   // { path, lang, ns, flat: Map<key, { text, line }> }
  for (const f of trFiles) { let src; try { src = read(f); } catch { continue; } let obj; try { obj = JSON.parse(src); } catch { continue; }
    const lines = src.split('\n'); const flat = new Map(); const walk = (o, pre) => { for (const [k, v] of Object.entries(o ?? {})) { const key = pre ? `${pre}.${k}` : k;
      if (typeof v === 'string') { const re = new RegExp(`"${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`); const i = lines.findIndex((l) => re.test(l)); flat.set(key, { text: v, line: i >= 0 ? i + 1 : 1 }); }
      else if (v && typeof v === 'object') walk(v, key); } }; walk(obj, '');
    const b0 = baseOf(f); const parent = baseOf(dirOf(f)); const lang = LANG.test(b0) ? b0 : LANG.test(parent) ? parent : null; const ns = LANG.test(parent) && !LANG.test(b0) ? b0 : null;
    trIndex.push({ path: rel(f), lang: lang?.replace('_', '-') ?? null, ns, flat }); }
  /** Text eines Übersetzungsschlüssels je Sprache ("jobs:status_open" → Datei des Namensraums jobs) */
  const translate = (key) => { if (!key || /\s/.test(key)) return []; const i = key.indexOf(':'); const ns = i > 0 ? key.slice(0, i) : null; const k = i > 0 ? key.slice(i + 1) : key;
    return trIndex.filter((t) => (!ns || t.ns === ns) && t.flat.has(k)).map((t) => ({ label: t.flat.get(k).text, lang: t.lang, path: t.path, line: t.flat.get(k).line })); };

  /** Wird der Ausdruck gezeigt? (Inhalt eines Elements, lesbares Attribut, Prop einer Komponente – auch durch t(…), ??, ?:, Vorlagen und eine Variable) */
  const SHOWN_ATTRS = new Set(['title', 'placeholder', 'alt', 'aria-label', 'label', 'children']);
  const isShown = (n, depth = 0) => { if (depth > 8) return false; const p = n.parent; if (!p) return false;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p)) return isShown(p, depth + 1);
    if (ts.isCallExpression(p) && p.arguments[0] === n) return isShown(p, depth + 1);
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.PlusToken].includes(p.operatorToken.kind)) return isShown(p, depth + 1);
    if (ts.isConditionalExpression(p) && p.condition !== n) return isShown(p, depth + 1);
    if (ts.isJsxExpression(p)) { const q = p.parent; if (ts.isJsxElement(q) || ts.isJsxFragment(q)) return true; if (ts.isJsxAttribute(q)) { const nm = q.name.getText(); const tag = q.parent.parent.tagName.getText(); return SHOWN_ATTRS.has(nm) || (!/^[a-z]/.test(tag) && !/^(key|className|style|id|to|href|src|value|type|variant|size|as)$|^on[A-Z]/.test(nm)); } return false; }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) { const name = p.name.text; let hit = false; const scope = p.parent?.parent?.parent ?? p.getSourceFile();
      const v = (x) => { if (hit) return; if (ts.isIdentifier(x) && x.text === name && x !== p.name && lookup(x)?.decl === p && isShown(x, depth + 1)) hit = true; ts.forEachChild(x, v); }; v(scope); return hit; }
    if (ts.isReturnStatement(p)) return 'return';
    return false; };
  const returnedFrom = (n) => { let p = n; while (p && !fnLike(p)) p = p.parent; return p ?? null; };
  const labels = []; const labelHelpers = new Map();   // `${file}#${name}` → { index, entries, via }
  /** Bezeichnungen je Wert aus einer Zuordnung: Text oder – ist er ein Übersetzungsschlüssel – die Übersetzungen */
  const resolveEntries = (entries) => entries.filter((en) => en.value !== '').flatMap((en) => {   // ein leerer Wert (Platzhalter-Option) ist kein Wert der Spalte
     const tr = translate(en.text); return tr.length ? tr.map((t) => ({ value: en.value, label: t.label, lang: t.lang, path: t.path, line: t.line })) : en.literal ? [{ value: en.value, label: en.text, lang: null, path: en.path, line: en.line }] : []; });
  const addLabels = (x, entries, via) => { const r = sourcesOf(x); const vals = resolveEntries(entries);
    for (const pr of r.params) { const prev = labelHelpers.get(pr.fn); if (!prev) { labelHelpers.set(pr.fn, { index: pr.index, entries, via }); changed = true; } }
    for (const s of r.props) for (const c of columnsOf(s.name, s.tables ?? null)) { if (!c.column) continue;
      for (const v of vals) if (!labels.some((l) => l.column === c.column && l.value === v.value && l.lang === v.lang && l.label === v.label)) labels.push({ column: c.column, tables: c.tables, ...v, via: via.slice(0, 160) }); } };
  /** Einträge eines Objektliterals { wert: 'Text' } (auch { wert: { label: 'Text' } } mit .label am Zugriff) */
  const objectEntries = (obj, file, sub) => { const out = []; const sf = obj.getSourceFile();
    for (const pp of obj.properties) { if (!ts.isPropertyAssignment(pp)) continue; const key = ts.isIdentifier(pp.name) || ts.isStringLiteral(pp.name) || ts.isNumericLiteral(pp.name) ? pp.name.text : null; if (key === null) continue;
      let val = unwrap(pp.initializer); if (sub && val && ts.isObjectLiteralExpression(val)) { const q = val.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText().replace(/['"]/g, '') === sub); val = q ? unwrap(q.initializer) : null; }
      const text = val ? strOf(val) : null; if (text) out.push({ value: key, text, literal: true, path: rel(file), line: lineOf(sf, pp) }); }
    return out; };
  const objectOf = (id, file) => { const r = lookup(id); let init = null; let f = file;
    if (r?.kind === 'var') init = r.decl.initializer; else if (r?.kind === 'import' && r.file) { const d = declsOf(r.file).get(r.name); if (d && ts.isVariableDeclaration(d.node)) { init = d.node.initializer; f = r.file; } }
    init = unwrap(init); return init && ts.isObjectLiteralExpression(init) ? { obj: init, file: f } : null; };
  const scanLabels = () => {
    for (const p of files) { if (!reachable.has(p)) continue; const sf = parse(p);
      const v = (n) => {
        // (a) Objekt[x] bzw. Objekt[x].label
        if (ts.isElementAccessExpression(n) && ts.isIdentifier(unwrap(n.expression)) && !strOf(n.argumentExpression)) { const o = objectOf(unwrap(n.expression), p);
          if (o) { const sub = n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n ? n.parent.name.text : null; const at0 = sub ? n.parent : n; const shown = isShown(at0);
            const entries = objectEntries(o.obj, o.file, sub); const via = `${unwrap(n.expression).text}[…] at ${rel(p)}:${lineOf(sf, n)}`;
            if (entries.length && shown === true) addLabels(n.argumentExpression, entries, via);
            if (entries.length && shown === 'return') { const fn = returnedFrom(n); const x = sourcesOf(n.argumentExpression); for (const pr of x.params) if (keyOfFn(fn) === pr.fn && !labelHelpers.has(pr.fn)) { labelHelpers.set(pr.fn, { index: pr.index, entries, via }); changed = true; } } } }
        // (b) switch (x) { case 'wert': return 'Text' | t('schlüssel') } in einer Funktion der App
        if (ts.isSwitchStatement(n)) { const entries = []; for (const cl of n.caseBlock.clauses) { if (!ts.isCaseClause(cl)) continue; const val = strOf(cl.expression); if (val === null) continue;
            const ret = cl.statements.find((st) => ts.isReturnStatement(st)); const ex = ret?.expression ? unwrap(ret.expression) : null; const text = ex ? strOf(ex) ?? (ts.isCallExpression(ex) ? strOf(ex.arguments[0]) : null) : null;
            if (text) entries.push({ value: val, text, literal: !!strOf(ex), path: rel(p), line: lineOf(sf, cl) }); }
          if (entries.length) { const fn = returnedFrom(n); const x = sourcesOf(n.expression); for (const pr of x.params) if (fn && keyOfFn(fn) === pr.fn && !labelHelpers.has(pr.fn)) { labelHelpers.set(pr.fn, { index: pr.index, entries, via: `switch at ${rel(p)}:${lineOf(sf, n)}` }); changed = true; } } }
        // (c) <select value={x}> mit <option value="wert">Text</option>
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ts.isJsxOpeningElement(n) && ts.isJsxElement(n.parent)) { const x = attrExpr(attrOf(n, 'value'));
          if (x && !ts.isStringLiteral(x)) { const entries = [];
            for (const k of n.parent.children) { if (!ts.isJsxElement(k)) continue; const val = strOf(attrExpr(attrOf(k.openingElement, 'value'))); if (val === null) continue;
              const texts = k.children.filter((c) => !(ts.isJsxText(c) && !c.getText().trim())); const one = texts.length === 1 ? texts[0] : null;
              const text = one && ts.isJsxText(one) ? one.getText().trim() : one && ts.isJsxExpression(one) && one.expression ? (strOf(one.expression) ?? (ts.isCallExpression(unwrap(one.expression)) ? strOf(unwrap(one.expression).arguments[0]) : null)) : null;
              if (text) entries.push({ value: val, text, literal: !!(one && (ts.isJsxText(one) || strOf(one.expression))), path: rel(p), line: lineOf(sf, k) }); }
            if (entries.length) addLabels(x, entries, `<${n.tagName.getText()} value> options at ${rel(p)}:${lineOf(sf, n)}`); } }
        // (d) Übersetzungsschlüssel aus dem Wert: t(`jobs:status_${x}`) – für jeden festen Wert der Spalte
        if (ts.isCallExpression(n) && n.arguments[0] && ts.isTemplateExpression(n.arguments[0]) && n.arguments[0].templateSpans.length === 1 && isShown(n) === true) { const t = n.arguments[0]; const head = t.head.text; const tail = t.templateSpans[0].literal.text;
          const r = sourcesOf(t.templateSpans[0].expression);
          for (const s of r.props) for (const c of columnsOf(s.name, s.tables ?? null)) { if (!c.column) continue; const vals = c.tables.flatMap((tb) => valuesOf(tb, c.column));
            const entries = vals.map((val) => ({ value: val, text: `${head}${val}${tail}`, literal: false })); for (const l of resolveEntries(entries)) if (!labels.some((x) => x.column === c.column && x.value === l.value && x.lang === l.lang)) labels.push({ column: c.column, tables: c.tables, ...l, via: `key ${head}…${tail} at ${rel(p)}:${lineOf(sf, n)}` }); } }
        // Aufrufe von Funktionen der App, die einen Wert in seine Bezeichnung übersetzen
        if (ts.isCallExpression(n) && ts.isIdentifier(unwrap(n.expression))) { const t = targetOf(p, unwrap(n.expression).text); const h = t ? labelHelpers.get(`${t.file}#${t.name}`) : null;
          if (h && n.arguments[h.index] && isShown(n) === true) addLabels(n.arguments[h.index], h.entries, `${unwrap(n.expression).text}(…) → ${h.via}`); }
        ts.forEachChild(n, v); };
      v(sf); } };
  changed = true; for (let pass = 0; changed && pass < 4; pass++) { changed = false; scanLabels(); }

  // ── B35 Punkt 3: wie die App einen Namen aus Spalten bildet – angezeigte Ersatzketten (a || b ?? c) und Zusammensetzungen (`${a} ${b}`,
  //    [a, b].filter(Boolean).join(' '), a + ' ' + b); jede Stufe sind Spalten derselben Tabelle mit feststehender Herkunft ──
  const nameChains = [];
  const stepOf = (o) => { o = unwrap(o);
    if (!o) return { stop: true };
    if (ts.isStringLiteral(o) || ts.isNoSubstitutionTemplateLiteral(o) || (ts.isCallExpression(o) && strOf(o.arguments[0]) !== null && !o.arguments.slice(1).length && ts.isIdentifier(unwrap(o.expression)) && !targetOf(fileOfSf.get(o.getSourceFile()) ?? '', unwrap(o.expression).text)?.fn)) return { literal: true };
    let parts = null; let sep = null;
    if (ts.isTemplateExpression(o) && o.templateSpans.length >= 2 && !o.head.text.trim() && !o.templateSpans[o.templateSpans.length - 1].literal.text.trim()) { const mids = o.templateSpans.slice(0, -1).map((x) => x.literal.text); if (mids.every((m) => m === mids[0] && m.length && !/[A-Za-z0-9]/.test(m))) { parts = o.templateSpans.map((x) => x.expression); sep = mids[0]; } }
    if (ts.isCallExpression(o) && ts.isPropertyAccessExpression(unwrap(o.expression)) && unwrap(o.expression).name.text === 'join' && strOf(o.arguments[0]) !== null) { let rec = unwrap(unwrap(o.expression).expression); if (ts.isCallExpression(rec) && ts.isPropertyAccessExpression(unwrap(rec.expression)) && unwrap(rec.expression).name.text === 'filter') rec = unwrap(unwrap(rec.expression).expression); if (ts.isArrayLiteralExpression(rec) && rec.elements.length >= 2) { parts = [...rec.elements]; sep = strOf(o.arguments[0]); } }
    if (parts) { const cols = []; let table = null; for (const x of parts) { const c = colOf(x); if (!c) return { stop: true }; cols.push(c.column); table = table && table !== c.table ? '!' : c.table; } return table && table !== '!' ? { columns: cols, separator: sep, table } : { stop: true }; }
    const c = colOf(o); return c ? { columns: [c.column], table: c.table } : { stop: true }; };
  const colOf = (x) => { const r = sourcesOf(x); if (r.props.length !== 1) return null; const cs = columnsOf(r.props[0].name, r.props[0].tables ?? null).filter((c) => c.column); return cs.length === 1 && cs[0].tables.length === 1 ? { column: cs[0].column, table: cs[0].tables[0] } : null; };
  const chainOf = (e) => { const ops = []; const flat = (x) => { x = unwrap(x); if (ts.isBinaryExpression(x) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(x.operatorToken.kind)) { flat(x.left); flat(x.right); } else ops.push(x); }; flat(e);
    const steps = []; let table = null; let literal = false;
    for (const o of ops) { const st = stepOf(o); if (st.literal) { literal = true; break; } if (st.stop) break; if (table && st.table !== table) break; table = st.table; steps.push({ columns: st.columns, ...(st.separator !== undefined && st.separator !== null ? { separator: st.separator } : {}) }); }
    return steps.length ? { table, steps, literal_fallback: literal } : null; };
  for (const p of files) { if (!reachable.has(p)) continue; const sf = parse(p);
    const v = (n) => { if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) { const ch = chainOf(n.expression); if (ch && (ch.steps.length > 1 || ch.steps[0].columns.length > 1 || ch.literal_fallback)) nameChains.push({ ...ch, path: rel(p), line: lineOf(sf, n), symbol: n.expression.getText().split('\n')[0].trim().slice(0, 160) }); }
      // nebeneinander im selben Element: {p.first_name} {p.last_name} – eine Zusammensetzung mit dem Text dazwischen
      if ((ts.isJsxElement(n) || ts.isJsxFragment(n))) { const kids = n.children.filter((k) => !(ts.isJsxText(k) && k.getText() === '')); for (let i = 0; i + 2 < kids.length; i++) {
          const run = [kids[i]]; let sep = null; let j = i + 1; while (j + 1 < kids.length && ts.isJsxText(kids[j]) && !/[A-Za-z0-9]/.test(kids[j].getText()) && /^[^\n]*$/.test(kids[j].getText()) && (sep === null || sep === kids[j].getText()) && ts.isJsxExpression(kids[j + 1])) { sep = kids[j].getText(); run.push(kids[j + 1]); j += 2; }
          if (run.length >= 2 && run.every((k) => ts.isJsxExpression(k) && k.expression)) { const cols = run.map((k) => colOf(k.expression)); if (cols.every(Boolean) && new Set(cols.map((c) => c.table)).size === 1) nameChains.push({ table: cols[0].table, steps: [{ columns: cols.map((c) => c.column), separator: sep }], literal_fallback: false, path: rel(p), line: lineOf(sf, run[0]), symbol: run[0].expression.getText().slice(0, 160) }); i = j - 1; } } }
      ts.forEachChild(n, v); };
    v(sf); }

  return { places, ends: ends.slice(0, 200), labels, nameChains: nameChains.slice(0, 200), sourcesOf, columnsOf, lookup, targetOf, importsOf, jsxNodes, attrOf, attrExpr, place };
}
