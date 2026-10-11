"""B29 – Befund (1.12-r0): die exakte technische Analyse einer App, Fakten mit Fundstelle, nichts Beurteiltes.

everydeck-check prüft hier maschinell, was everydeck nicht prüfen kann, weil everydeck das Repo nicht sieht:
  1. Form (JSON-Schema) und Verweise (Tabellen, Spalten, Funktionen, Komponenten, Abläufe, Checkliste genau einmal je Baustein).
  2. Jede Fundstelle: die Datei existiert, die Zeile existiert, und das Genannte (Symbol, Spalte, Statuswert, Muster, Paket) steht dort
     (in der Zeile selbst oder höchstens drei Zeilen daneben). Ohne Beleg oder mit falschem Beleg wird der Befund abgelehnt – mit der Stelle.
  3. Vollständigkeit gegen das Repo: jede im Repo erkannte Tabelle/Collection, jede erkannte Route und jedes erkannte Anbieterpaket muss im
     Befund stehen (tables[], screens[]/api_routes[], components[]) – sonst Ablehnung mit dem Namen und der Fundstelle. Nichts fällt still weg.
Keine Wortlisten über die App: was eine Tabelle bedeutet, entscheidet everydeck aus den Belegen (Anzeigestelle, Setzstelle, Fremdschlüssel).
"""
from __future__ import annotations

import json
import re
from importlib import resources
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from .detect import DRIZZLE_TABLE, FIRESTORE_CALL, FIRESTORE_RULE, NPM, PRISMA_MODEL, PY, SKIP_DIRS, SQLALCHEMY_TABLE, SQL_CREATE, SQL_DROP, SQL_RENAME, _supabase_tables
from .reads import frontend_mentions

BLOCKS = ["login", "people_roles", "organizations", "content_status", "moderation", "chats", "uploads", "search", "payments", "email", "push", "ai", "jobs", "imports", "bookings", "settings", "platforms"]
LINE_SLACK = 3
ROUTE_JS = re.compile(r"""\b(?:app|router|server|fastify|api)\.(get|post|put|patch|delete)\(\s*['"`](/[^'"`\s]*)['"`]""")
ROUTE_PY = re.compile(r"""@(?:app|router|api|[a-z_]+_router)\.(get|post|put|patch|delete)\(\s*['"](/[^'"\s]*)['"]""")
PROVIDER_NAMES = {k.rstrip("*") for k in list(NPM) + list(PY) if not k.startswith("@") or k.endswith("*")}
ALEMBIC_OP = re.compile(r"""\bop\.(create_table|drop_table)\(\s*['"]([A-Za-z_]\w*)['"]|\bop\.(execute)\(\s*(?:f?r?(?:\"\"\"|'''|"|'))\s*drop\s+table\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?""", re.I)


def _schema() -> dict[str, Any]:
    with resources.files("everydeck_check").joinpath("schemas/befund.schema.json").open("r", encoding="utf-8") as f:
        return json.load(f)


def is_befund(doc: Any) -> bool:
    return isinstance(doc, dict) and doc.get("schema_version") == "1.12-r0" and "tables" in doc and "checklist" in doc


def schema_errors(b: dict[str, Any]) -> list[str]:
    v = Draft202012Validator(_schema(), format_checker=FormatChecker())
    out = []
    for err in sorted(v.iter_errors(b), key=lambda e: list(e.path)):
        where = "/".join(str(p) for p in err.path) or "(root)"
        if err.validator in ("minItems", "maxItems"):
            out.append(f"{where}: needs {'at least' if err.validator == 'minItems' else 'at most'} {err.validator_value} entries (has {len(err.instance)})")
        else:
            out.append(f"{where}: {err.message[:200]}")
    return out[:30]


