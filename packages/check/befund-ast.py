#!/usr/bin/env python3
"""B29 (vierte Runde) – Fakten aus Python-Dateien über den Syntaxbaum (ast), für das Befund-Gerüst (befund-reads.mjs).
Liest je Datei: FastAPI/Starlette-Router (APIRouter(prefix=…)), Routen-Dekoratoren (@x.get("/pfad")) mit ihrem Handler, include_router(…, prefix=…),
Importe (für die Auflösung von Modulen und Funktionen), SQLAlchemy-Modelle (__tablename__) und je Funktion die Datenzugriffe:
  .table("x") / .from_("x") / .from("x") (supabase-py), .rpc("fn"), SQL in Zeichenketten (FROM/JOIN, ohne DELETE FROM), select(Model) /
  session.query(Model) / Model.query, sowie alle aufgerufenen Namen (damit das Gerüst Aufrufe in andere Funktionen und Module verfolgt).
Aufruf: python3 befund-ast.py <repo> <datei> [<datei> …]   → JSON auf stdout. Nichts wird bewertet, nichts geschrieben.
"""
from __future__ import annotations

import ast
import json
import re
import sys

SQL_READ = re.compile(r"\b(from|join)\s+(?:\"?[A-Za-z_]\w*\"?\.)?\"?([A-Za-z_]\w*)\"?", re.I)
SQL_DELETE = re.compile(r"\bdelete\s+from\s+(?:\"?[A-Za-z_]\w*\"?\.)?\"?([A-Za-z_]\w*)\"?", re.I)
HTTP = {"get", "post", "put", "patch", "delete", "head", "options", "api_route", "route"}


def dotted(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return f"{base}.{node.attr}" if base else None
    if isinstance(node, ast.Call):
        return dotted(node.func)
    return None


def const_str(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):   # f-string: nur die festen Teile
        return "".join(v.value for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str))
    return None


def sql_reads(text: str) -> list[str]:
    deleted = {m.group(1) for m in SQL_DELETE.finditer(text)}
    out: list[str] = []
    for m in SQL_READ.finditer(text):
        name = m.group(2)
        # "DELETE FROM x" ist kein Lesen; "UPDATE … FROM y" liest y
        before = text[max(0, m.start() - 12):m.start()].lower()
        if m.group(1).lower() == "from" and before.rstrip().endswith("delete") and name in deleted:
            continue
        if name.lower() in ("select", "where", "values", "lateral", "only"):
            continue
        out.append(name)
    return out


WRITE = {"insert", "update", "delete", "upsert"}
SQL_WORDS = {"select", "from", "where", "join", "on", "as", "and", "or", "not", "null", "is", "in", "distinct", "case", "when", "then", "else", "end", "count", "sum", "min", "max", "avg", "coalesce", "now", "true", "false", "left", "right", "inner", "outer", "order", "by", "group", "limit", "asc", "desc", "with", "lower", "upper", "cast", "interval", "having", "exists", "any", "all", "like", "ilike", "between", "offset", "over", "partition", "filter", "nulls", "first", "last", "using", "lateral", "only", "returning", "values", "set", "into", "default", "row", "array", "jsonb", "json", "text", "int", "integer", "uuid", "bigint", "numeric", "date", "timestamp", "timestamptz", "boolean"}


def select_columns(s: str | None, base_line: int) -> list[dict] | str:
    """B31 Schnitt A: Spalten einer supabase-Auswahl .select("a, b, rel(c)") – je Name die Zeile, in der er steht; "*" oder keine Liste = alle.
    Eingebettete Beziehungen (rel(…)) gehören zu einer anderen Tabelle und zählen hier nicht."""
    if s is None or not s.strip(): return "*"
    out: list[dict] = []; depth = 0; cur = ""; start = 0
    def flush(item: str, at: int) -> None:
        t = item.strip()
        if not t or "(" in t: return
        if t == "*" or t.endswith(".*"): out.append({"name": "*", "line": base_line + s[:at].count("\n")}); return
        t = t.split(":")[-1] if "::" not in t else t.split("::")[0].split(":")[-1]
        t = re.split(r"->|\s", t.strip())[0].strip('"')
        if re.fullmatch(r"[A-Za-z_]\w*", t): out.append({"name": t, "line": base_line + s[:at + item.find(t)].count("\n")})
    for i, ch in enumerate(s):
        if ch == "(": depth += 1
        elif ch == ")": depth -= 1
        if ch == "," and depth == 0: flush(cur, start); cur = ""; start = i + 1
        else: cur += ch
    flush(cur, start)
    return "*" if any(c["name"] == "*" for c in out) else out


