"""The independent cross-check of the app map's display locations.

The skeleton (scaffold.mjs) reads data access through the syntax tree. everydeck-check does NOT check with the same detection, but
with its own, deliberately simple string scanner: every table name that appears as a word in a string of a frontend source file
(without type files, tests and comments) needs either a display location of the table (shown on the table or a column) or a
documented reason in the app map (tables[].not_shown[] with file and line). Otherwise the app map is rejected, with the place.

Frontend source file (the same definition as in the skeleton, so both sides mean the same): no backend folders (backend, server, api, functions,
supabase, migrations, scripts, prisma, db, database, test…), no test or type files, .tsx/.jsx/.vue/.svelte everywhere, .ts/.js/.mjs only in
src/, app/, pages/, components/, lib/, frontend/, client/, web/, hooks/, contexts/, utils/, features/; a file that registers routes
(app.get('/x', handler)) is backend.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator

from .detect import SKIP_DIRS

BACKEND_DIR = re.compile(r"(^|/)(backend|server|api|functions|supabase|migrations|scripts|prisma|db|database|test|tests|__tests__|e2e|cypress)(/|$)")
TEST_FILE = re.compile(r"\.(test|spec|stories)\.[tj]sx?$|(^|/)(__tests__|e2e|cypress|tests?)/")
TYPE_FILE = re.compile(r"\.d\.ts$|(^|/)(types|.*\.types|database\.types|database|supabase-types|schema)\.ts$")
FRONTEND_DIR = re.compile(r"^(src|app|pages|components|lib|frontend|client|web|hooks|contexts|utils|features)/")
REGISTERS_ROUTES = re.compile(r"""\b(app|router|server|fastify|r|hono|routes)\.(get|post|put|patch|delete|all)\(\s*['"`]/[^'"`]*['"`]\s*,\s*(async\b|\(|function\b|[A-Za-z_]\w*\s*[,)])""")
SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte"}


def is_frontend_source(rel: str, text: str) -> bool:
    if BACKEND_DIR.search(rel) or TEST_FILE.search(rel) or TYPE_FILE.search(rel): return False
    if rel.endswith(".ts") and re.search(r"\bTables:\s*\{", text): return False   # generated Supabase types
    if re.search(r"\.(tsx|jsx|vue|svelte)$", rel): return True
    if re.search(r"\.(ts|js|mjs)$", rel) and FRONTEND_DIR.match(rel): return not REGISTERS_ROUTES.search(text)
    return False


REGEX_BEFORE = re.compile(r"[(,=:\[!&|?{};]\s*$|\breturn\s*$|\btypeof\s*$|^\s*$")


def string_tokens(text: str) -> Iterator[tuple[int, str]]:
    """Strings of a JS/TS source with their line: '…', "…" (no line breaks; an apostrophe in JSX text ends at the line and does not count),
    `…` with all fixed parts (the ${…} expressions are left out, also nested). Comments // and /* */ and regex literals are skipped."""
    i, n, line = 0, len(text), 1
    out: list[tuple[int, str]] = []

    def scan_template(j: int) -> tuple[int, str, int]:
        """from the character after the opening `; returns (position after the closing `, fixed text, lines in between)"""
        parts: list[str] = []; cur = ""; nl = 0
        while j < n:
            c = text[j]
            if c == "\\": cur += text[j:j + 2]; j += 2; continue
            if c == "`": parts.append(cur); return j + 1, "\n".join(parts), nl
            if c == "$" and text[j + 1:j + 2] == "{":
                parts.append(cur); cur = ""; depth = 1; j += 2
                while j < n and depth:   # skip the expression; it can contain strings and further templates
                    c2 = text[j]
                    if c2 == "{": depth += 1
                    elif c2 == "}": depth -= 1
                    elif c2 == "`":
                        j, inner, nl2 = scan_template(j + 1); nl += nl2
                        for part in inner.split("\n"): out.append((line + nl, part))
                        continue
                    elif c2 in "'\"":
                        k = j + 1
                        while k < n and text[k] != c2 and text[k] != "\n":
                            if text[k] == "\\": k += 1
                            k += 1
                        if k < n and text[k] == c2: out.append((line + nl, text[j + 1:k])); j = k + 1; continue
                    if c2 == "\n": nl += 1
                    j += 1
                continue
            if c == "\n": nl += 1
            cur += c; j += 1
        parts.append(cur); return j, "\n".join(parts), nl

    while i < n:
        c = text[i]
        if c == "\n": line += 1; i += 1; continue
        if c == "/" and text[i + 1:i + 2] == "/":
            j = text.find("\n", i); i = n if j < 0 else j; continue
        if c == "/" and text[i + 1:i + 2] == "*":
            j = text.find("*/", i + 2); seg = text[i:n if j < 0 else j + 2]; line += seg.count("\n"); i += len(seg); continue
        if c == "/" and REGEX_BEFORE.search(text[max(0, i - 40):i]):   # regex literal: up to the next unescaped / outside [ ]
            j = i + 1; in_class = False
            while j < n and text[j] != "\n":
                if text[j] == "\\": j += 2; continue
                if text[j] == "[": in_class = True
                elif text[j] == "]": in_class = False
                elif text[j] == "/" and not in_class: break
                j += 1
            if j < n and text[j] == "/": i = j + 1; continue
            i += 1; continue
        if c in "'\"":
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                if text[j] == "\\": j += 1
                j += 1
            if j < n and text[j] == c: out.append((line, text[i + 1:j])); i = j + 1; continue
            i += 1; continue   # not a string (apostrophe in text)
        if c == "`":
            start_line = line; i, content, nl = scan_template(i + 1)
            for k, part in enumerate(content.split("\n")):
                if part: out.append((start_line + k, part))
            line += nl; continue
        i += 1
    yield from sorted(out)


def path_strings(text: str) -> list[str]:
    """For route matching: every string as a path candidate; templates with :p per ${…} (nested templates count as an expression),
    concatenations 'a' + x + 'b' as a:pb."""
    out: list[str] = []; i, n = 0, len(text)
    def tmpl(j: int) -> tuple[int, str]:
        cur = ""
        while j < n:
            c = text[j]
            if c == "\\": cur += text[j + 1:j + 2]; j += 2; continue
            if c == "`": return j + 1, cur
            if c == "$" and text[j + 1:j + 2] == "{":
                depth = 1; j += 2
                while j < n and depth:
                    if text[j] == "`": j, _ = tmpl(j + 1); continue
                    if text[j] in "'\"":
                        q = text[j]; j += 1
                        while j < n and text[j] != q and text[j] != "\n": j += 2 if text[j] == "\\" else 1
                    elif text[j] == "{": depth += 1
                    elif text[j] == "}": depth -= 1
                    j += 1
                cur += ":p"; continue
            cur += c; j += 1
        return j, cur
    pieces: list[tuple[int, str]] = []   # (position, content) for concatenations
    while i < n:
        c = text[i]
        if c == "`":
            i2, content = tmpl(i + 1); pieces.append((i, content)); i = i2; continue
        if c in "'\"":
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n": j += 2 if text[j] == "\\" else 1
            if j < n and text[j] == c: pieces.append((i, text[i + 1:j])); i = j + 1; continue
        i += 1
    for k, (pos, content) in enumerate(pieces):
        out.append(content)
        # concatenation: 'a' + x + 'b'; join the strings in between with :p
        joined = content; last = pos + len(content) + 2
        for pos2, c2 in pieces[k + 1:]:
            between = text[last:pos2]
            if re.fullmatch(r"\s*\+\s*(?:[A-Za-z_$][\w$.()\[\]]*\s*\+\s*)?", between): joined += (":p" if "+" in between.strip("+ ") or re.search(r"[A-Za-z_$]", between) else "") + c2; last = pos2 + len(c2) + 2; out.append(joined)
            else: break
    return out


def _files(repo: Path):
    for p in sorted(repo.rglob("*")):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file() or p.suffix not in SOURCE_SUFFIXES or p.stat().st_size > 2_000_000: continue
        try: yield rel.as_posix(), p.read_text(encoding="utf-8", errors="replace")
        except OSError: continue


def frontend_mentions(repo: Path, tables: set[str]) -> list[dict]:
    """Every place where a frontend source file names a table name as a word in a string: [{ table, path, line, text }]."""
    res = {t: re.compile(r"(?<![A-Za-z0-9_])" + re.escape(t) + r"(?![A-Za-z0-9_])") for t in tables}
    out: list[dict] = []
    for rel, text in _files(repo):
        if not is_frontend_source(rel, text): continue
        src = text
        if rel.endswith((".vue", ".svelte")): src = "\n".join(m.group(1) for m in re.finditer(r"<script[^>]*>([\s\S]*?)</script>", text))   # only the script part
        for line, content in string_tokens(src):
            for t, r in res.items():
                if r.search(content): out.append({"table": t, "path": rel, "line": line, "text": content[:80], "_literal": content[:4000]})
    # only mentions in code count, not prose; the same rule as the skeleton (rule mentions)
    if out:
        from .rules import RulesUnavailable, run_rule
        try: counts = run_rule("mentions", {"items": [{"literal": m["_literal"], "table": m["table"]} for m in out]})["counts"]
        except RulesUnavailable: counts = [True] * len(out)   # without the rule every hit counts; everydeck-check reports the missing node elsewhere
        out = [m for m, c in zip(out, counts) if c]
    for m in out: m.pop("_literal", None)
    return out


def reads_table(b: dict, repo: Path) -> list[dict]:
    """The cross-check as a table, per table of the app map: found in the frontend (places), placement (main navigation with access path / technical with reason), evidence.
    A row without evidence is open: a mention covered by neither shown nor not_shown."""
    tables = {t["name"]: t for t in b.get("tables", [])}
    mentions = frontend_mentions(repo, set(tables))
    rows = []
    for name, t in tables.items():
        shown = [s for s in (t.get("shown") or []) if s.get("element") == "data"] + [s for s in (t.get("shown") or []) if s.get("element") != "data"] + [s for c in t["columns"] for s in (c.get("shown") or [])]
        ms = [m for m in mentions if m["table"] == name]
        if shown:
            first = shown[0]; vias = sorted({s.get("via") or s.get("element") for s in shown})
            rows.append({"table": name, "found": len(ms), "placement": "main", "via": vias, "evidence": f"{first['path']}:{first['line']}" + (f" {first['via']}" if first.get("via") else ""), "open": []})
            continue
        ns = t.get("not_shown") or []
        uncovered = [m for m in ms if not any(x["path"] == m["path"] and abs(int(x["line"]) - m["line"]) <= 3 for x in ns)]
        reasons = sorted({x["fact"] for x in ns})
        rows.append({"table": name, "found": len(ms), "placement": "technical", "via": [], "evidence": "; ".join(f"{x['path']}:{x['line']} {x['fact']}" for x in ns[:3]) + (" …" if len(ns) > 3 else "") if ns else ("no mention in the frontend" if not ms else ""), "facts": reasons, "open": [f"{m['path']}:{m['line']}" for m in uncovered]})
    return rows


def reads_markdown(rows: list[dict]) -> str:
    lines = ["| Table | found in the frontend | placement | evidence |", "|---|---|---|---|"]
    for r in rows:
        place = f"main navigation ({', '.join(r['via'])})" if r["placement"] == "main" else ("technical: " + ("; ".join(r.get("facts") or []) or "not named in the frontend"))
        ev = r["evidence"] if not r["open"] else f"**open: {', '.join(r['open'][:3])}**"
        lines.append(f"| `{r['table']}` | {r['found']} | {place} | {ev} |")
    return "\n".join(lines)
