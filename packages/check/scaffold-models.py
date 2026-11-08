#!/usr/bin/env python3
"""Tables and columns from Python models through the syntax tree (ast), for the app map scaffold (scaffold.mjs).
SQLAlchemy (class with __tablename__, also annotated `__tablename__: str = "x"`; Column(...) and mapped_column(...) over several lines) and
SQLModel (class X(Base, table=True): the table is the class name in lower case unless __tablename__ says otherwise; Field(primary_key=…,
foreign_key="t.c")). Columns of base classes count (UserBase → User), as in the ORM; relationships are no columns. Also Alembic: the revisions in
the order of their down_revision chain, with op.create_table, op.drop_table, op.add_column, op.drop_column, op.rename_table and op.alter_column(new_column_name).
Usage: python3 scaffold-models.py <repo> -   (file list on stdin) → JSON on stdout. Nothing is judged, nothing is written.
"""
from __future__ import annotations

import ast
import json
import re
import sys

NOT_COLUMN = {"Relationship", "relationship", "relation", "backref", "association_proxy", "column_property", "synonym", "hybrid_property"}


def dotted(node: ast.AST | None) -> str:
    if isinstance(node, ast.Name): return node.id
    if isinstance(node, ast.Attribute): return f"{dotted(node.value)}.{node.attr}"
    if isinstance(node, ast.Call): return dotted(node.func)
    if isinstance(node, ast.Subscript): return dotted(node.value)
    return ""


def const(node: ast.AST | None):
    return node.value if isinstance(node, ast.Constant) else None


def kw(call: ast.Call, key: str):
    for k in call.keywords:
        if k.arg == key: return k.value
    return None


def type_of(ann: ast.AST | None) -> tuple[str, bool]:
    """(type name, nullable) from an annotation: Mapped[int | None], Optional[str], str | None, uuid.UUID"""
    if ann is None: return ("text", False)
    if isinstance(ann, ast.Subscript) and dotted(ann.value).split(".")[-1] in ("Mapped", "Optional"):
        t, n = type_of(ann.slice)
        return (t, n or dotted(ann.value).endswith("Optional"))
    if isinstance(ann, ast.BinOp) and isinstance(ann.op, ast.BitOr):
        parts = [ann.left, ann.right]; none = any(isinstance(p, ast.Constant) and p.value is None for p in parts)
        rest = [p for p in parts if not (isinstance(p, ast.Constant) and p.value is None)]
        t, n = type_of(rest[0]) if rest else ("text", False)
        return (t, n or none)
    if isinstance(ann, ast.Subscript): return (dotted(ann.value).split(".")[-1].lower() or "json", False)   # list[...] / dict[...]
    if isinstance(ann, ast.Constant) and isinstance(ann.value, str):   # "Item" as a string annotation
        try: return type_of(ast.parse(ann.value, mode="eval").body)
        except SyntaxError: return (ann.value.lower(), False)
    return ((dotted(ann).split(".")[-1] or "text").lower(), False)


def fk_of(call: ast.Call) -> dict | None:
    for a in [*call.args, *[k.value for k in call.keywords]]:
        if isinstance(a, ast.Call) and dotted(a.func).split(".")[-1] == "ForeignKey" and a.args:
            s = const(a.args[0])
            if isinstance(s, str) and "." in s: t, c = s.rsplit(".", 1); return {"table": t.split(".")[-1], "column": c}
    s = const(kw(call, "foreign_key"))
    if isinstance(s, str) and "." in s: t, c = s.rsplit(".", 1); return {"table": t.split(".")[-1], "column": c}
    return None


def column_of(name: str, ann: ast.AST | None, value: ast.AST | None, line: int) -> dict | None:
    """One column from a class body statement, or None (relationship, ClassVar, method)."""
    if ann is not None and dotted(ann).split(".")[-1] in ("ClassVar", "Relationship"): return None
    t, nullable = type_of(ann)
    call = value if isinstance(value, ast.Call) else None
    fn = dotted(call.func).split(".")[-1] if call else ""
    if fn in NOT_COLUMN: return None
    if ann is not None and isinstance(ann, ast.Subscript) and dotted(ann.value).split(".")[-1] == "Mapped":
        inner = ann.slice
        if isinstance(inner, ast.Subscript) and dotted(inner.value).split(".")[-1] in ("list", "List", "set", "Set") and fn not in ("mapped_column", "Column"): return None   # Mapped[list["Item"]] = relationship
    if ann is None and fn not in ("Column", "mapped_column"): return None
    col: dict = {"name": name, "type": t, "line": line}
    if call and fn in ("Column", "mapped_column", "Field"):
        if call.args and isinstance(const(call.args[0]), str) and fn != "Field": col["name"] = const(call.args[0])   # Column("db_name", Integer)
        targ = next((a for a in call.args if not isinstance(a, ast.Constant) and dotted(a)), None)
        if targ is not None and dotted(targ).split(".")[-1] != "ForeignKey": col["type"] = dotted(targ).split(".")[-1].lower()
        if const(kw(call, "primary_key")) is True: col["pk"] = True
        nb = const(kw(call, "nullable"))
        if nb is True or (nullable and nb is not False): col["nullable"] = True
        fk = fk_of(call)
        if fk: col["fk"] = fk
        sd = kw(call, "server_default") or kw(call, "default_factory")
        if sd is not None and re.search(r"now|utc|datetime", ast.unparse(sd) if hasattr(ast, "unparse") else "", re.I): col["computed"] = True
    elif nullable: col["nullable"] = True
    if col.get("pk"): col.pop("nullable", None)
    return col


