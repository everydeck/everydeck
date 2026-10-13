"""app map (1.12-r0): the exact technical analysis of an app, facts with places, nothing judged.

everydeck-check checks here mechanically what everydeck cannot check, because everydeck does not see the repo:
  1. Shape (JSON schema) and references (tables, columns, functions, components, flows, checklist exactly once per block).
  2. Every place: the file exists, the line exists, and what is named (symbol, column, status value, pattern, package) is there
     (in the line itself or at most three lines next to it). Without evidence or with wrong evidence the app map is rejected, with the place.
  3. Completeness against the repo: every table/collection, every route and every provider package detected in the repo must be in the
     app map (tables[], screens[]/api_routes[], components[]); otherwise rejection with the name and the place. Nothing silently drops out.
No word lists about the app: what a table means, everydeck decides from the evidence (display location, place that sets it, foreign key).
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
    with resources.files("everydeck_check").joinpath("schemas/app-map.schema.json").open("r", encoding="utf-8") as f:
        return json.load(f)


def is_app_map(doc: Any) -> bool:
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
    """Mirror of the reference check in the contracts: the same messages, locally before submitting."""
    errs: list[str] = []
    tables = {t["name"]: t for t in b.get("tables", [])}
    funcs = b.get("functions", []) or []

    def fn_ref(ref: str, what: str) -> None:
        # a function is name + file; referenced by name, if ambiguous by <path>#<name>
        if "#" in ref:
            if not any(f"{f['evidence']['path']}#{f['name']}" == ref for f in funcs): errs.append(f"{what}: function {ref} is not in functions")
            return
        n = sum(1 for f in funcs if f["name"] == ref)
        if n == 0: errs.append(f"{what}: function {ref} is not in functions")
        elif n > 1: errs.append(f"{what}: function {ref} is ambiguous; name it as <path>#{ref}")
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
            if c.get("fk") and c["fk"]["table"] not in tables and c["fk"]["table"] != (b.get("identity") or {}).get("auth_table"): errs.append(f"{at}.columns[{j}] {c['name']}: fk table {c['fk']['table']} is not in the app map")
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
            if ch["table"] not in tables: errs.append(f"{at}: changes table {ch['table']} is not in the app map")
            col(ch["table"], ch.get("column"), f"{at}.changes")
            if "to" in ch and not ch.get("column"): errs.append(f"{at}: changes.to needs column")
        if f.get("provider_call") and f["provider_call"]["component"] not in comps: errs.append(f"{at}: provider_call component {f['provider_call']['component']} is not in components")
    fids = [f["id"] for f in b.get("flows", [])]
    for i, f in enumerate(b.get("flows", [])):
        at = f"flows[{i}] {f['id']}"
        if fids.count(f["id"]) > 1: errs.append(f"{at}: duplicate flow")
        w = f["result"].get("write")
        if w and w["table"] not in tables: errs.append(f"{at}: result.write table {w['table']} is not in the app map")
        if f["result"].get("provider") and f["result"]["provider"] not in comps: errs.append(f"{at}: result.provider {f['result']['provider']} is not in components")
        ends = {f"end:{e['id']}" for e in f.get("ends", []) or []}
        for s in f.get("signals", []) or []:
            if s["step"].startswith("end:") and s["step"] not in ends: errs.append(f"{at}: signal step {s['step']} names no end")
    money = b.get("money") or {}
    for i, m in enumerate(money.get("tables", []) or []):
        if m["table"] not in tables: errs.append(f"money.tables[{i}] {m['table']}: table {m['table']} is not in the app map")
        for c in m.get("columns", []) or []: col(m["table"], c, f"money.tables[{i}] {m['table']}")
    for i, pv in enumerate(money.get("providers", []) or []):
        if pv.get("component") and pv["component"] not in comps: errs.append(f"money.providers[{i}] {pv['provider']}: component {pv['component']} is not in components")
    cids = [c["id"] for c in b.get("flow_candidates", []) or []]
    for i, c in enumerate(b.get("flow_candidates", []) or []):
        if c.get("table") and c["table"] not in tables: errs.append(f"flow_candidates[{i}] {c['id']}: table {c['table']} is not in the app map")
        if cids.count(c["id"]) > 1: errs.append(f"flow_candidates[{i}] {c['id']}: listed twice")
    ident = b.get("identity")
    if ident:
        if ident.get("table") and ident["table"] not in tables: errs.append(f"identity.table {ident['table']} is not in the app map")
        for k, v in (ident.get("fields") or {}).items():
            if ident.get("table") and v: col(ident["table"], v["column"], f"identity.fields.{k}")
        if ident.get("suspend") and ident.get("table"): col(ident["table"], ident["suspend"]["column"], "identity.suspend")
        for s in (ident.get("suspend", {}).get("set_true_by"), ident.get("suspend", {}).get("set_false_by")):
            if s: fn_ref(s, "identity.suspend")
        for m in ident.get("memberships", []) or []:
            if m["table"] not in tables: errs.append(f"identity.memberships: table {m['table']} is not in the app map")
            if m["org_table"] not in tables: errs.append(f"identity.memberships: org_table {m['org_table']} is not in the app map")
    for k in ("email", "push"):
        ch = (b.get("channels") or {}).get(k)
        if ch and ch["component"] not in comps: errs.append(f"channels.{k}: component {ch['component']} is not in components")
    pay = b.get("payments")
    if pay:
        if pay["component"] not in comps: errs.append(f"payments.component {pay['component']} is not in components")
        for e in pay.get("events", []) or []:
            if e.get("sets"):
                if e["sets"]["table"] not in tables: errs.append(f"payments.events {e['event']}: table {e['sets']['table']} is not in the app map")
                col(e["sets"]["table"], e["sets"].get("column"), f"payments.events {e['event']}")
    seen: set[str] = set()
    for e in b.get("checklist", []):
        if e["block"] in seen: errs.append(f"checklist: block {e['block']} appears twice")
        seen.add(e["block"])
        has = bool(e.get("evidence") or e.get("tables") or e.get("flows") or e.get("functions"))
        if e["present"] and not has: errs.append(f"checklist {e['block']}: present needs evidence (or tables/flows/functions)")
        if not e["present"] and has: errs.append(f"checklist {e['block']}: not present must carry no evidence")
        for t in e.get("tables", []) or []:
            if t not in tables: errs.append(f"checklist {e['block']}: table {t} is not in the app map")
        for f in e.get("flows", []) or []:
            if f not in flows: errs.append(f"checklist {e['block']}: flow {f} is not in the app map")
        for f in e.get("functions", []) or []:
            fn_ref(f, f"checklist {e['block']}")
    for blk in BLOCKS:
        if blk not in seen: errs.append(f"checklist: block {blk} is missing; answer every block with present true (evidence) or false")
    # everydeck_tables: tables the everydeck installation created; each must be in the app map
    for i, y in enumerate(b.get("everydeck_tables") or []):
        if y["table"] not in {t["name"] for t in b.get("tables", [])}: errs.append(f"everydeck_tables[{i}] {y['table']}: table {y['table']} is not in the app map")
    # a described screen names only tables and flows of the app map (mirror of the reference check in the contracts)
    for i, sc in enumerate(b.get("screens") or []):
        d = sc.get("described")
        if not d: continue
        at = f"screens[{i}] {sc['pattern']}.described"
        for t in d.get("works_with", []):
            if t not in tables: errs.append(f"{at}: table {t} is not in the app map")
        for f in d.get("flows", []):
            if f not in flows: errs.append(f"{at}: flow {f} is not in flows")
    # works_with: what the users work with; each table once, part_of another table of the app map
    ww = b.get("works_with") or []
    for i, w in enumerate(ww):
        at = f"works_with[{i}] {w['table']}"
        if w["table"] not in tables: errs.append(f"{at}: table {w['table']} is not in the app map")
        if sum(1 for x in ww if x["table"] == w["table"]) > 1: errs.append(f"{at}: listed twice")
        if w.get("part_of") and w["part_of"] not in tables: errs.append(f"{at}: part_of {w['part_of']} is not in the app map")
        if w.get("part_of") == w["table"]: errs.append(f"{at}: part_of names the table itself")
    if not any((s.get("step") == "result") for f in b.get("flows", []) for s in (f.get("signals") or [])):
        errs.append("flows: at least one flow needs a result signal (the code that reports the result to everydeck, with evidence)")
    return errs


# ── places: file, line, symbol ──
class _Files:
    def __init__(self, repo: Path) -> None:
        self.repo = repo; self.cache: dict[str, list[str] | None] = {}
        self.functions: dict[str, list[dict[str, Any]] | str] = {}   # functions per file from the syntax tree

    def lines(self, rel: str) -> list[str] | None:
        if rel not in self.cache:
            p = self.repo / rel
            try:
                self.cache[rel] = p.read_text(encoding="utf-8", errors="replace").splitlines() if p.is_file() else None
            except OSError:
                self.cache[rel] = None
        return self.cache[rel]


# place "database" (the schema from the database): checked only with `--db`, against the catalog
DB_TABLES: set[str] | None = None


def _roles(req: dict[str, Any]) -> list[str]:
    r = req.get("role")
    return [] if r is None else list(r) if isinstance(r, list) else [r]


def _check_evidence(files: _Files, ev: dict[str, Any], at: str, expect: list[str], errs: list[str]) -> None:
    """File there, line there, and at least one of the expected words is in the line ± LINE_SLACK."""
    rel = ev["path"]; ln = int(ev["line"])
    if rel == "database":
        if DB_TABLES is None: errs.append(f"{at}: evidence from the database; run everydeck-check validate with --db <url> (the read role is enough) to confirm it"); return
        sym = str(ev.get("symbol") or "")
        name = sym.split(" ")[-1]; tbl = name.split(".")[0] if name.count(".") == 1 and not name.startswith("public.") and name.split(".")[0] not in {t.split(".")[0] for t in DB_TABLES} else name
        if sym.startswith("function ") or sym.startswith("trigger "): return   # functions and triggers: read in the catalog, the comparison checks the table
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
    if ev.get("symbol"):   # the symbol is the anchor: in the line ± 3, or the line is inside the body of exactly this function (next definition above)
        if ev["symbol"] not in missing: return
        chain = _enclosing_chain(files, rel, ln)
        if isinstance(chain, str): errs.append(f"{at}: {rel}:{ln}: cannot read the functions of {rel}: {chain}"); return
        # the line is inside the body of the named function (or one that encloses it): name or Class.method
        if any(ev["symbol"] in (f["name"], f["qualified"]) for f in chain): return
        owner = chain[-1]["qualified"] if chain else None
        errs.append(f"{at}: {rel}:{ln} is not inside {ev['symbol']} ({'inside ' + owner if owner else 'no definition around it'}; ±{LINE_SLACK} lines checked too)")
        return
    if expect and all(w in missing for w in expect): errs.append(f"{at}: {rel}:{ln} does not mention {' / '.join(expect[:3])} (±{LINE_SLACK} lines)")


PY_FILE = re.compile(r"\.pyi?$")
JS_FILE = re.compile(r"\.(?:[cm]?[jt]sx?|vue|svelte)$")


def _py_functions(text: str) -> list[dict[str, Any]] | str:
    """Functions and classes of a Python file with their line range (decorators included), from `ast`."""
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
    """The functions whose line range contains the line, from outside to inside, from the syntax tree (Python `ast`, TS/JS through the
    app's TypeScript compiler API). Other files (SQL, …): the next definition above."""
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
    """Only for files without a parser (SQL and others): name of the next function/class definition above the line."""
    for k in range(ln - 1, max(-1, ln - 1 - span), -1):
        m = DEF_LINE.match(lines[k])
        if m:
            return next(g for g in m.groups() if g)
    return None


PATH_LITERAL = re.compile(r"""(['"`])((?:(?!\1).)*?)\1""")


def _client_path(raw: str) -> tuple[str, bool] | None:
    """→ (path pattern, has a base): ${…} becomes :p; a leading base (${API_BASE}, http://host) is dropped and allows the route to be longer than the path."""
    s = re.sub(r"\$\{[^}]*\}", ":p", raw)
    base = bool(re.match(r"^:p/|^https?://", s))
    s = re.sub(r"^:p(?=/)", "", s); s = re.sub(r"^https?://[^/]*", "", s); s = re.sub(r"[?#].*$", "", s); s = re.sub(r"([^/]):p", r"\1", s)   # `/guests${qs}` → /guests
    return (_pattern(s), base) if s.startswith("/") else None


def _route_matches(route: str, client: str, base: bool = False) -> bool:
    rs = [x for x in route.split("/") if x]; cs = [x for x in client.split("/") if x]
    if not rs or (len(rs) > len(cs) and not base): return False
    off_c = max(0, len(cs) - len(rs)); off_r = max(0, len(rs) - len(cs))   # aligned at the end: proxy prefix in the client or prefix in the base
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
    for raw in path_strings(window):   # strings, templates (also nested, ${…} → :p) and concatenations
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
    sym = lambda ev: [ev["symbol"]] if ev.get("symbol") else []
    money = b.get("money") or {}
    for i, pv in enumerate(money.get("providers", []) or []):
        _check_evidence(files, pv["evidence"], f"money.providers[{i}] {pv['provider']}", sym(pv["evidence"]), errs)
        for j, c in enumerate(pv.get("calls", []) or []): _check_evidence(files, c["evidence"], f"money.providers[{i}] {pv['provider']}.calls[{j}]", sym(c["evidence"]), errs)
    for i, m in enumerate(money.get("tables", []) or []): _check_evidence(files, m["evidence"], f"money.tables[{i}] {m['table']}", sym(m["evidence"]), errs)
    for i, a in enumerate(b.get("ai_calls", []) or []):
        _check_evidence(files, a["evidence"], f"ai_calls[{i}] {a['provider']}", sym(a["evidence"]), errs)
        if a.get("model"): _check_evidence(files, a["model"]["evidence"], f"ai_calls[{i}] {a['provider']}.model", [a["model"]["value"]], errs)
    for i, c in enumerate(b.get("flow_candidates", []) or []):
        _check_evidence(files, c["evidence"], f"flow_candidates[{i}] {c['id']}", [c["evidence"]["symbol"]] if c["evidence"].get("symbol") else [], errs)
        if c.get("handler"): _check_evidence(files, c["handler"], f"flow_candidates[{i}] {c['id']}.handler", [], errs)
    ident = b.get("identity")
    if ident:
        _check_evidence(files, ident["evidence"], "identity", [], errs)
        for k, v in (ident.get("fields") or {}).items():
            if v: _check_evidence(files, v["evidence"], f"identity.fields.{k}", [v["column"]], errs)
        if ident.get("suspend"): _check_evidence(files, ident["suspend"]["checked"], "identity.suspend.checked", [ident["suspend"]["column"]], errs)
        for j, m in enumerate(ident.get("memberships", []) or []): _check_evidence(files, m["evidence"], f"identity.memberships[{j}]", [m["table"]], errs)
    # the place of the description "what the users work with" is in the UI and names the table, or it coincides with a
    # display location of the table (e.g. a route call whose handler returns the table, or a visible element with a label)
    tables_by_name = {t["name"]: t for t in b.get("tables", [])}
    for i, w in enumerate(b.get("works_with") or []):
        at = f"works_with[{i}] {w['table']}"; ev = w["evidence"]; t = tables_by_name.get(w["table"])
        shown_near = t is not None and any(sh["path"] == ev["path"] and abs(int(sh["line"]) - int(ev["line"])) <= LINE_SLACK for sh in list(t.get("shown") or []) + [sh for c in t["columns"] for sh in (c.get("shown") or [])])
        probe: list[str] = []
        _check_evidence(files, ev, at, [w["table"]], probe)
        if probe and not (shown_near and files.lines(ev["path"]) is not None and int(ev["line"]) <= len(files.lines(ev["path"]) or [])): errs.append(probe[0] + "; name the place in the UI (page or component) that shows the table, or a place that carries a display location of it")
        elif not probe and _is_backend(ev["path"]): errs.append(f"{at}: {ev['path']} is no UI file (backend folder); works_with names the page or component where the users see, create or edit it")
    for i, y in enumerate(b.get("everydeck_tables") or []): _check_evidence(files, y["evidence"], f"everydeck_tables[{i}] {y['table']}", [y["table"]], errs)
    for i, pc in enumerate((b.get("app") or {}).get("production_in_code") or []): _check_evidence(files, pc["evidence"], f"app.production_in_code[{i}] {pc['kind']}", [], errs)
    ic = (b.get("app") or {}).get("icon")
    if ic:   # the icon the app ships: file there, content = checksum, the place names the file (or is the file itself)
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
            for k, vl in enumerate(c.get("value_labels", []) or []): _check_evidence(files, vl["evidence"], f"{at}.columns[{j}] {c['name']}.value_labels[{k}] {vl['value']}", [vl["label"]], errs)   # the text is at the place (code or translation file)
            if c.get("computed"): _check_evidence(files, c["computed"], f"{at}.columns[{j}] {c['name']}.computed", [c["name"]], errs)
            if c.get("updated"): _check_evidence(files, c["updated"], f"{at}.columns[{j}] {c['name']}.updated", [c["name"], t["name"]], errs)   # a trigger names the table, onupdate the column
            if c.get("external_id"): _check_evidence(files, c["external_id"]["evidence"], f"{at}.columns[{j}] {c['name']}.external_id", [c["name"]], errs)
            for k, ev in enumerate(c.get("written", []) or []): _check_evidence(files, ev, f"{at}.columns[{j}] {c['name']}.written[{k}]", [c["name"]], errs)   # the place that sets it names the column
            if c.get("contact"): _check_evidence(files, c["contact"]["evidence"], f"{at}.columns[{j}] {c['name']}.contact", [c["name"]], errs)   # the place where the app treats the value as a contact names the column (or its symbol)
        for j, s in enumerate(t.get("statuses", []) or []):
            _check_evidence(files, s["evidence"], f"{at}.statuses[{j}] {s['value']}", [s["value"]], errs)
            for k, sh in enumerate(s.get("shown", []) or []): _check_evidence(files, sh, f"{at}.statuses[{j}] {s['value']}.shown[{k}]", [s["value"]] + ([sh["label"]] if sh.get("label") else []), errs)
            if s.get("public"): _check_evidence(files, s["public"], f"{at}.statuses[{j}] {s['value']}.public", [s["value"]], errs)
        for k, sh in enumerate(t.get("shown", []) or []):
            if sh.get("element") == "data" and sh.get("symbol", "").startswith("/"):   # route pattern: a path literal in the line ± 3 must match it (also `${API_BASE}/persons/${id}`)
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
        if f.get("requires"):   # every named role is at the place
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
    for i, a in enumerate(b.get("adapters", []) or []): _check_evidence(files, a["evidence"], f"adapters[{i}] {a['kind']}", [] if a["kind"] == "read_bridge" else [a["package"]], errs)   # an own read bridge has no package
    for e in b.get("checklist", []):
        for j, ev in enumerate(e.get("evidence", []) or []): _check_evidence(files, ev, f"checklist {e['block']}.evidence[{j}]", [], errs)
    return errs


# ── completeness against the repo ──
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
    """All table/collection names with their first place (not only the first per block like detect_schema)."""
    found: dict[str, str] = {}
    for rel, text in _files_of(repo, {".sql", ".prisma", ".rules", ".py", ".ts", ".tsx", ".js", ".mjs", ".cjs"}):
        def add(name: str, kind: str) -> None:
            if name not in found: found[name] = f"{kind} {name} in {rel}"
        suf = rel.suffix
        if suf == ".sql":   # final state of the schema: migrations in file order, DROP TABLE removes
            for n in SQL_CREATE.findall(text): add(n, "table")
            for n in SQL_DROP.findall(text): found.pop(n, None)
            for old, new in SQL_RENAME.findall(text):   # renamed: the new name is in this file
                if found.pop(old, None) is not None: add(new, "table")
        elif suf == ".prisma":
            for a, c in PRISMA_MODEL.findall(text): add(a or c, "model")
        elif suf == ".rules":
            for n in FIRESTORE_RULE.findall(text):
                if n not in ("databases", "documents"): add(n, "collection")
        elif suf == ".py":
            for n in SQLALCHEMY_TABLE.findall(text): add(n, "table")
            # Alembic: op.create_table("x") / op.drop_table("x") in file order, like the skeleton
            for m in ALEMBIC_OP.finditer(_upgrade_body(text)):   # only upgrade(); downgrade() reverts everything
                if m.group(1) == "create_table": add(m.group(2), "table")
                else: found.pop(m.group(2) or m.group(4), None)   # op.drop_table("x") or op.execute("DROP TABLE x")
        else:
            for n in DRIZZLE_TABLE.findall(text): add(n, "table")
            if "Tables:" in text:
                for n in _supabase_tables(text): add(n, "table")
            for n in FIRESTORE_CALL.findall(text): add(n, "collection")
    return found


def detect_routes(repo: Path) -> dict[str, str]:
    """API paths of the app: Express/Fastify/Hono calls, FastAPI decorators, Next.js app/api/**/route.ts."""
    found: dict[str, str] = {}
    for rel, text in _files_of(repo, {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}):
        parts = rel.parts
        if rel.suffix == ".py":
            for m, path in ROUTE_PY.findall(text): found.setdefault(_pattern(path), f"{m.upper()} {path} in {rel}")
        else:
            for m, path in ROUTE_JS.findall(text):
                if "${" in path: continue   # template strings are client calls, not routes
                found.setdefault(_pattern(path), f"{m.upper()} {path} in {rel}")
            if "api" in parts and rel.name in ("route.ts", "route.js"):
                i = parts.index("api"); seg = "/" + "/".join(parts[i:-1])
                found.setdefault(_pattern(seg), f"route file {rel}")
    return found


def _pattern(path: str) -> str:
    p = re.sub(r"\[\.\.\.[^\]]+\]", "*", path); p = re.sub(r"\[([^\]]+)\]", r":\1", p); p = re.sub(r"\{(\w+):path\}", "*", p); p = re.sub(r"\{(\w+)(?::[^}]*)?\}", r":\1", p)
    p = re.sub(r"\((?:[^)]*)\)/?", "", p)   # route groups
    return p.rstrip("/") or "/"


def detect_providers(repo: Path) -> dict[str, str]:
    """Provider packages from package.json (also subfolders) and requirements/pyproject that everydeck-check knows (NPM/PY tables)."""
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
FRONTEND_READ = [re.compile(r"""\.from\(\s*['"`]([A-Za-z_]\w*)['"`]"""), re.compile(r"""\bcollection\(\s*(?:[A-Za-z_]\w*\s*,\s*)?['"]([A-Za-z_]\w*)['"]"""), re.compile(r"""\b(?:prisma|db)\.([a-z]\w*)\.(?:find\w*|count|aggregate|groupBy)\(""")]   # .from also in the cast form .from("x" as never)
HANDLER_READ = FRONTEND_READ + [re.compile(r"""\.table\(\s*['"]([A-Za-z_]\w*)['"]\s*\)"""), re.compile(r"""\bFROM\s+(?:public\.)?"?([A-Za-z_]\w*)"?""", re.I)]
WRITE_CHAIN = re.compile(r"\.(insert|update|delete|upsert)\(")
ROUTE_ANY = re.compile(r"""(?:@(?:app|router|api|[a-z_]+_router)|\b(?:app|router|server|fastify|api))\.(get|post|put|patch|delete)\(\s*['"`](/[^'"`\s]*)['"`]""")
STRING_PATH = re.compile(r"""['"`]((?:https?://[^'"`\s]+|\$\{[^}`]*\})?/[A-Za-z0-9_\-/:${}.]+)['"`]""")   # also `${API}/api/x` (base as a placeholder, as in the skeleton)


def _is_frontend(rel: Path) -> bool:
    r = rel.as_posix()
    if BACKEND_DIR.search(r) or re.search(r"\.(test|spec|d)\.[tj]sx?$", r): return False
    return bool(re.search(r"\.(tsx|jsx|vue|svelte)$", r) or (re.search(r"\.(ts|js|mjs)$", r) and re.match(r"^(src|app|pages|components|lib|frontend|client|web)/", r)))


_REACH: dict[str, dict[str, Any]] = {}


def app_reach(repo: Path) -> dict[str, Any]:
    """Reachability from the entry of the app; the same rule as the app map scaffold (rule reachable)."""
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
    """A display location or screen in a file that no entry of the app reaches is none; unreachable[] must be correct."""
    reach = app_reach(repo)
    if reach.get("errors"): return [f"unreachable: everydeck rules: {e}" for e in reach["errors"]]
    reachable = set(reach.get("reachable", [])); entries = _entries_of(reach)
    from .reads import is_frontend_source
    def unreachable(path: str) -> bool:
        p = repo / path
        return path not in reachable and p.suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte") and p.is_file() and is_frontend_source(path, p.read_text(encoding="utf-8", errors="replace"))
    errs: list[str] = []
    what = ": it is no display location; leave it out (the generator lists the file in unreachable[])"
    for i, t in enumerate(b.get("tables", [])):
        for k, sh in enumerate(t.get("shown") or []):
            if unreachable(sh["path"]): errs.append(f"tables[{i}] {t['name']}.shown[{k}]: {sh['path']} is not reachable from the entry of the app (entries {entries}){what}")
        for j, c in enumerate(t.get("columns", [])):
            for k, sh in enumerate(c.get("shown") or []):
                if unreachable(sh["path"]): errs.append(f"tables[{i}] {t['name']}.columns[{j}] {c['name']}.shown[{k}]: {sh['path']} is not reachable from the entry of the app (entries {entries}){what}")
    for i, s in enumerate(b.get("screens") or []):
        if unreachable(s["evidence"]["path"]): errs.append(f"screens[{i}] {s['pattern']}: {s['evidence']['path']} is not reachable from the entry of the app (entries {entries}): it is no screen; leave it out (the generator lists the file in unreachable[])")
    for i, u in enumerate(b.get("unreachable") or []):
        if u["path"] in reachable: errs.append(f"unreachable[{i}] {u['path']}: the entry of the app reaches this file (entries {entries}); it is not unreachable")
    return errs


def detect_frontend_reads(repo: Path, tables: set[str]) -> dict[str, str]:
    """Every table the frontend reads, with its first place: directly (supabase.from, Firestore, ORM) or through an API route
    whose handler reads it. Such a table needs a display location in the app map; otherwise it wrongly counts as technical data."""
    lower = {t.lower(): t for t in tables}
    key = lambda n: lower.get(n.lower())
    route_tables: dict[str, set[str]] = {}
    for rel, text in _files_of(repo, {".py", ".ts", ".js", ".mjs", ".cjs"}):
        r = rel.as_posix()
        if not (BACKEND_DIR.search(r) or r.endswith(("/route.ts", "/route.js"))) or re.search(r"\.(test|spec|d)\.[tj]sx?$", r): continue
        hits = list(ROUTE_ANY.finditer(text))
        for i, h in enumerate(hits):
            if h.group(1).lower() != "get": continue   # only routes that return data (GET)
            end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
            if rel.suffix == ".py":   # the handler ends with its def block: the next line without indentation, also another def
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
        if reachable is not None and rel.as_posix() not in reachable: continue   # no entry of the app reaches the file; the app reads nothing there
        lines = text.split("\n")
        at = lambda pos: f"{rel.as_posix()}:{text.count(chr(10), 0, pos) + 1}"
        for re_ in FRONTEND_READ:
            for m in re_.finditer(text):
                t = key(m.group(1))
                if t and t not in out and not WRITE_CHAIN.search(text[m.end():m.end() + 400].split(";")[0]): out[t] = at(m.start())   # .from('x').insert/update/delete/upsert is not a read
        for m in STRING_PATH.finditer(text):
            p = _pattern(re.sub(r"([^/]):p", r"\1", re.sub(r"\$\{[^}]*\}", ":p", re.sub(r"^https?://[^/]+", "", m.group(1)))))
            rp = next((x for x in patterns if x == p or p.endswith(x)), None)
            if not rp: continue
            for t in route_tables[rp]:
                if t not in out: out[t] = f"{at(m.start())} (route {rp})"
        del lines
    return out


AUTH_CALLS = [
    ("sign_up", "signs people up", re.compile(r"""\.auth\.signUp\s*\(|\bcreateUserWithEmailAndPassword\s*\(|\buseSignUp\s*\(|<SignUp\b|\.auth\.sign_up\s*\(""")),
    ("sign_in", "signs people in", re.compile(r"""\.auth\.(?:signIn(?:WithPassword|WithOtp|WithOAuth|WithIdToken|WithSSO)?|verifyOtp)\s*\(|\bsignInWith(?:EmailAndPassword|Popup|Redirect|EmailLink|PhoneNumber|Credential)\s*\(|\buseSignIn\s*\(|<SignIn\b|\.auth\.(?:sign_in_with_(?:password|otp|oauth|id_token)|verify_otp)\s*\(|\bsignIn\s*\(\s*['"]""")),
    ("password_reset", "resets a password", re.compile(r"""\.auth\.resetPasswordForEmail\s*\(|\bsendPasswordResetEmail\s*\(|\.auth\.reset_password_(?:email|for_email)\s*\(""")),
]
FRONTEND_WRITE = re.compile(r"""\.from\(\s*['"`]([A-Za-z_]\w*)['"`]\s*(?:as\s+\w+\s*)?\)""")


def flow_candidate_errors(b: dict[str, Any], repo: Path) -> list[str]:
    """The independent cross-check of the flow candidates: every write of the frontend to a table (Supabase .from('x').insert/update/upsert/delete)
    and every place the code signs people up or in or resets a password is a candidate of the app map (described or left out with its reason)
    or a flow describes it. What the candidates themselves need (a flow or left_out) checks everydeck's bundled rule."""
    errs: list[str] = []
    tables = {t["name"].lower(): t["name"] for t in b.get("tables", [])}
    cands = {c["id"] for c in b.get("flow_candidates", []) or []}
    flows = b.get("flows", []) or []
    near = lambda ev, path, line: ev["path"] == path and abs(int(ev["line"]) - line) <= LINE_SLACK
    def described(table: str | None, kind: str | None, path: str, line: int, purpose: str | None = None) -> bool:
        if purpose: return any(f.get("purpose") == purpose for f in flows)   # a sign-up/sign-in/reset place counts only as a flow with that purpose
        for f in flows:
            w = f["result"].get("write")
            if table and w and w["table"] == table and (kind in (w["kind"], "upsert") or w["kind"] == "upsert"): return True
            if near(f["start"], path, line) or near(f["result"]["evidence"], path, line): return True
        return False
    reach = app_reach(repo); reachable = set(reach.get("reachable", [])) if not reach.get("errors") else None
    seen: set[str] = set()
    for rel, text in _files_of(repo, {".tsx", ".jsx", ".vue", ".svelte", ".ts", ".js", ".mjs", ".py"}):
        r = rel.as_posix()
        if re.search(r"(^|/)(tests?|__tests__|e2e|cypress)/|\.(test|spec|d)\.[tj]sx?$|(^|/)test_[^/]*\.py$", r): continue
        if reachable is not None and _is_frontend(rel) and r not in reachable: continue
        line_of = lambda pos: text.count("\n", 0, pos) + 1
        if _is_frontend(rel):
            for m in FRONTEND_WRITE.finditer(text):
                t = tables.get(m.group(1).lower()); w = WRITE_CHAIN.search(text[m.end():m.end() + 400].split(";")[0])
                if not t or not w: continue
                kind = w.group(1); cid = f"browser_write:{kind}:{t}"; ln = line_of(m.start())
                if cid in cands or cid in seen or described(t, kind, r, ln): continue
                seen.add(cid); errs.append(f"flow_candidates: the frontend writes {t} ({kind}) at {r}:{ln} but the app map lists no candidate {cid} and no flow describes it; rerun the scaffold with --merge")
        for i, line in enumerate(text.split("\n")):
            if re.match(r"^\s*(//|#|\*)", line): continue
            for kind, verb, re_ in AUTH_CALLS:
                cid = f"auth:{kind}"
                if re_.search(line) and cid not in cands and cid not in seen and not described(None, None, r, i + 1, kind):
                    seen.add(cid); errs.append(f"flow_candidates: the code {verb} at {r}:{i + 1} but the app map lists no candidate {cid} and no flow with purpose {kind}; rerun the scaffold with --merge")
    return errs


AI_CALL = re.compile(r"""\.(chat\.completions\.create|chat\.completions\.parse|responses\.create|embeddings\.create|messages\.create|generateContent|generate_content)\s*\(""")
PAY_CALL = [("checkout", "opens a checkout", re.compile(r"""\b(stripe\.checkout\.(?:sessions|Session)\.create|stripe\.PaymentIntent\.create|stripe\.paymentIntents\.create|Paddle\.Checkout\.open|Purchases\.purchase(?:Package|Product|StoreProduct))\s*\(""")),
            ("webhook", "receives the payment provider's webhook", re.compile(r"""\b(stripe\.webhooks\.constructEvent(?:Async)?|stripe\.Webhook\.construct_event)\s*\("""))]


def money_ai_errors(b: dict[str, Any], repo: Path) -> list[str]:
    """The independent cross-check of money and AI: every AI call (OpenAI-compatible, Anthropic, Google) and every checkout or webhook of a payment provider
    that everydeck-check finds in the code is in the app map (ai_calls, money.providers[].calls) at that place (± 3 lines). Anthropic's messages.create
    counts only in a file that names anthropic."""
    errs: list[str] = []
    ai = [(a["evidence"]["path"], int(a["evidence"]["line"])) for a in b.get("ai_calls", []) or []]
    pay = [(c["evidence"]["path"], int(c["evidence"]["line"])) for pv in ((b.get("money") or {}).get("providers") or []) for c in pv.get("calls", []) or []]
    has = lambda xs, r, ln: any(p == r and abs(l - ln) <= LINE_SLACK for p, l in xs)
    for rel, text in _files_of(repo, {".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"}):
        r = rel.as_posix()
        if re.search(r"(^|/)(tests?|__tests__|e2e|cypress)/|\.(test|spec|d)\.[tj]sx?$|(^|/)test_[^/]*\.py$", r): continue
        for i, line in enumerate(text.split("\n")):
            if re.match(r"^\s*(//|#|\*)", line): continue
            m = AI_CALL.search(line)
            if m and not (m.group(1) == "messages.create" and not re.search(r"anthropic", text, re.I)) and not has(ai, r, i + 1):
                errs.append(f"ai_calls: the code calls an AI model ({m.group(1)}) at {r}:{i + 1} but the app map has no ai_calls entry there; rerun the scaffold with --merge")
            for kind, verb, re_ in PAY_CALL:
                p = re_.search(line)
                if p and not has(pay, r, i + 1): errs.append(f"money: the code {verb} ({p.group(1)}) at {r}:{i + 1} but money.providers names no call there; rerun the scaffold with --merge")
    return errs[:50]


def completeness_errors(b: dict[str, Any], repo: Path) -> list[str]:
    errs: list[str] = []
    errs += flow_candidate_errors(b, repo)
    errs += money_ai_errors(b, repo)
    declared_tables = {t["name"] for t in b.get("tables", [])}
    for name, where in detect_tables(repo).items():
        if name not in declared_tables: errs.append(f"tables[]: {where} is not in the app map; add it with its columns, or it is lost silently")
    # if the frontend reads a table, it needs a display location (shown on the table or a column); otherwise rejection
    shown = {t["name"] for t in b.get("tables", []) if t.get("shown") or any(c.get("shown") for c in t.get("columns", []))}
    for name, where in detect_frontend_reads(repo, declared_tables).items():
        if name not in shown: errs.append(f"tables[] {name}: the frontend reads this table at {where} but the app map has no display location (shown) for it; add the place, or it counts as technical data wrongly")
    # cross-check, independent of the skeleton's detection: every mention of a table without a display location in a string
    # of the frontend needs a documented reason (not_shown with file and line ± 3); otherwise rejection with the place
    not_shown = {t["name"]: t.get("not_shown") or [] for t in b.get("tables", [])}
    seen_open: set[tuple[str, str]] = set()
    for m in frontend_mentions(repo, declared_tables - shown):
        if any(x["path"] == m["path"] and abs(int(x["line"]) - m["line"]) <= LINE_SLACK for x in not_shown[m["table"]]): continue
        key = (m["table"], f"{m['path']}:{m['line']}")
        if key in seen_open: continue
        seen_open.add(key)
        errs.append(f"tables[] {m['table']}: the frontend names this table at {m['path']}:{m['line']} ({m['text'][:60]!r}) but the app map has neither a display location (shown) nor a fact about the place (not_shown) for it; add the place with what it is (write, label, route of a write request, module no screen imports)")
    errs += reachability_errors(b, repo)
    errs += exposure_errors(repo)
    declared_routes = {r["pattern"].rstrip("/") or "/" for r in (b.get("api_routes") or [])} | {s["pattern"].rstrip("/") or "/" for s in (b.get("screens") or [])}
    for pat, where in detect_routes(repo).items():   # an app map may carry the full pattern (router prefix + include_router prefix + path); the place here is only the decorator's path
        if pat not in declared_routes and not any(d.endswith(pat) and pat != "/" for d in declared_routes): errs.append(f"api_routes[]: {where} is not in the app map (pattern {pat})")
    declared_pkgs = {c["package"].lower() for c in (b.get("components") or [])}
    for name, where in detect_providers(repo).items():
        if name.lower() not in declared_pkgs: errs.append(f"components[]: {where} is not in the app map")
    return errs


def exposure_errors(repo: Path) -> list[str]:
    """The reader schema everydeck_read must not be reachable through the Supabase API (supabase/config.toml [api] schemas)."""
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
            errs.append(f"{rel}:{ln}: schema everydeck_read is exposed through the Supabase API ([api] schemas); remove it; everydeck reads everydeck_read only through the bridge as everydeck_reader, anon and authenticated must not reach it")
    return errs


def database_tables(url: str) -> set[str]:
    """Tables of the app according to the database (schema.name), without the platform schemas; through psql or psycopg (the read role is enough)."""
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
    """Every table of the database is in the app map (otherwise it drops out silently); everydeck's own schemas do not count."""
    declared = {(t.get("schema") or "public") + "." + t["name"] for t in b.get("tables", [])}
    everydeck = {"everydeck", "everydeck_outbox", "everydeck_bridge"}
    return [f"tables[]: {t} is in the database but not in the app map; add it with its columns (the generator reads it with --db)" for t in sorted(db) if t not in declared and t.split(".")[0] not in everydeck]


# ── Copies of contact data and messages. If an SQL function of the app (trigger: NEW./OLD., local variables from them;
#    INSERT … SELECT from the table itself) writes a value documented as contact (also shortened or transformed) into another column, everydeck-check
#    requires the same fact there. Final state of the migrations in file order (CREATE OR REPLACE: the last version, DROP FUNCTION/TRIGGER remove). The same
#    rule as the skeleton (scaffold.mjs), separate implementation.
_FN_DEF = re.compile(r'create\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\(', re.I)
_FN_DROP = re.compile(r'drop\s+function\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?', re.I)
_TRG_DEF = re.compile(r'create\s+(?:or\s+replace\s+)?trigger\s+"?(\w+)"?\s+(?:before|after|instead\s+of)\s+[\s\S]*?\bon\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?[\s\S]*?execute\s+(?:function|procedure)\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?', re.I)
_TRG_DROP = re.compile(r'drop\s+trigger\s+(?:if\s+exists\s+)?"?(\w+)"?\s+on\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?', re.I)


def _close_of(s: str, open_: int) -> int:
    depth, q = 0, False
    for i in range(open_, len(s)):
        ch = s[i]
        if q:
            if ch == "'": q = False
            continue
        if ch == "'": q = True
        elif ch == "(": depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0: return i
    return -1


def _split_top(s: str) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []; depth, q, start = 0, False, 0
    for i in range(len(s) + 1):
        ch = s[i] if i < len(s) else None
        if q:
            if ch == "'": q = False
            continue
        if ch == "'": q = True
        elif ch == "(": depth += 1
        elif ch == ")": depth -= 1
        elif (ch == "," and depth == 0) or ch is None: out.append((s[start:i], start)); start = i + 1
    return out


def _masked(s: str) -> str:
    out, depth, q = [], 0, False
    for ch in s:
        if q:
            out.append(" ")
            if ch == "'": q = False
            continue
        if ch == "'": q = True; out.append(" "); continue
        if ch == "(": depth += 1; out.append(" "); continue
        if ch == ")": depth = max(0, depth - 1); out.append(" "); continue
        out.append(" " if depth > 0 else ch)
    return "".join(out)


def _sql_functions(repo: Path) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, str]]]:
    fns: dict[str, dict[str, Any]] = {}; trgs: dict[str, dict[str, str]] = {}
    for rel, text in _files_of(repo, {".sql"}):
        src = re.sub(r"--[^\n]*", lambda m: " " * len(m.group(0)), text); ops: list[tuple[int, Any]] = []
        for m in _FN_DEF.finditer(src):
            close = _close_of(src, m.end() - 1)
            if close < 0: continue
            tag = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", src[close:], re.I)
            if not tag: continue
            b0 = close + tag.end(); b1 = src.find(tag.group(1), b0)
            if b1 < 0: continue
            ops.append((m.start(), lambda m=m, b0=b0, b1=b1: fns.__setitem__(m.group(1).lower(), {"name": m.group(1), "body": src[b0:b1], "at": b0, "src": src, "rel": str(rel)})))
        for m in _FN_DROP.finditer(src): ops.append((m.start(), lambda m=m: fns.pop(m.group(1).lower(), None)))
        for m in _TRG_DEF.finditer(src): ops.append((m.start(), lambda m=m: trgs.__setitem__(f"{m.group(2)}:{m.group(1)}".lower(), {"table": m.group(2), "fn": m.group(3).lower()})))
        for m in _TRG_DROP.finditer(src): ops.append((m.start(), lambda m=m: trgs.pop(f"{m.group(2)}:{m.group(1)}".lower(), None)))
        for _, op in sorted(ops, key=lambda x: x[0]): op()
    return fns, trgs