def reference_errors(b: dict[str, Any]) -> list[str]:
    """Spiegel von befundReferenceErrors (packages/contracts): dieselben Meldungen, lokal vor dem Einreichen."""
    errs: list[str] = []
    tables = {t["name"]: t for t in b.get("tables", [])}
    funcs = b.get("functions", []) or []

    def fn_ref(ref: str, what: str) -> None:
        # B31 Abnahme (N2): eine Funktion ist Name + Datei – Verweis über den Namen, bei Mehrdeutigkeit <path>#<name>
        if "#" in ref:
            if not any(f"{f['evidence']['path']}#{f['name']}" == ref for f in funcs): errs.append(f"{what}: function {ref} is not in functions")
            return
        n = sum(1 for f in funcs if f["name"] == ref)
        if n == 0: errs.append(f"{what}: function {ref} is not in functions")
        elif n > 1: errs.append(f"{what}: function {ref} is ambiguous – name it as <path>#{ref}")
    comps = {c["id"] for c in b.get("components", []) or []}
    flows = {f["id"] for f in b.get("flows", [])}

    def col(t: str, c: str | None, at: str) -> None:
        if c and t in tables and not any(x["name"] == c for x in tables[t]["columns"]):
            errs.append(f"{at}: column {c} is not in table {t}")

    names = [t["name"] for t in b.get("tables", [])]
    for i, t in enumerate(b.get("tables", [])):
        at = f"tables[{i}] {t['name']}"
        if names.count(t["name"]) > 1: errs.append(f"{at}: duplicate table")
        for j, c in enumerate(t["columns"]):
            if c.get("fk") and c["fk"]["table"] not in tables and c["fk"]["table"] != (b.get("identity") or {}).get("auth_table"): errs.append(f"{at}.columns[{j}] {c['name']}: fk table {c['fk']['table']} is not in the Befund")
            if c.get("external_id") and c["external_id"]["component"] not in comps: errs.append(f"{at}.columns[{j}] {c['name']}: external_id component {c['external_id']['component']} is not in components")
        if t.get("status_column"):
            col(t["name"], t["status_column"], f"{at}.status_column")
            if not t.get("statuses"): errs.append(f"{at}: status_column needs statuses[] (each value with its evidence)")
        if t.get("statuses") and not t.get("status_column"): errs.append(f"{at}: statuses[] needs status_column")
        col(t["name"], t.get("owner_column"), f"{at}.owner_column")
        for s in t.get("statuses", []) or []:
            for sb in s.get("set_by", []) or []:
                fn_ref(sb["function"], f"{at} status {s['value']}: set_by")
    fkeys = [f"{f['evidence']['path']}#{f['name']}" for f in funcs]
    for i, f in enumerate(funcs):
        at = f"functions[{i}] {f['name']}"
        if fkeys.count(fkeys[i]) > 1: errs.append(f"{at}: duplicate function (same name in {f['evidence']['path']})")
        if f.get("requires", {}).get("kind") == "role" and not _roles(f["requires"]): errs.append(f"{at}: requires.kind role needs the role as the code names it")
        for ch in f.get("changes", []) or []:
            if ch["table"] not in tables: errs.append(f"{at}: changes table {ch['table']} is not in the Befund")
            col(ch["table"], ch.get("column"), f"{at}.changes")
            if "to" in ch and not ch.get("column"): errs.append(f"{at}: changes.to needs column")
        if f.get("provider_call") and f["provider_call"]["component"] not in comps: errs.append(f"{at}: provider_call component {f['provider_call']['component']} is not in components")
    fids = [f["id"] for f in b.get("flows", [])]
    for i, f in enumerate(b.get("flows", [])):
        at = f"flows[{i}] {f['id']}"
        if fids.count(f["id"]) > 1: errs.append(f"{at}: duplicate flow")
        w = f["result"].get("write")
        if w and w["table"] not in tables: errs.append(f"{at}: result.write table {w['table']} is not in the Befund")
        if f["result"].get("provider") and f["result"]["provider"] not in comps: errs.append(f"{at}: result.provider {f['result']['provider']} is not in components")
        ends = {f"end:{e['id']}" for e in f.get("ends", []) or []}
        for s in f.get("signals", []) or []:
            if s["step"].startswith("end:") and s["step"] not in ends: errs.append(f"{at}: signal step {s['step']} names no end")
    ident = b.get("identity")
    if ident:
        if ident.get("table") and ident["table"] not in tables: errs.append(f"identity.table {ident['table']} is not in the Befund")
        for k, v in (ident.get("fields") or {}).items():
            if ident.get("table") and v: col(ident["table"], v["column"], f"identity.fields.{k}")
        if ident.get("suspend") and ident.get("table"): col(ident["table"], ident["suspend"]["column"], "identity.suspend")
        for s in (ident.get("suspend", {}).get("set_true_by"), ident.get("suspend", {}).get("set_false_by")):
            if s: fn_ref(s, "identity.suspend")
        for m in ident.get("memberships", []) or []:
            if m["table"] not in tables: errs.append(f"identity.memberships: table {m['table']} is not in the Befund")
            if m["org_table"] not in tables: errs.append(f"identity.memberships: org_table {m['org_table']} is not in the Befund")
    for k in ("email", "push"):
        ch = (b.get("channels") or {}).get(k)
        if ch and ch["component"] not in comps: errs.append(f"channels.{k}: component {ch['component']} is not in components")
    pay = b.get("payments")
    if pay:
        if pay["component"] not in comps: errs.append(f"payments.component {pay['component']} is not in components")
        for e in pay.get("events", []) or []:
            if e.get("sets"):
                if e["sets"]["table"] not in tables: errs.append(f"payments.events {e['event']}: table {e['sets']['table']} is not in the Befund")
                col(e["sets"]["table"], e["sets"].get("column"), f"payments.events {e['event']}")
    seen: set[str] = set()
    for e in b.get("checklist", []):
        if e["block"] in seen: errs.append(f"checklist: block {e['block']} appears twice")
        seen.add(e["block"])
        has = bool(e.get("evidence") or e.get("tables") or e.get("flows") or e.get("functions"))
        if e["present"] and not has: errs.append(f"checklist {e['block']}: present needs evidence (or tables/flows/functions)")
        if not e["present"] and has: errs.append(f"checklist {e['block']}: not present must carry no evidence")
        for t in e.get("tables", []) or []:
            if t not in tables: errs.append(f"checklist {e['block']}: table {t} is not in the Befund")
        for f in e.get("flows", []) or []:
            if f not in flows: errs.append(f"checklist {e['block']}: flow {f} is not in the Befund")
        for f in e.get("functions", []) or []:
            fn_ref(f, f"checklist {e['block']}")
    for blk in BLOCKS:
        if blk not in seen: errs.append(f"checklist: block {blk} is missing – answer every block with present true (evidence) or false")
    # B31: everydeck_tables – Tabellen, die die everydeck-Installation angelegt hat; jede muss im Befund stehen
    for i, y in enumerate(b.get("everydeck_tables") or []):
        if y["table"] not in {t["name"] for t in b.get("tables", [])}: errs.append(f"everydeck_tables[{i}] {y['table']}: table {y['table']} is not in the Befund")
    # B37: eine beschriebene Seite nennt nur Tabellen und Abläufe des Befunds (Spiegel von befundReferenceErrors)
    for i, sc in enumerate(b.get("screens") or []):
        d = sc.get("described")
        if not d: continue
        at = f"screens[{i}] {sc['pattern']}.described"
        for t in d.get("works_with", []):
            if t not in tables: errs.append(f"{at}: table {t} is not in the Befund")
        for f in d.get("flows", []):
            if f not in flows: errs.append(f"{at}: flow {f} is not in flows")
    # B29 vierte Runde: works_with – womit die Nutzer arbeiten; jede Tabelle einmal, part_of eine andere Tabelle des Befunds
    ww = b.get("works_with") or []
    for i, w in enumerate(ww):
        at = f"works_with[{i}] {w['table']}"
        if w["table"] not in tables: errs.append(f"{at}: table {w['table']} is not in the Befund")
        if sum(1 for x in ww if x["table"] == w["table"]) > 1: errs.append(f"{at}: listed twice")
        if w.get("part_of") and w["part_of"] not in tables: errs.append(f"{at}: part_of {w['part_of']} is not in the Befund")
        if w.get("part_of") == w["table"]: errs.append(f"{at}: part_of names the table itself")
    if not any((s.get("step") == "result") for f in b.get("flows", []) for s in (f.get("signals") or [])):
        errs.append("flows: at least one flow needs a result signal (the code that reports the result to everydeck, with evidence)")
    return errs


# ── Fundstellen: Datei, Zeile, Symbol ──
class _Files:
    def __init__(self, repo: Path) -> None:
        self.repo = repo; self.cache: dict[str, list[str] | None] = {}
        self.functions: dict[str, list[dict[str, Any]] | str] = {}   # B32 (A4): Funktionen je Datei aus dem Syntaxbaum

    def lines(self, rel: str) -> list[str] | None:
        if rel not in self.cache:
            p = self.repo / rel
            try:
                self.cache[rel] = p.read_text(encoding="utf-8", errors="replace").splitlines() if p.is_file() else None
            except OSError:
                self.cache[rel] = None
        return self.cache[rel]


# B31 Schnitt D: Fundstelle „database“ (das Schema aus der Datenbank) – geprüft nur mit `--db`, gegen den Katalog
DB_TABLES: set[str] | None = None


def _roles(req: dict[str, Any]) -> list[str]:
    r = req.get("role")
    return [] if r is None else list(r) if isinstance(r, list) else [r]