def sql_columns(text: str, base_line: int) -> dict:
    """B31 Schnitt A: Spalten einer SQL-Abfrage je gelesener Tabelle – SELECT-Liste bis FROM; Bezeichner mit Zeile (gegen die Spalten des Befunds
    geprüft im Gerüst). "*" bzw. "alias.*" = alle Spalten. Nur einfache Abfragen; was nicht eindeutig ist, zählt als Kandidat für alle Tabellen der Abfrage."""
    out: dict = {}
    for m in re.finditer(r"\bselect\b([\s\S]*?)\bfrom\b([\s\S]*?)(?=\bwhere\b|\bgroup\b|\border\b|\blimit\b|;|\)|$)", text, re.I):
        lst, frm = m.group(1), m.group(2)
        tables = {}
        for t in re.finditer(r"(?:^|\bjoin\b|,)\s*(?:\"?[A-Za-z_]\w*\"?\.)?\"?([A-Za-z_]\w*)\"?(?:\s+(?:as\s+)?([A-Za-z_]\w*))?", frm.strip(), re.I):
            name, alias = t.group(1), t.group(2)
            if not name or name.lower() in SQL_WORDS: continue
            tables[name] = name
            if alias and alias.lower() not in SQL_WORDS: tables[alias] = name
        names = set(tables.values())
        if not names: continue
        lst_start = m.start(1)
        for item in re.finditer(r"(?:([A-Za-z_]\w*)\.)?(\*|[A-Za-z_]\w*)", lst):
            alias, col = item.group(1), item.group(2)
            if col.lower() in SQL_WORDS and col != "*": continue
            line = base_line + text[:lst_start + item.start()].count("\n")
            targets = [tables[alias]] if alias and alias in tables else sorted(names)
            for tbl in targets:
                cur = out.setdefault(tbl, [])
                if cur == "*": continue
                if col == "*": out[tbl] = "*"
                elif not any(c["name"] == col for c in cur): cur.append({"name": col, "line": line})
    return out


def chain(node: ast.Call) -> list[tuple[str, ast.Call]]:
    """Methodenkette von außen nach innen: supabase.table("x").select("*").execute() → [(execute, …), (select, …), (table, …)]"""
    out: list[tuple[str, ast.Call]] = []; cur: ast.AST = node
    while isinstance(cur, ast.Call) and isinstance(cur.func, ast.Attribute):
        out.append((cur.func.attr, cur)); cur = cur.func.value
    return out