def contact_copy_errors(b: dict[str, Any], repo: Path) -> list[str]:
    tables = {t["name"]: t for t in b.get("tables", [])}
    kinds: dict[tuple[str, str], str] = {(t["name"], c["name"]): c["contact"]["kind"] for t in b.get("tables", []) for c in t.get("columns", []) if c.get("contact")}
    fns, trgs = _sql_functions(repo)
    need: dict[tuple[str, str], tuple[str, str, str, int, str]] = {}   # target → (kind, source, function, line, file)

    def col_ok(tn: str, cn: str) -> bool:
        c = next((x for x in tables.get(tn, {}).get("columns", []) if x["name"] == cn), None)
        return bool(c) and not c.get("pk") and not c.get("fk")

    for _ in range(3):
        added = False
        for fd in fns.values():
            body = fd["body"]; line = lambda off: fd["src"][:fd["at"] + off].count("\n") + 1
            refs: list[tuple[re.Pattern[str], str, str]] = []   # (pattern, kind, source)
            src_tables = [g["table"] for g in trgs.values() if g["fn"] == fd["name"].lower()]
            for st in src_tables:
                for (tn, cn), k in list(kinds.items()):
                    if tn == st: refs.append((re.compile(rf'\b(?:new|old)\s*\.\s*"?{re.escape(cn)}"?(?![A-Za-z0-9_])', re.I), k, f"{tn}.{cn}"))
            def taint(expr: str, extra: list[tuple[re.Pattern[str], str, str]] = []) -> tuple[re.Pattern[str], str, str] | None:
                return next((r for r in refs + extra if r[0].search(expr)), None)
            for _ in range(3):
                for a in re.finditer(r"(?:^|[;\s])([A-Za-z_]\w*)\s*:=\s*([^;]+);", body):
                    if a.group(1).lower() in ("new", "old"): continue
                    r = taint(a.group(2))
                    if r: refs.append((re.compile(rf'(^|[^A-Za-z0-9_."]){re.escape(a.group(1))}(?![A-Za-z0-9_])', re.I), r[1], r[2]))
            hits: list[tuple[str, str, tuple[re.Pattern[str], str, str], int]] = []
            for st in src_tables:
                for a in re.finditer(r'\bnew\s*\.\s*"?([A-Za-z_]\w*)"?\s*:=\s*([^;]+);', body, re.I):
                    r = taint(a.group(2))
                    if r: hits.append((st, a.group(1), r, a.start() + a.group(0).index(a.group(1))))
            for m in re.finditer(r'\binsert\s+into\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s*\(', body, re.I):
                open_ = m.end() - 1; close = _close_of(body, open_)
                if close < 0: continue
                cols = _split_top(body[open_ + 1:close]); rest = body[close + 1:]; exprs = None; extra: list[tuple[re.Pattern[str], str, str]] = []
                v = re.match(r"\s*values\s*\(", rest, re.I)
                if v:
                    o = close + 1 + v.end() - 1; e = _close_of(body, o)
                    if e > 0: exprs = _split_top(body[o + 1:e])
                sel = re.match(r"\s*select\b", rest, re.I)
                if sel:
                    seg = rest[sel.end():].split(";")[0]; at = re.search(r"\bfrom\b", _masked(seg), re.I)
                    if not at: continue
                    exprs = _split_top(seg[:at.start()])
                    for f in re.finditer(r'\b(?:from|join)\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?(?:\s+(?:as\s+)?(?!where\b|join\b|left\b|right\b|inner\b|on\b|group\b|order\b|limit\b)([A-Za-z_]\w*))?', _masked(seg[at.start():]), re.I):
                        for (tn, cn), k in list(kinds.items()):
                            if tn == f.group(1):
                                for q in [x for x in (f.group(1), f.group(2)) if x]: extra.append((re.compile(rf'\b{re.escape(q)}\s*\.\s*"?{re.escape(cn)}"?(?![A-Za-z0-9_])', re.I), k, f"{tn}.{cn}"))
                if not exprs or len(exprs) != len(cols): continue
                for (cname, off), (expr, _) in zip(cols, exprs):
                    r = taint(expr, extra)
                    if r: hits.append((m.group(1), cname.strip().strip('"'), r, open_ + 1 + off + cname.index(cname.strip())))
            for u in re.finditer(r'\bupdate\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+set\s+', body, re.I):
                seg = body[u.end():].split(";")[0]; end = re.search(r"\b(?:where|returning|from)\b", _masked(seg), re.I)
                for part, off in _split_top(seg[:end.start() if end else len(seg)]):
                    a = re.match(r'\s*"?([A-Za-z_]\w*)"?\s*=\s*([\s\S]+)$', part)
                    if not a: continue
                    r = taint(a.group(2))
                    if r: hits.append((u.group(1), a.group(1), r, u.end() + off + part.index(a.group(1))))
            for tn, cn, r, off in hits:
                key = (tn, cn)
                if f"{tn}.{cn}" == r[2] or key in need or not col_ok(tn, cn): continue
                need[key] = (r[1], r[2], fd["name"], line(off), fd["rel"])
                if key not in kinds: kinds[key] = r[1]; added = True
        if not added: break
    errs = []
    for (tn, cn), (kind, src, fn, ln, rel) in sorted(need.items()):
        c = next(x for x in tables[tn]["columns"] if x["name"] == cn)
        if not c.get("contact"):
            errs.append(f'tables[] {tn}.{cn}: function {fn} copies {src} ({kind}) into it at {rel}:{ln}; add columns[].contact {{ "kind": "{kind}", "evidence": {{ "path": "{rel}", "line": {ln} }} }} (npx everydeck-scaffold . --merge everydeck/app-map.json writes it); everydeck never reads it then')
    return errs