def _check_evidence(files: _Files, ev: dict[str, Any], at: str, expect: list[str], errs: list[str]) -> None:
    """Datei da, Zeile da, und mindestens eines der erwarteten Wörter steht in der Zeile ± LINE_SLACK."""
    rel = ev["path"]; ln = int(ev["line"])
    if rel == "database":
        if DB_TABLES is None: errs.append(f"{at}: evidence from the database – run everydeck-check validate with --db <url> (the read role is enough) to confirm it"); return
        sym = str(ev.get("symbol") or "")
        name = sym.split(" ")[-1]; tbl = name.split(".")[0] if name.count(".") == 1 and not name.startswith("public.") and name.split(".")[0] not in {t.split(".")[0] for t in DB_TABLES} else name
        if sym.startswith("function ") or sym.startswith("trigger "): return   # Funktionen und Trigger: im Katalog gelesen, die Tabelle prüft der Vergleich
        if not any(t == name or t.endswith("." + name) or t == "public." + name or t.split(".")[-1] == tbl.split(".")[-1] for t in DB_TABLES): errs.append(f"{at}: {sym} is not in the database")
        return
    lines = files.lines(rel)
    if lines is None: errs.append(f"{at}: file {rel} does not exist"); return
    if ln > len(lines): errs.append(f"{at}: {rel} has {len(lines)} lines, evidence names line {ln}"); return
    words = [w for w in ([ev.get("symbol")] + expect) if w]
    if not words: return
    lo = max(0, ln - 1 - LINE_SLACK); hi = min(len(lines), ln + LINE_SLACK)
    window = "\n".join(lines[lo:hi])
    missing = [w for w in words if w not in window]
    if ev.get("symbol"):   # das Symbol ist der Anker: in der Zeile ± 3, oder die Zeile liegt im Körper genau dieser Funktion (nächste Definition darüber)
        if ev["symbol"] not in missing: return
        chain = _enclosing_chain(files, rel, ln)
        if isinstance(chain, str): errs.append(f"{at}: {rel}:{ln} – cannot read the functions of {rel}: {chain}"); return
        # B32 (A4): die Zeile liegt im Körper der genannten Funktion (oder einer, die sie umschließt) – Name oder Klasse.Methode
        if any(ev["symbol"] in (f["name"], f["qualified"]) for f in chain): return
        owner = chain[-1]["qualified"] if chain else None
        errs.append(f"{at}: {rel}:{ln} is not inside {ev['symbol']} ({'inside ' + owner if owner else 'no definition around it'}; ±{LINE_SLACK} lines checked too)")
        return
    if expect and all(w in missing for w in expect): errs.append(f"{at}: {rel}:{ln} does not mention {' / '.join(expect[:3])} (±{LINE_SLACK} lines)")


PY_FILE = re.compile(r"\.pyi?$")
JS_FILE = re.compile(r"\.(?:[cm]?[jt]sx?|vue|svelte)$")


def _py_functions(text: str) -> list[dict[str, Any]] | str:
    """B32 (A4): Funktionen und Klassen einer Python-Datei mit Zeilenbereich (Dekoratoren gehören dazu), aus `ast`."""
    import ast
    try: tree = ast.parse(text)
    except SyntaxError as e: return f"syntax error at line {e.lineno}"
    out: list[dict[str, Any]] = []

    def visit(node: ast.AST, chain: list[str]) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                q = chain + [child.name]
                start = min([child.lineno] + [d.lineno for d in child.decorator_list])
                out.append({"name": child.name, "qualified": ".".join(q), "start": start, "end": child.end_lineno or child.lineno})
                visit(child, q)
            else:
                visit(child, chain)
    visit(tree, [])
    return out


def _enclosing_chain(files: "_Files", rel: str, ln: int) -> list[dict[str, Any]] | str:
    """Die Funktionen, deren Zeilenbereich die Zeile enthält, von außen nach innen – aus dem Syntaxbaum (Python `ast`, TS/JS über die
    TypeScript-Compiler-API der App, packages/domain source-functions.ts). Andere Dateien (SQL, …): die nächste Definition darüber."""
    if rel not in files.functions:
        if PY_FILE.search(rel): files.functions[rel] = _py_functions("\n".join(files.lines(rel) or []))
        elif JS_FILE.search(rel):
            from .rules import RulesUnavailable, run_rule
            try: r = run_rule("functions", {"repo": str(files.repo), "paths": [rel]})["files"][rel]
            except RulesUnavailable as e: r = {"error": str(e)}
            files.functions[rel] = r["error"] if isinstance(r, dict) else r
        else:
            owner = _enclosing_definition(files.lines(rel) or [], ln)
            return [{"name": owner, "qualified": owner}] if owner else []
    fns = files.functions[rel]
    if isinstance(fns, str): return fns
    return sorted((f for f in fns if f["start"] <= ln <= f["end"]), key=lambda f: (f["start"], -f["end"]))


DEF_LINE = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|def\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function|useCallback|onCall|onRequest)|(\w+)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*(?:=>|\{))")


def _enclosing_definition(lines: list[str], ln: int, span: int = 600) -> str | None:
    """Nur noch für Dateien ohne Parser (SQL u. a.): Name der nächsten Funktions-/Klassendefinition über der Zeile."""
    for k in range(ln - 1, max(-1, ln - 1 - span), -1):
        m = DEF_LINE.match(lines[k])
        if m:
            return next(g for g in m.groups() if g)
    return None


PATH_LITERAL = re.compile(r"""(['"`])((?:(?!\1).)*?)\1""")


def _client_path(raw: str) -> tuple[str, bool] | None:
    """→ (Pfadmuster, hat eine Basis): ${…} wird :p; eine führende Basis (${API_BASE}, http://host) fällt weg und erlaubt, dass die Route länger ist als der Pfad."""
    s = re.sub(r"\$\{[^}]*\}", ":p", raw)
    base = bool(re.match(r"^:p/|^https?://", s))
    s = re.sub(r"^:p(?=/)", "", s); s = re.sub(r"^https?://[^/]*", "", s); s = re.sub(r"[?#].*$", "", s); s = re.sub(r"([^/]):p", r"\1", s)   # `/guests${qs}` → /guests
    return (_pattern(s), base) if s.startswith("/") else None


def _route_matches(route: str, client: str, base: bool = False) -> bool:
    rs = [x for x in route.split("/") if x]; cs = [x for x in client.split("/") if x]
    if not rs or (len(rs) > len(cs) and not base): return False
    off_c = max(0, len(cs) - len(rs)); off_r = max(0, len(rs) - len(cs))   # am Ende ausgerichtet: Proxy-Präfix im Client oder Präfix in der Basis
    literal = 0
    for i in range(min(len(rs), len(cs))):
        r = rs[off_r + i]; c = cs[off_c + i]
        if r == "*": return True
        if r.startswith(":"): continue
        if c != r: return False
        literal += 1
    return off_c + off_r == 0 or literal > 0