class FnFacts(ast.NodeVisitor):
    """Datenzugriffe und Aufrufe innerhalb einer Funktion. Lesen oder Schreiben folgt aus der Methodenkette hinter .table()/.from_()."""

    def __init__(self) -> None:
        self.tables: list[dict] = []; self.rpcs: list[dict] = []; self.sql: list[dict] = []; self.models: list[dict] = []
        self.calls: list[str] = []; self.names: list[str] = []; self._seen: set[int] = set()

    def _sql(self, s: str | None, line: int) -> None:
        if not s or not re.search(r"^\s*(select|with)\b|\bselect\b[\s\S]+\bfrom\b|\n\s*(from|join)\b", s, re.I): return
        cols = sql_columns(s, line)
        for t in sql_reads(s):
            if not any(x["name"] == t and x["line"] == line for x in self.sql): self.sql.append({"name": t, "line": line, "columns": cols.get(t, "*")})

    def visit_Call(self, node: ast.Call) -> None:
        f = node.func
        ch = chain(node)
        for i, (attr, call) in enumerate(ch):
            if attr in ("table", "from_", "from") and call.args and id(call) not in self._seen:
                self._seen.add(id(call)); s = const_str(call.args[0])
                if s:
                    after = [a for a, _ in ch[:i]]; w = next((a for a in after if a in WRITE), None)
                    entry = {"name": s, "line": call.lineno, "kind": "write" if w else "read", "via": f"{attr}(…).{w}(…)" if w else attr}
                    if not w:   # B31 Schnitt A: welche Spalten die Auswahl liest (.select("a, b") → a, b; ohne Liste alle)
                        sel = next((c for a, c in ch[:i] if a == "select"), None)
                        arg = sel.args[0] if sel is not None and sel.args else None
                        entry["columns"] = select_columns(const_str(arg) if arg is not None else None, getattr(arg, "lineno", call.lineno)) if sel is not None else "*"
                    self.tables.append(entry)
        if isinstance(f, ast.Attribute):
            if f.attr == "rpc" and node.args:
                s = const_str(node.args[0])
                if s: self.rpcs.append({"name": s, "line": node.lineno})
            if f.attr == "query" and node.args:   # session.query(Model) / db.query(Model)
                m = dotted(node.args[0])
                if m: self.models.append({"name": m, "line": node.lineno})
            if f.attr in ("execute", "fetch", "fetchrow", "fetchval", "fetch_all", "fetch_one") and node.args:   # cursor.execute("SELECT … FROM x") / conn.fetch(…) / conn.execute(text("…"))
                s = const_str(node.args[0])
                if s is None and isinstance(node.args[0], ast.Call) and node.args[0].args: s = const_str(node.args[0].args[0])
                self._sql(s, node.lineno)
        elif isinstance(f, ast.Name):
            if f.id in ("select", "Select") and node.args:   # sqlalchemy select(Model)
                for a in node.args:
                    m = dotted(a)
                    if m: self.models.append({"name": m, "line": node.lineno})
            if f.id == "text" and node.args: self._sql(const_str(node.args[0]), node.lineno)   # sqlalchemy text("SELECT …")
        name = dotted(f)
        if name and name not in self.calls: self.calls.append(name)
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr == "query" and isinstance(node.value, ast.Name) and node.value.id[:1].isupper():   # Model.query (Flask-SQLAlchemy)
            self.models.append({"name": node.value.id, "line": node.lineno})
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str) and len(node.value) > 12: self._sql(node.value, node.lineno)

    def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
        self._sql(const_str(node), node.lineno)
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load) and node.id not in self.names: self.names.append(node.id)


def col_key(node: ast.AST) -> str | None:
    """x.get("col") / x["col"] → "col" (der Wert einer Spalte aus einer gelesenen Zeile)"""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get" and node.args:
        return const_str(node.args[0])
    if isinstance(node, ast.Subscript):
        return const_str(node.slice)
    return None