def models(trees: dict[str, ast.AST]) -> list[dict]:
    classes: dict[str, dict] = {}
    for rel, tree in trees.items():
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef): continue
            table_kw = any(k.arg == "table" and const(k.value) is True for k in node.keywords)
            tablename = None; cols = []
            for st in node.body:
                if isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__tablename__" for t in st.targets): tablename = const(st.value)
                elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.target.id == "__tablename__": tablename = const(st.value)
                elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and not st.target.id.startswith("__"):
                    c = column_of(st.target.id, st.annotation, st.value, st.lineno)
                    if c: cols.append(c)
                elif isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name) and not st.targets[0].id.startswith("__"):
                    c = column_of(st.targets[0].id, None, st.value, st.lineno)
                    if c: cols.append(c)
            classes.setdefault(node.name, {"name": node.name, "bases": [dotted(b).split(".")[-1] for b in node.bases], "table_kw": table_kw, "tablename": tablename if isinstance(tablename, str) else None, "cols": cols, "path": rel, "line": node.lineno})
    out = []
    for c in classes.values():
        if not (c["tablename"] or c["table_kw"]): continue
        cols: list[dict] = []; seen: set[str] = set(); chain = [c]; i = 0
        while i < len(chain) and i < 12:   # the class, then its bases in order (columns of the class win)
            for b in chain[i]["bases"]:
                if b in classes and classes[b] not in chain: chain.append(classes[b])
            i += 1
        for k in chain:
            for col in k["cols"]:
                if col["name"] in seen: continue
                seen.add(col["name"]); cols.append({**col, "path": k["path"]})
        out.append({"table": c["tablename"] or c["name"].lower(), "class": c["name"], "path": c["path"], "line": c["line"], "columns": cols})
    return out


def alembic(trees: dict[str, ast.AST], srcs: dict[str, str]) -> list[dict]:
    """Operations of upgrade() per revision, revisions in the order of the down_revision chain (file names are random hashes)."""
    revs = {}
    for rel, tree in trees.items():
        rev = down = None; up = None
        for node in tree.body:
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                tgt = node.targets[0] if isinstance(node, ast.Assign) else node.target
                if isinstance(tgt, ast.Name) and tgt.id == "revision": rev = const(node.value)
                if isinstance(tgt, ast.Name) and tgt.id == "down_revision":
                    v = node.value; down = const(v) if not isinstance(v, (ast.Tuple, ast.List)) else [const(x) for x in v.elts]
            if isinstance(node, ast.FunctionDef) and node.name == "upgrade": up = node
        if rev and up is not None: revs[rev] = {"rel": rel, "down": down if isinstance(down, list) else ([down] if down else []), "up": up}
    order: list[str] = []; done: set[str] = set()

    def visit(r: str, depth: int = 0) -> None:
        if r in done or r not in revs or depth > 500: return
        done.add(r)
        for d in revs[r]["down"]: visit(d, depth + 1)
        order.append(r)
    for r in sorted(revs, key=lambda x: revs[x]["rel"]): visit(r)
    ops = []
    for r in order:
        rel = revs[r]["rel"]
        for node in ast.walk(revs[r]["up"]):
            if not (isinstance(node, ast.Call) and dotted(node.func).startswith("op.")): continue
            op = dotted(node.func)[3:]; a = [const(x) for x in node.args]
            if op == "add_column" and len(node.args) >= 2 and isinstance(node.args[1], ast.Call):
                cc = node.args[1]; name = const(cc.args[0]) if cc.args else None
                if not isinstance(name, str) or not isinstance(a[0], str): continue
                t = dotted(cc.args[1]).split(".")[-1].lower() if len(cc.args) > 1 else "text"
                col = {"name": name, "type": t or "text", "line": node.lineno}
                if const(kw(cc, "nullable")) is True: col["nullable"] = True
                if const(kw(cc, "primary_key")) is True: col["pk"] = True
                fk = fk_of(cc)
                if fk: col["fk"] = fk
                ops.append({"op": "add_column", "table": a[0], "column": col, "path": rel, "line": node.lineno})
            elif op == "drop_column" and len(a) >= 2 and isinstance(a[0], str) and isinstance(a[1], str): ops.append({"op": "drop_column", "table": a[0], "name": a[1], "path": rel, "line": node.lineno})
            elif op == "rename_table" and len(a) >= 2 and isinstance(a[0], str) and isinstance(a[1], str): ops.append({"op": "rename_table", "table": a[0], "name": a[1], "path": rel, "line": node.lineno})
            elif op == "alter_column" and a and isinstance(a[0], str) and len(a) > 1 and isinstance(a[1], str) and isinstance(const(kw(node, "new_column_name")), str): ops.append({"op": "rename_column", "table": a[0], "name": a[1], "to": const(kw(node, "new_column_name")), "path": rel, "line": node.lineno})
    return ops


def main() -> None:
    repo = sys.argv[1]; files = [l for l in sys.stdin.read().split("\n") if l]
    trees: dict[str, ast.AST] = {}; srcs: dict[str, str] = {}; errors = []
    for f in files:
        rel = f[len(repo) + 1:] if f.startswith(repo + "/") else f
        try:
            srcs[rel] = open(f, encoding="utf-8", errors="replace").read(); trees[rel] = ast.parse(srcs[rel])
        except (OSError, SyntaxError, ValueError) as e:
            errors.append({"path": rel, "reason": f"cannot parse ({str(e)[:120]})"})
    alem = {r: t for r, t in trees.items() if re.search(r"(^|/)(alembic|migrations|versions)/", r)}
    sys.stdout.write(json.dumps({"models": models({r: t for r, t in trees.items() if r not in alem}), "alembic": alembic(alem, srcs), "errors": errors}))


if __name__ == "__main__":
    main()