def _route_in_window(lines: list[str], ln: int, route: str) -> bool:
    from .reads import path_strings
    lo = max(0, ln - 1 - LINE_SLACK); hi = min(len(lines), ln + LINE_SLACK)
    window = "\n".join(lines[lo:hi])
    for raw in path_strings(window):   # Zeichenketten, Vorlagen (auch verschachtelt, ${…} → :p) und Verkettungen
        p = _client_path(raw)
        if p and _route_matches(route, p[0], p[1]): return True
    return False


def _is_backend(rel: str) -> bool:
    from .reads import BACKEND_DIR as _BD
    return bool(_BD.search(rel)) and not rel.endswith((".html", ".tsx", ".jsx", ".vue", ".svelte"))


def evidence_errors(b: dict[str, Any], repo: Path) -> list[str]:
    errs: list[str] = []; files = _Files(repo)
    for i, c in enumerate(b.get("components", []) or []):
        _check_evidence(files, c["evidence"], f"components[{i}] {c['id']}", [c["package"]], errs)
        if c.get("call"): _check_evidence(files, c["call"], f"components[{i}] {c['id']}.call", [], errs)
    for i, p in enumerate(b.get("platforms", []) or []):
        _check_evidence(files, p["evidence"], f"platforms[{i}] {p['id']}", [], errs)
        for k in ("version",):
            if p.get(k): _check_evidence(files, p[k], f"platforms[{i}] {p['id']}.{k}", [], errs)
        if p.get("store"): _check_evidence(files, p["store"]["evidence"], f"platforms[{i}] {p['id']}.store", [], errs)
    for i, s in enumerate(b.get("screens", []) or []):
        _check_evidence(files, s["evidence"], f"screens[{i}] {s['pattern']}", [], errs)
    for i, r in enumerate(b.get("api_routes", []) or []):
        _check_evidence(files, r["evidence"], f"api_routes[{i}] {r['pattern']}", [], errs)
    ident = b.get("identity")
    if ident:
        _check_evidence(files, ident["evidence"], "identity", [], errs)
        for k, v in (ident.get("fields") or {}).items():
            if v: _check_evidence(files, v["evidence"], f"identity.fields.{k}", [v["column"]], errs)
        if ident.get("suspend"): _check_evidence(files, ident["suspend"]["checked"], "identity.suspend.checked", [ident["suspend"]["column"]], errs)
        for j, m in enumerate(ident.get("memberships", []) or []): _check_evidence(files, m["evidence"], f"identity.memberships[{j}]", [m["table"]], errs)
    # B29 vierte Runde: die Fundstelle der Beschreibung „womit die Nutzer arbeiten“ liegt in der Oberfläche und nennt die Tabelle – oder sie fällt mit einer
    # Anzeigestelle der Tabelle zusammen (z. B. ein Routenaufruf, dessen Handler die Tabelle liefert, oder ein sichtbares Element mit Beschriftung)
    tables_by_name = {t["name"]: t for t in b.get("tables", [])}
    for i, w in enumerate(b.get("works_with") or []):
        at = f"works_with[{i}] {w['table']}"; ev = w["evidence"]; t = tables_by_name.get(w["table"])
        shown_near = t is not None and any(sh["path"] == ev["path"] and abs(int(sh["line"]) - int(ev["line"])) <= LINE_SLACK for sh in list(t.get("shown") or []) + [sh for c in t["columns"] for sh in (c.get("shown") or [])])
        probe: list[str] = []
        _check_evidence(files, ev, at, [w["table"]], probe)
        if probe and not (shown_near and files.lines(ev["path"]) is not None and int(ev["line"]) <= len(files.lines(ev["path"]) or [])): errs.append(probe[0] + " – name the place in the UI (page or component) that shows the table, or a place that carries a display location of it")
        elif not probe and _is_backend(ev["path"]): errs.append(f"{at}: {ev['path']} is no UI file (backend folder) – works_with names the page or component where the users see, create or edit it")
    for i, y in enumerate(b.get("everydeck_tables") or []): _check_evidence(files, y["evidence"], f"everydeck_tables[{i}] {y['table']}", [y["table"]], errs)
    for i, pc in enumerate((b.get("app") or {}).get("production_in_code") or []): _check_evidence(files, pc["evidence"], f"app.production_in_code[{i}] {pc['kind']}", [], errs)
    ic = (b.get("app") or {}).get("icon")
    if ic:   # B38: das Icon, das die App ausliefert – Datei da, Inhalt = Prüfsumme, die Fundstelle nennt die Datei (oder ist sie selbst)
        import hashlib, base64
        f = repo / ic["file"]
        if not f.is_file(): errs.append(f"app.icon: file {ic['file']} does not exist")
        else:
            raw = f.read_bytes()
            if hashlib.sha256(raw).hexdigest() != ic["sha256"]: errs.append(f"app.icon: sha256 of {ic['file']} does not match")
            if ic.get("data") and base64.b64decode(ic["data"]) != raw: errs.append(f"app.icon: data is not the content of {ic['file']}")
        if ic["evidence"]["path"] != ic["file"]: _check_evidence(files, ic["evidence"], "app.icon", [Path(ic["file"]).name], errs)
    for i, t in enumerate(b.get("tables", [])):
        at = f"tables[{i}] {t['name']}"
        _check_evidence(files, t["defined"], at + ".defined", [t["name"]], errs)
        for j, c in enumerate(t["columns"]):
            for k, sh in enumerate(c.get("shown", []) or []): _check_evidence(files, sh, f"{at}.columns[{j}] {c['name']}.shown[{k}]", [c["name"]] + ([sh["label"]] if sh.get("label") else []), errs)
            for k, ev in enumerate(c.get("enum", []) or []): _check_evidence(files, ev["evidence"], f"{at}.columns[{j}] {c['name']}.enum[{k}]", [ev["value"]], errs)
            for k, vl in enumerate(c.get("value_labels", []) or []): _check_evidence(files, vl["evidence"], f"{at}.columns[{j}] {c['name']}.value_labels[{k}] {vl['value']}", [vl["label"]], errs)   # B35: der Text steht an der Fundstelle (Code oder Übersetzungsdatei)
            if c.get("computed"): _check_evidence(files, c["computed"], f"{at}.columns[{j}] {c['name']}.computed", [c["name"]], errs)
            if c.get("updated"): _check_evidence(files, c["updated"], f"{at}.columns[{j}] {c['name']}.updated", [c["name"], t["name"]], errs)   # Trigger nennt die Tabelle, onupdate die Spalte
            if c.get("external_id"): _check_evidence(files, c["external_id"]["evidence"], f"{at}.columns[{j}] {c['name']}.external_id", [c["name"]], errs)
            for k, ev in enumerate(c.get("written", []) or []): _check_evidence(files, ev, f"{at}.columns[{j}] {c['name']}.written[{k}]", [c["name"]], errs)   # B31 E1: die Setzstelle nennt die Spalte
        for j, s in enumerate(t.get("statuses", []) or []):
            _check_evidence(files, s["evidence"], f"{at}.statuses[{j}] {s['value']}", [s["value"]], errs)
            for k, sh in enumerate(s.get("shown", []) or []): _check_evidence(files, sh, f"{at}.statuses[{j}] {s['value']}.shown[{k}]", [s["value"]] + ([sh["label"]] if sh.get("label") else []), errs)
            if s.get("public"): _check_evidence(files, s["public"], f"{at}.statuses[{j}] {s['value']}.public", [s["value"]], errs)
        for k, sh in enumerate(t.get("shown", []) or []):
            if sh.get("element") == "data" and sh.get("symbol", "").startswith("/"):   # Routenmuster: ein Pfadliteral in der Zeile ± 3 muss darauf passen (auch `${API_BASE}/persons/${id}`)
                lines = files.lines(sh["path"])
                if lines is None: errs.append(f"{at}.shown[{k}]: file {sh['path']} does not exist")
                elif int(sh["line"]) > len(lines): errs.append(f"{at}.shown[{k}]: {sh['path']} has {len(lines)} lines, evidence names line {sh['line']}")
                elif not _route_in_window(lines, int(sh["line"]), sh["symbol"]): errs.append(f"{at}.shown[{k}]: {sh['path']}:{sh['line']} holds no request path that matches route {sh['symbol']} (±{LINE_SLACK} lines)")
            else:
                _check_evidence(files, sh, f"{at}.shown[{k}]", ([sh["label"]] if sh.get("label") else []) + ([t["name"]] if sh.get("element") == "data" and not sh.get("symbol") else []), errs)
        for k, ns in enumerate(t.get("not_shown", []) or []): _check_evidence(files, ns, f"{at}.not_shown[{k}]", [t["name"]], errs)
        for k, w in enumerate(t.get("writes", []) or []): _check_evidence(files, w["evidence"], f"{at}.writes[{k}]", [t["name"]], errs)
        if t.get("bridge"):
            _check_evidence(files, t["bridge"]["evidence"], f"{at}.bridge", [], errs)
            if not (repo / t["bridge"]["test"]["path"]).is_file(): errs.append(f"{at}.bridge.test: {t['bridge']['test']['path']} does not exist")
    for i, f in enumerate(b.get("functions", [])):
        at = f"functions[{i}] {f['name']}"
        _check_evidence(files, f["evidence"], at, [f["name"]], errs)
        if f.get("requires"):   # B31 Abnahme (A6): jede genannte Rolle steht an der Fundstelle
            for role in (_roles(f["requires"]) or [None]): _check_evidence(files, f["requires"]["evidence"], at + ".requires", [role] if role else [], errs)
        for j, ch in enumerate(f.get("changes", []) or []):
            if ch.get("evidence"): _check_evidence(files, ch["evidence"], f"{at}.changes[{j}]", [x for x in (ch.get("to"), ch.get("column"), ch["table"]) if x], errs)
        if f.get("provider_call"): _check_evidence(files, f["provider_call"]["evidence"], at + ".provider_call", [], errs)
    for i, f in enumerate(b.get("flows", [])):
        at = f"flows[{i}] {f['id']}"
        _check_evidence(files, f["start"], at + ".start", [], errs)
        _check_evidence(files, f["result"]["evidence"], at + ".result", [], errs)
        if f.get("failure"): _check_evidence(files, f["failure"], at + ".failure", [], errs)
        for j, e in enumerate(f.get("ends", []) or []): _check_evidence(files, e["evidence"], f"{at}.ends[{j}]", [], errs)
        for j, s in enumerate(f.get("signals", []) or []): _check_evidence(files, s["evidence"], f"{at}.signals[{j}] {s['name']}", [s["name"]], errs)
    for k in ("email", "push"):
        ch = (b.get("channels") or {}).get(k)
        if ch:
            _check_evidence(files, ch["evidence"], f"channels.{k}", [], errs)
            if ch.get("register"): _check_evidence(files, ch["register"], f"channels.{k}.register", [], errs)
    for i, j in enumerate(b.get("jobs", []) or []):
        _check_evidence(files, j["evidence"], f"jobs[{i}] {j['id']}", [], errs)
        _check_evidence(files, j["every"]["evidence"], f"jobs[{i}] {j['id']}.every", [j["every"]["expression"]], errs)
    pay = b.get("payments")
    if pay:
        _check_evidence(files, pay["evidence"], "payments", [], errs)
        for i, e in enumerate(pay.get("events", []) or []): _check_evidence(files, e["evidence"], f"payments.events[{i}] {e['event']}", [e["event"]], errs)
    for i, a in enumerate(b.get("adapters", []) or []): _check_evidence(files, a["evidence"], f"adapters[{i}] {a['kind']}", [] if a["kind"] == "read_bridge" else [a["package"]], errs)   # eine eigene Lese-Bridge hat kein Paket
    for e in b.get("checklist", []):
        for j, ev in enumerate(e.get("evidence", []) or []): _check_evidence(files, ev, f"checklist {e['block']}.evidence[{j}]", [], errs)
    return errs