def validate_app_map(doc: dict[str, Any], repo: Path | None, db: str | None = None) -> list[str]:
    global DB_TABLES
    errs = schema_errors(doc)
    if errs: return errs
    errs = reference_errors(doc)
    # the same check as everydeck on submission (bundled), derivation and derived manifest included
    if not errs:
        from .rules import app_map_rule_errors
        errs = app_map_rule_errors(doc)
    if db and not errs:
        try: DB_TABLES = database_tables(db)
        except RuntimeError as e: return [f"--db: {e}"]
        errs += database_errors(doc, DB_TABLES)
    if repo and not errs:
        errs = evidence_errors(doc, repo) + completeness_errors(doc, repo) + contact_copy_errors(doc, repo)
    return errs


def drift_manifest(b: dict[str, Any]) -> dict[str, Any]:
    """For `everydeck-check drift`: the signals, screens, routes and jobs of the app map in the form the drift comparison knows (no derivation)."""
    signals = [{"name": s["name"], "capability_id": f["id"], "label": s["name"], "allowed_source": "server", "location": {"path": s["evidence"]["path"], "symbol": s["evidence"].get("symbol") or s["name"], "commit": b["commit"]}}
               for f in b.get("flows", []) for s in (f.get("signals") or [])]
    return {"schema_version": "1.11-r0", "release_key": b.get("release_key", ""), "capabilities": [{"id": f["id"], "label": f["id"], "kind": "flow", "observation": "instrumented" if f.get("signals") else "proposed"} for f in b.get("flows", [])],
            "signals": signals, "rules": [], "diagnostic_fields": [],
            "screens": [{"pattern": s["pattern"]} for s in (b.get("screens") or [])], "api_routes": [{"pattern": r["pattern"], **({"method": r["method"]} if r.get("method") else {})} for r in (b.get("api_routes") or [])],
            "jobs": [{"id": j["id"], "label": j["id"], "every": j["every"]["expression"], "evidence": [{"path": j["evidence"]["path"], "commit": b["commit"]}]} for j in (b.get("jobs") or [])]}