def flow_facts(fn: ast.AST, imports: dict, module_returns: dict | None = None) -> dict:
    """B31 E1 – Setzstellen und Anbieter-Kennungen einer Funktion (nur Fakten):
    writes: Spalten, die die Funktion in einer Änderung schreibt (.table("t").update({…}) / .upsert / .insert, auch über ein Dict, das vorher gefüllt wird),
            mit `provider`, wenn der Wert aus dem Aufruf eines Anbieterpakets stammt (cid = stripe.Customer.create(…)["id"] → {"stripe_customer_id": cid});
    passes: Spalten, deren Wert die Funktion einem Anbieterpaket übergibt (stripe.Customer.retrieve(org.get("stripe_customer_id")))."""
    mods = {k: v.split(":")[0].split(".")[0] for k, v in imports.items() if not v.startswith(".")}   # Name → oberstes Modul
    assigns: dict = {}; dict_sets: dict = {}
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    assigns.setdefault(t.id, []).append(n.value)
                    if isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name) and (module_returns or {}).get(n.value.func.id): mods[t.id] = module_returns[n.value.func.id]   # stripe = _stripe() – die Funktion gibt das Modul zurück
                if isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name):
                    k = const_str(t.slice)
                    if k: dict_sets.setdefault(t.value.id, []).append((k, n.value, n.lineno))
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.value is not None:
            assigns.setdefault(n.target.id, []).append(n.value)
    def provider_call(node: ast.AST) -> str | None:
        for x in ast.walk(node):
            if isinstance(x, ast.Call):
                d = dotted(x.func) or ""; head = d.split(".")[0]
                if head in mods and "." in d: return mods[head]
        return None
    prov: dict = {}
    for _ in range(4):
        for v, rhss in assigns.items():
            if v in prov: continue
            for r in rhss:
                m = provider_call(r) or next((prov[x.id] for x in ast.walk(r) if isinstance(x, ast.Name) and x.id in prov), None)
                if m: prov[v] = m; break
    col_of: dict = {}; derived: dict = {}   # derived: Variable → Spalten, aus deren aktuellem Wert sie berechnet ist (new = int(org.get("topup_credits")) + n)
    for v, rhss in assigns.items():
        for r in rhss:
            k = col_key(r)
            if k: col_of[v] = (k, getattr(r, "lineno", 0))
            for x in ast.walk(r):
                kk = col_key(x)
                if kk: derived.setdefault(v, set()).add(kk)
    for _ in range(4):
        for v, rhss in assigns.items():
            for r in rhss:
                for x in ast.walk(r):
                    if isinstance(x, ast.Name) and x.id in derived and x.id != v: derived.setdefault(v, set()).update(derived[x.id])
    def touches(node: ast.AST, column: str) -> bool:
        return any((col_key(x) == column) or (isinstance(x, ast.Name) and column in derived.get(x.id, set())) for x in ast.walk(node))
    def from_itself(node: ast.AST, column: str, depth: int = 0) -> bool:
        """Rechnung mit dem bisherigen Wert (+, -, *): new = int(org.get("topup_credits")) + n – nicht schon ein Wert aus einem Dict mit demselben Schlüssel"""
        if any(isinstance(x, ast.BinOp) and isinstance(x.op, (ast.Add, ast.Sub, ast.Mult)) and touches(x, column) for x in ast.walk(node)): return True
        if depth < 3:
            for x in ast.walk(node):
                if isinstance(x, ast.Name) and column in derived.get(x.id, set()) and any(from_itself(r, column, depth + 1) for r in assigns.get(x.id, [])): return True
        return False
    def value_provider(node: ast.AST) -> str | None:
        return provider_call(node) or next((prov[x.id] for x in ast.walk(node) if isinstance(x, ast.Name) and x.id in prov), None)
    writes: list = []; passes: list = []; seen_w: set = set()
    for n in ast.walk(fn):
        if not isinstance(n, ast.Call): continue
        ch = chain(n)
        tbl = next((const_str(c.args[0]) for a, c in ch if a in ("table", "from_", "from") and c.args), None)
        w = next(((a, c) for a, c in ch if a in ("update", "upsert", "insert")), None)
        if tbl and w and w[1].args and id(w[1]) not in seen_w:
            seen_w.add(id(w[1]))
            arg = w[1].args[0]; items = []
            if isinstance(arg, ast.Dict): items = [(const_str(k), v, getattr(k, "lineno", w[1].lineno)) for k, v in zip(arg.keys, arg.values) if k is not None]
            elif isinstance(arg, ast.Name):
                for r in assigns.get(arg.id, []):
                    if isinstance(r, ast.Dict): items += [(const_str(k), v, getattr(k, "lineno", r.lineno)) for k, v in zip(r.keys, r.values) if k is not None]
                items += dict_sets.get(arg.id, [])
            for k, v, line in items:
                if not k: continue
                e = {"table": tbl, "column": k, "line": line, "op": w[0]}
                m = value_provider(v)
                if m: e["provider"] = m
                if from_itself(v, k): e["self"] = True   # der neue Wert folgt aus dem bisherigen (Guthaben, Zähler)
                writes.append(e)
        d = dotted(n.func) or ""; head = d.split(".")[0]
        if head in mods and "." in d:
            # nur ein Positionsargument, das selbst die Spalte ist (stripe.Customer.retrieve(org["stripe_customer_id"])) – ein Wert in einem Dict oder
            # als Schlüsselwort (resend.Emails.send({"subject": …}), stripe.Customer.create(email=…)) ist Inhalt, den die App übergibt, keine Kennung
            for x in n.args:
                direct = col_key(x); via = col_of.get(x.id) if isinstance(x, ast.Name) else None
                if direct: passes.append({"column": direct, "line": getattr(x, "lineno", n.lineno), "provider": mods[head]})
                elif via: passes.append({"column": via[0], "line": via[1] or n.lineno, "provider": mods[head]})   # Stelle, an der die Spalte genannt ist
    return {"writes": writes, "passes": passes}