# ── Vollständigkeit gegen das Repo ──
def _files_of(repo: Path, suffixes: set[str]):
    for p in sorted(repo.rglob("*")):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file() or p.suffix not in suffixes or p.stat().st_size > 2_000_000:
            continue
        try:
            yield rel, p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue


def _upgrade_body(text: str) -> str:
    m = re.search(r"\ndef upgrade\b[^\n]*\n", text)
    if not m: return text
    rest = text[m.end():]; end = re.search(r"\n(?=def |class )", rest)
    return rest[:end.start()] if end else rest


def detect_tables(repo: Path) -> dict[str, str]:
    """Alle Tabellen-/Collection-Namen mit erster Fundstelle (nicht nur je Baustein die erste wie detect_schema)."""
    found: dict[str, str] = {}
    for rel, text in _files_of(repo, {".sql", ".prisma", ".rules", ".py", ".ts", ".tsx", ".js", ".mjs", ".cjs"}):
        def add(name: str, kind: str) -> None:
            if name not in found: found[name] = f"{kind} {name} in {rel}"
        suf = rel.suffix
        if suf == ".sql":   # Endzustand des Schemas: Migrationen in Dateireihenfolge, DROP TABLE entfernt (B29 Abnahme)
            for n in SQL_CREATE.findall(text): add(n, "table")
            for n in SQL_DROP.findall(text): found.pop(n, None)
            for old, new in SQL_RENAME.findall(text):   # B36: umbenannt – der neue Name steht in dieser Datei
                if found.pop(old, None) is not None: add(new, "table")
        elif suf == ".prisma":
            for a, c in PRISMA_MODEL.findall(text): add(a or c, "model")
        elif suf == ".rules":
            for n in FIRESTORE_RULE.findall(text):
                if n not in ("databases", "documents"): add(n, "collection")
        elif suf == ".py":
            for n in SQLALCHEMY_TABLE.findall(text): add(n, "table")
            # Alembic: op.create_table("x") / op.drop_table("x") in der Reihenfolge der Datei – wie das Gerüst (B29 vierte Runde; vorher fehlten solche Tabellen in der Vollständigkeitsprüfung)
            for m in ALEMBIC_OP.finditer(_upgrade_body(text)):   # nur upgrade(); downgrade() nimmt alles zurück
                if m.group(1) == "create_table": add(m.group(2), "table")
                else: found.pop(m.group(2) or m.group(4), None)   # op.drop_table("x") oder op.execute("DROP TABLE x")
        else:
            for n in DRIZZLE_TABLE.findall(text): add(n, "table")
            if "Tables:" in text:
                for n in _supabase_tables(text): add(n, "table")
            for n in FIRESTORE_CALL.findall(text): add(n, "collection")
    return found


def detect_routes(repo: Path) -> dict[str, str]:
    """API-Pfade der App: Express/Fastify/Hono-Aufrufe, FastAPI-Dekoratoren, Next.js app/api/**/route.ts."""
    found: dict[str, str] = {}
    for rel, text in _files_of(repo, {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}):
        parts = rel.parts
        if rel.suffix == ".py":
            for m, path in ROUTE_PY.findall(text): found.setdefault(_pattern(path), f"{m.upper()} {path} in {rel}")
        else:
            for m, path in ROUTE_JS.findall(text):
                if "${" in path: continue   # Vorlagenstrings sind Client-Aufrufe, keine Routen
                found.setdefault(_pattern(path), f"{m.upper()} {path} in {rel}")
            if "api" in parts and rel.name in ("route.ts", "route.js"):
                i = parts.index("api"); seg = "/" + "/".join(parts[i:-1])
                found.setdefault(_pattern(seg), f"route file {rel}")
    return found


def _pattern(path: str) -> str:
    p = re.sub(r"\[\.\.\.[^\]]+\]", "*", path); p = re.sub(r"\[([^\]]+)\]", r":\1", p); p = re.sub(r"\{(\w+):path\}", "*", p); p = re.sub(r"\{(\w+)(?::[^}]*)?\}", r":\1", p)
    p = re.sub(r"\((?:[^)]*)\)/?", "", p)   # Route-Gruppen
    return p.rstrip("/") or "/"


def detect_providers(repo: Path) -> dict[str, str]:
    """Anbieterpakete aus package.json (auch Unterordner) und requirements/pyproject – die everydeck-check kennt (NPM/PY-Tabellen)."""
    found: dict[str, str] = {}
    for rel, text in _files_of(repo, {".json", ".txt", ".toml"}):
        if rel.name == "package.json":
            try: pkg = json.loads(text)
            except json.JSONDecodeError: continue
            for dep in list((pkg.get("dependencies") or {}).keys()) + list((pkg.get("devDependencies") or {}).keys()):
                if _known_npm(dep): found.setdefault(dep, f"{dep} in {rel}")
        elif rel.name.startswith("requirements") and rel.suffix == ".txt":
            for line in text.splitlines():
                name = re.split(r"[=<>!\[ ;#]", line.strip(), 1)[0].lower()
                if name and name in PY: found.setdefault(name, f"{name} in {rel}")
        elif rel.name == "pyproject.toml":
            for m in re.finditer(r"""^\s*"?([A-Za-z0-9_.-]+)"?\s*[>=<~!\[]""", text, re.M):
                name = m.group(1).lower()
                if name in PY: found.setdefault(name, f"{name} in {rel}")
    return found


def _known_npm(dep: str) -> bool:
    if dep in NPM: return True
    return any(k.endswith("*") and dep.startswith(k[:-1]) for k in NPM)


BACKEND_DIR = re.compile(r"(^|/)(backend|server|api|functions|supabase|migrations|scripts|prisma|db|database|test|tests|__tests__|e2e|cypress)(/|$)")
FRONTEND_READ = [re.compile(r"""\.from\(\s*['"`]([A-Za-z_]\w*)['"`]"""), re.compile(r"""\bcollection\(\s*(?:[A-Za-z_]\w*\s*,\s*)?['"]([A-Za-z_]\w*)['"]"""), re.compile(r"""\b(?:prisma|db)\.([a-z]\w*)\.(?:find\w*|count|aggregate|groupBy)\(""")]   # .from auch in der Cast-Form .from("x" as never)
HANDLER_READ = FRONTEND_READ + [re.compile(r"""\.table\(\s*['"]([A-Za-z_]\w*)['"]\s*\)"""), re.compile(r"""\bFROM\s+(?:public\.)?"?([A-Za-z_]\w*)"?""", re.I)]
WRITE_CHAIN = re.compile(r"\.(insert|update|delete|upsert)\(")
ROUTE_ANY = re.compile(r"""(?:@(?:app|router|api|[a-z_]+_router)|\b(?:app|router|server|fastify|api))\.(get|post|put|patch|delete)\(\s*['"`](/[^'"`\s]*)['"`]""")
STRING_PATH = re.compile(r"""['"`]((?:https?://[^'"`\s]+|\$\{[^}`]*\})?/[A-Za-z0-9_\-/:${}.]+)['"`]""")   # B32: auch `${API}/api/x` (Basis als Platzhalter, wie im Gerüst)


def _is_frontend(rel: Path) -> bool:
    r = rel.as_posix()
    if BACKEND_DIR.search(r) or re.search(r"\.(test|spec|d)\.[tj]sx?$", r): return False
    return bool(re.search(r"\.(tsx|jsx|vue|svelte)$", r) or (re.search(r"\.(ts|js|mjs)$", r) and re.match(r"^(src|app|pages|components|lib|frontend|client|web)/", r)))


_REACH: dict[str, dict[str, Any]] = {}


def app_reach(repo: Path) -> dict[str, Any]:
    """B32 (O4): Erreichbarkeit vom Einstieg der App – dieselbe Regel wie das Befund-Gerüst (packages/domain reachability.ts, Regel reachable)."""
    key = str(repo.resolve())
    if key not in _REACH:
        from .rules import RulesUnavailable, run_rule
        try: r = run_rule("reachable", {"repo": key})
        except RulesUnavailable as e: r = {"errors": [str(e)]}
        _REACH[key] = r
    return _REACH[key]