def kw(node: ast.Call, key: str) -> str | None:
    for k in node.keywords:
        if k.arg == key: return const_str(k.value)
    return None


def money_places(tree: ast.AST, imports: dict) -> list:
    """B32 (O3): Geld in Python – babel.numbers.format_currency(wert, "EUR") formatiert einen Wert als Währung; eine Funktion der App zählt nur,
    wenn ihr Körper das nachweislich mit einem ihrer Parameter tut (nie am Namen). Wert = Spalte einer gelesenen Zeile (row["price"], row.get("price"),
    row.price); Währung = Literal, Spalte derselben Zeile oder ein Parameter, den der Aufrufer füllt; sonst keine."""
    def is_fmt(call: ast.Call) -> bool:
        name = dotted(call.func) or ""
        if name.split(".")[-1] != "format_currency": return False
        src = imports.get(name.split(".")[0], "")
        return src.split(":")[0].split(".")[0] == "babel"
    fns = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    params = {id(f): [a.arg for a in f.args.args] for f in fns}
    owner: dict = {}
    for f in fns:
        for x in ast.walk(f): owner[id(x)] = f   # innerste zuletzt: ast.walk geht außen nach innen, die innere Funktion überschreibt
    def core(n):
        while True:
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ("float", "int", "Decimal", "round") and n.args: n = n.args[0]; continue
            if isinstance(n, ast.BoolOp) and isinstance(n.op, ast.Or): n = n.values[0]; continue
            if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Div, ast.Mult)) and isinstance(n.right, ast.Constant): n = n.left; continue
            return n
    def prop_of(n):
        n = core(n)
        return col_key(n) or (n.attr if isinstance(n, ast.Attribute) else None)
    def currency_of(arg, at):
        if arg is None: return {}
        lit = const_str(arg)
        if lit and re.fullmatch(r"[A-Za-z]{3}", lit): return {"currency": lit.upper()}
        if prop_of(arg): return {"currency_prop": prop_of(arg)}
        f = owner.get(id(at))
        if isinstance(arg, ast.Name) and f is not None and arg.id in params[id(f)]: return {"currency_param": params[id(f)].index(arg.id)}
        return {}
    def describe(c): return f"currency {c['currency']}" if c.get("currency") else f"currency from {c['currency_prop']}" if c.get("currency_prop") else "currency from the caller" if "currency_param" in c else "no currency in the code"
    helpers: dict = {}; places: list = []
    def money_at(x, c, via, at):
        p = prop_of(x)
        if p:
            if not any(m["prop"] == p and m["line"] == x.lineno for m in places):
                places.append({"prop": p, "line": x.lineno, **{k: v for k, v in c.items() if k in ("currency", "currency_prop")}, "via": via[:160]})
            return
        x = core(x); f = owner.get(id(x))
        if isinstance(x, ast.Name) and f is not None and x.id in params[id(f)] and f.name not in helpers:
            helpers[f.name] = {"param": params[id(f)].index(x.id), **c, "via": via}
            return True
    for _ in range(6):
        grew = False
        for n in ast.walk(tree):
            if not isinstance(n, ast.Call): continue
            if is_fmt(n) and n.args:
                arg = n.args[1] if len(n.args) > 1 else next((k.value for k in n.keywords if k.arg == "currency"), None)
                c = currency_of(arg, n)
                grew = bool(money_at(n.args[0], c, f"format_currency {describe(c)} at line {n.lineno}", n)) or grew
            elif isinstance(n.func, ast.Name) and n.func.id in helpers:
                h = helpers[n.func.id]
                if len(n.args) > h["param"]:
                    c = currency_of(n.args[h["currency_param"]] if "currency_param" in h and len(n.args) > h["currency_param"] else None, n) if "currency_param" in h else {k: v for k, v in h.items() if k in ("currency", "currency_prop")}
                    grew = bool(money_at(n.args[h["param"]], c, f"{n.func.id}(…) → {h['via']}", n)) or grew
        if not grew: break
    return places