def _entries_of(reach: dict[str, Any]) -> str:
    es = [e["path"] for e in reach.get("entries", []) if reach.get("decided")]
    return ", ".join(es[:3]) + (f" and {len(es) - 3} more" if len(es) > 3 else "") if es else "no entry found in the project: every component file"


def reachability_errors(b: dict[str, Any], repo: Path) -> list[str]:
    """B32 (O4): eine Anzeigestelle oder Seite in einer Datei, die kein Einstieg der App erreicht, ist keine; unreachable[] muss stimmen."""
    reach = app_reach(repo)
    if reach.get("errors"): return [f"unreachable: everydeck rules: {e}" for e in reach["errors"]]
    reachable = set(reach.get("reachable", [])); entries = _entries_of(reach)
    from .reads import is_frontend_source
    def unreachable(path: str) -> bool:
        p = repo / path
        return path not in reachable and p.suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte") and p.is_file() and is_frontend_source(path, p.read_text(encoding="utf-8", errors="replace"))
    errs: list[str] = []
    what = "– it is no display location; leave it out (the generator lists the file in unreachable[])"
    for i, t in enumerate(b.get("tables", [])):
        for k, sh in enumerate(t.get("shown") or []):
            if unreachable(sh["path"]): errs.append(f"tables[{i}] {t['name']}.shown[{k}]: {sh['path']} is not reachable from the entry of the app (entries {entries}) {what}")
        for j, c in enumerate(t.get("columns", [])):
            for k, sh in enumerate(c.get("shown") or []):
                if unreachable(sh["path"]): errs.append(f"tables[{i}] {t['name']}.columns[{j}] {c['name']}.shown[{k}]: {sh['path']} is not reachable from the entry of the app (entries {entries}) {what}")
    for i, s in enumerate(b.get("screens") or []):
        if unreachable(s["evidence"]["path"]): errs.append(f"screens[{i}] {s['pattern']}: {s['evidence']['path']} is not reachable from the entry of the app (entries {entries}) – it is no screen; leave it out (the generator lists the file in unreachable[])")
    for i, u in enumerate(b.get("unreachable") or []):
        if u["path"] in reachable: errs.append(f"unreachable[{i}] {u['path']}: the entry of the app reaches this file (entries {entries}) – it is not unreachable")
    return errs


def detect_frontend_reads(repo: Path, tables: set[str]) -> dict[str, str]:
    """B29 Abnahme: jede Tabelle, die das Frontend liest, mit der ersten Fundstelle – direkt (supabase.from, Firestore, ORM) oder über eine API-Route,
    deren Handler sie liest. Eine solche Tabelle braucht eine Anzeigestelle im Befund; sonst gilt sie fälschlich als technische Daten."""
    lower = {t.lower(): t for t in tables}
    key = lambda n: lower.get(n.lower())
    route_tables: dict[str, set[str]] = {}
    for rel, text in _files_of(repo, {".py", ".ts", ".js", ".mjs", ".cjs"}):
        r = rel.as_posix()
        if not (BACKEND_DIR.search(r) or r.endswith(("/route.ts", "/route.js"))) or re.search(r"\.(test|spec|d)\.[tj]sx?$", r): continue
        hits = list(ROUTE_ANY.finditer(text))
        for i, h in enumerate(hits):
            if h.group(1).lower() != "get": continue   # nur Routen, die liefern (GET)
            end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
            if rel.suffix == ".py":   # der Handler endet mit seinem def-Block: die nächste Zeile ohne Einrückung – auch ein weiteres def (B29 vierte Runde)
                d = re.search(r"\n(?:async )?def ", text[h.start():end])
                if d:
                    e2 = re.search(r"\n(?=\S)", text[h.start() + d.start() + 1:end])
                    if e2: end = h.start() + d.start() + 1 + e2.start()
            body = text[h.start():end]
            found = {key(m.group(1)) for re_ in HANDLER_READ for m in re_.finditer(body) if key(m.group(1))}
            if found: route_tables.setdefault(_pattern(h.group(2)), set()).update(found)
    patterns = sorted(route_tables, key=len, reverse=True)
    out: dict[str, str] = {}
    reach = app_reach(repo); reachable = set(reach.get("reachable", [])) if not reach.get("errors") else None
    for rel, text in _files_of(repo, {".tsx", ".jsx", ".vue", ".svelte", ".ts", ".js", ".mjs"}):
        if not _is_frontend(rel): continue
        if reachable is not None and rel.as_posix() not in reachable: continue   # B32 (O4): kein Einstieg der App erreicht die Datei – dort liest die App nichts
        lines = text.split("\n")
        at = lambda pos: f"{rel.as_posix()}:{text.count(chr(10), 0, pos) + 1}"
        for re_ in FRONTEND_READ:
            for m in re_.finditer(text):
                t = key(m.group(1))
                if t and t not in out and not WRITE_CHAIN.search(text[m.end():m.end() + 400].split(";")[0]): out[t] = at(m.start())   # .from('x').insert/update/delete/upsert ist kein Lesen
        for m in STRING_PATH.finditer(text):
            p = _pattern(re.sub(r"([^/]):p", r"\1", re.sub(r"\$\{[^}]*\}", ":p", re.sub(r"^https?://[^/]+", "", m.group(1)))))
            rp = next((x for x in patterns if x == p or p.endswith(x)), None)
            if not rp: continue
            for t in route_tables[rp]:
                if t not in out: out[t] = f"{at(m.start())} (route {rp})"
        del lines
    return out


def completeness_errors(b: dict[str, Any], repo: Path) -> list[str]:
    errs: list[str] = []
    declared_tables = {t["name"] for t in b.get("tables", [])}
    for name, where in detect_tables(repo).items():
        if name not in declared_tables: errs.append(f"tables[]: {where} is not in the Befund – add it with its columns, or it is lost silently")
    # B29 Abnahme: liest das Frontend eine Tabelle, braucht sie eine Anzeigestelle (shown an Tabelle oder Spalte) – sonst Ablehnung
    shown = {t["name"] for t in b.get("tables", []) if t.get("shown") or any(c.get("shown") for c in t.get("columns", []))}
    for name, where in detect_frontend_reads(repo, declared_tables).items():
        if name not in shown: errs.append(f"tables[] {name}: the frontend reads this table at {where} but the Befund has no display location (shown) for it – add the place, or it counts as technical data wrongly")
    # B29 vierte Runde – Gegenprobe, unabhängig von der Erkennung des Gerüsts: jede Nennung einer Tabelle ohne Anzeigestelle in einer Zeichenkette
    # des Frontends braucht einen belegten Grund (not_shown mit Datei und Zeile ± 3); sonst Ablehnung mit der Stelle
    not_shown = {t["name"]: t.get("not_shown") or [] for t in b.get("tables", [])}
    seen_open: set[tuple[str, str]] = set()
    for m in frontend_mentions(repo, declared_tables - shown):
        if any(x["path"] == m["path"] and abs(int(x["line"]) - m["line"]) <= LINE_SLACK for x in not_shown[m["table"]]): continue
        key = (m["table"], f"{m['path']}:{m['line']}")
        if key in seen_open: continue
        seen_open.add(key)
        errs.append(f"tables[] {m['table']}: the frontend names this table at {m['path']}:{m['line']} ({m['text'][:60]!r}) but the Befund has neither a display location (shown) nor a fact about the place (not_shown) for it – add the place with what it is (write, label, route of a write request, module no screen imports)")
    errs += reachability_errors(b, repo)   # B32 (O4)
    errs += exposure_errors(repo)
    declared_routes = {r["pattern"].rstrip("/") or "/" for r in (b.get("api_routes") or [])} | {s["pattern"].rstrip("/") or "/" for s in (b.get("screens") or [])}
    for pat, where in detect_routes(repo).items():   # ein Befund darf das volle Muster tragen (Router-Präfix + include_router-Präfix + Pfad), die Fundstelle hier ist nur der Pfad des Dekorators
        if pat not in declared_routes and not any(d.endswith(pat) and pat != "/" for d in declared_routes): errs.append(f"api_routes[]: {where} is not in the Befund (pattern {pat})")
    declared_pkgs = {c["package"].lower() for c in (b.get("components") or [])}
    for name, where in detect_providers(repo).items():
        if name.lower() not in declared_pkgs: errs.append(f"components[]: {where} is not in the Befund")
    return errs


def exposure_errors(repo: Path) -> list[str]:
    """B29 vierte Runde: das Leser-Schema everydeck_read darf nicht über die Supabase-API erreichbar sein (supabase/config.toml [api] schemas)."""
    errs: list[str] = []
    for cfg in sorted(repo.rglob("config.toml")):
        rel = cfg.relative_to(repo).as_posix()
        if any(part in SKIP_DIRS for part in rel.split("/")) or not rel.endswith("supabase/config.toml") and rel != "config.toml": continue
        try: text = cfg.read_text(encoding="utf-8", errors="replace")
        except OSError: continue
        api = re.search(r"^\[api\]([\s\S]*?)(?=^\[|\Z)", text, re.M)
        if not api: continue
        m = re.search(r"^\s*schemas\s*=\s*\[([^\]]*)\]", api.group(1), re.M)
        if m and re.search(r"""['"]everydeck_read['"]""", m.group(1)):
            ln = text[:api.start(1) + m.start()].count("\n") + 1
            errs.append(f"{rel}:{ln}: schema everydeck_read is exposed through the Supabase API ([api] schemas) – remove it; everydeck reads everydeck_read only through the bridge as everydeck_reader, anon and authenticated must not reach it")
    return errs


def database_tables(url: str) -> set[str]:
    """B31 Schnitt D: Tabellen der App laut Datenbank (schema.name), ohne die Schemata der Plattform – über psql oder psycopg (Leserolle genügt)."""
    import shutil, subprocess
    platform = ['information_schema', 'pg_catalog', 'pg_toast', 'auth', 'storage', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'pgbouncer', 'vault', 'net', 'supabase_functions', 'supabase_migrations', 'cron', 'pgsodium', 'pgsodium_masks', '_analytics', 'topology', 'tiger', 'tiger_data', 'pgtle', 'repack', 'everydeck_read']
    sql = "SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> ALL(ARRAY[" + ",".join(f"'{x}'" for x in platform) + "])"
    try:
        import psycopg  # type: ignore
        with psycopg.connect(url) as conn: return {r[0] for r in conn.execute(sql).fetchall()}
    except ImportError:
        pass
    if not shutil.which("psql"): raise RuntimeError("--db needs psql or the psycopg package")
    out = subprocess.run(["psql", url, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0: raise RuntimeError(f"cannot read the database: {out.stderr.strip().splitlines()[0] if out.stderr.strip() else out.returncode}")
    return {l.strip() for l in out.stdout.splitlines() if l.strip()}


def database_errors(b: dict[str, Any], db: set[str]) -> list[str]:
    """B31 Schnitt D: jede Tabelle der Datenbank steht im Befund (sonst fällt sie still weg); everydeck’s eigene Schemata zählen nicht."""
    declared = {(t.get("schema") or "public") + "." + t["name"] for t in b.get("tables", [])}
    everydeck = {"everydeck", "everydeck_outbox", "everydeck_bridge"}
    return [f"tables[]: {t} is in the database but not in the Befund – add it with its columns (the generator reads it with --db)" for t in sorted(db) if t not in declared and t.split(".")[0] not in everydeck]


def validate_befund(doc: dict[str, Any], repo: Path | None, db: str | None = None) -> list[str]:
    global DB_TABLES
    errs = schema_errors(doc)
    if errs: return errs
    errs = reference_errors(doc)
    # B32: dieselbe Prüfung wie everydeck beim Einreichen (packages/domain checkBefund, gebündelt) – Ableitung und abgeleitetes Manifest eingeschlossen
    if not errs:
        from .rules import befund_rule_errors
        errs = befund_rule_errors(doc)
    if db and not errs:
        try: DB_TABLES = database_tables(db)
        except RuntimeError as e: return [f"--db: {e}"]
        errs += database_errors(doc, DB_TABLES)
    if repo and not errs:
        errs = evidence_errors(doc, repo) + completeness_errors(doc, repo)
    return errs


def drift_manifest(b: dict[str, Any]) -> dict[str, Any]:
    """Für `everydeck-check drift`: die Signale, Seiten, Routen und Jobs des Befunds in der Form, die der Drift-Vergleich kennt (keine Ableitung)."""
    signals = [{"name": s["name"], "capability_id": f["id"], "label": s["name"], "allowed_source": "server", "location": {"path": s["evidence"]["path"], "symbol": s["evidence"].get("symbol") or s["name"], "commit": b["commit"]}}
               for f in b.get("flows", []) for s in (f.get("signals") or [])]
    return {"schema_version": "1.11-r0", "release_key": b.get("release_key", ""), "capabilities": [{"id": f["id"], "label": f["id"], "kind": "flow", "observation": "instrumented" if f.get("signals") else "proposed"} for f in b.get("flows", [])],
            "signals": signals, "rules": [], "diagnostic_fields": [],
            "screens": [{"pattern": s["pattern"]} for s in (b.get("screens") or [])], "api_routes": [{"pattern": r["pattern"], **({"method": r["method"]} if r.get("method") else {})} for r in (b.get("api_routes") or [])],
            "jobs": [{"id": j["id"], "label": j["id"], "every": j["every"]["expression"], "evidence": [{"path": j["evidence"]["path"], "commit": b["commit"]}]} for j in (b.get("jobs") or [])]}