def analyse(path: str) -> dict:
    try:
        src = open(path, encoding="utf-8", errors="replace").read()
        tree = ast.parse(src)
    except (OSError, SyntaxError, ValueError) as e:
        return {"error": str(e)[:200]}
    out: dict = {"routers": {}, "routes": [], "includes": [], "imports": {}, "models": {}, "functions": {}, "consts": {}, "app": None}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names: out["imports"][a.asname or a.name.split(".")[0]] = a.name
        elif isinstance(node, ast.ImportFrom):
            mod = "." * (node.level or 0) + (node.module or "")
            for a in node.names: out["imports"][a.asname or a.name] = f"{mod}:{a.name}"
        elif isinstance(node, ast.ClassDef):
            for st in node.body:
                if isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__tablename__" for t in st.targets):
                    s = const_str(st.value)
                    if s: out["models"][node.name] = s
    for node in tree.body:   # Modulebene: Router, include_router, App, Konstanten
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            name = dotted(node.value.func) or ""
            if name.endswith("APIRouter") or name.endswith("Router"):
                for t in node.targets:
                    if isinstance(t, ast.Name): out["routers"][t.id] = {"prefix": kw(node.value, "prefix") or "", "line": node.lineno}
            if name.endswith("FastAPI") or name.endswith("Starlette") or name.endswith("Flask"):
                for t in node.targets:
                    if isinstance(t, ast.Name): out["app"] = t.id
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            s = const_str(node.value)
            if s and re.search(r"\b(select|from|join)\b", s, re.I):
                out["consts"][node.targets[0].id] = sql_reads(s)
    # B31 E1: Funktionen, die ein importiertes Modul zurückgeben (def _stripe(): import stripe as m; return m)
    module_returns: dict = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for r in ast.walk(node):
                if isinstance(r, ast.Return) and isinstance(r.value, ast.Name) and r.value.id in out["imports"] and not out["imports"][r.value.id].startswith("."):
                    module_returns[node.name] = out["imports"][r.value.id].split(":")[0].split(".")[0]
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "include_router" and node.args:
            out["includes"].append({"receiver": dotted(node.func.value), "arg": dotted(node.args[0]), "prefix": kw(node, "prefix") or "", "line": node.lineno})
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            facts = FnFacts()
            for st in node.body: facts.visit(st)
            end = getattr(node, "end_lineno", node.lineno)
            ff = flow_facts(node, out["imports"], module_returns)
            out["functions"][node.name] = {"line": node.lineno, "end": end, "tables": facts.tables, "rpcs": facts.rpcs, "sql": facts.sql, "models": facts.models, "calls": facts.calls, "names": facts.names, "writes": ff["writes"], "passes": ff["passes"]}
            for d in node.decorator_list:
                if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in HTTP and d.args:
                    p = const_str(d.args[0])
                    if p is None: continue
                    methods = [d.func.attr.upper()]
                    if d.func.attr in ("api_route", "route"):
                        ml = next((k.value for k in d.keywords if k.arg == "methods"), None)
                        methods = [str(const_str(m)).upper() for m in getattr(ml, "elts", [])] or ["GET"]
                    for meth in methods:
                        out["routes"].append({"receiver": dotted(d.func.value), "method": meth, "path": p, "line": d.lineno, "handler": node.name})
    out["money"] = money_places(tree, out["imports"])
    return out


def main() -> None:
    repo = sys.argv[1]; files = sys.argv[2:]
    if files == ["-"]: files = [l for l in sys.stdin.read().split("\n") if l]
    result = {}
    for f in files:
        rel = f[len(repo) + 1:] if f.startswith(repo + "/") else f
        result[rel] = analyse(f)
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
