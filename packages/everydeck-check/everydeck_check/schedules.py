"""Planned work that stands in the repo without a package: pg_cron in SQL (cron.schedule, the way Supabase schedules its functions), crons in
vercel.json, cron services in render.yaml and the schedule of a GitHub Actions workflow. Each one found becomes its own open part of the setup (a jobs[]
entry at its place closes it). everydeck's own schedules (outbox relay, read bridge: names that start with everydeck) are none of the app.

What is not searched stays visible: a host file that names a schedule everydeck-check does not read (netlify.toml, wrangler.toml, fly.toml, railway, …), or a
known file it cannot read, goes into `not_checked`. Schedules set only in a dashboard (of the host, of Supabase) or in an external cron service are not in the
repo at all; the instruction asks the agent for them.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .detect import SCHEMA_FILE_MAX, SKIP_DIRS

# pg_cron: cron.schedule('name', 'expr', …) or cron.schedule('expr', …) (unnamed); a later cron.unschedule('name') takes it back
PG_SCHEDULE = re.compile(r"""\bcron\.schedule(?:_in_database)?\s*\(\s*(?:'([^']{1,200})'|\$\w*\$)?\s*(?:,\s*'([^']{1,100})')?""", re.I)
PG_UNSCHEDULE = re.compile(r"""\bcron\.unschedule\s*\(\s*'([^']{1,200})'""", re.I)
# host files that can carry a schedule, which everydeck-check does not read
OTHER_HOSTS = ("netlify.toml", "wrangler.toml", "wrangler.json", "wrangler.jsonc", "fly.toml", "railway.json", "railway.toml", "cron.yaml", "app.yaml", "Procfile", ".gitlab-ci.yml", "bitbucket-pipelines.yml")
NAMES_SCHEDULE = re.compile(r"\b(cron|crons|schedule|schedules|scheduled)\b", re.I)
SHOWN = 50   # the inventory lists at most this many schedules (schema maxItems); more stay open as not checked


def _files(repo: Path):
    for p in sorted(repo.rglob("*")):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file(): continue
        yield rel, p


def _line_of(lines: list[str], start: int, needle: re.Pattern[str]) -> int | None:
    for i in range(start, len(lines)):
        if needle.search(lines[i]): return i + 1
    return None


def _own(name: str) -> bool:
    return name.lower().startswith("everydeck")


# SQL comments (-- to the end of the line, /* … */): blanked with the same length, so line numbers stay; a schedule in a comment is an example, not a schedule
SQL_COMMENT = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)


def _no_comments(text: str) -> str:
    return SQL_COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def _placeholder(name: str) -> bool:
    return "<" in name or ">" in name


def _pg_cron(rel: Path, text: str, out: list[dict[str, Any]], dropped: set[str]) -> None:
    text = _no_comments(text)
    for m in PG_UNSCHEDULE.finditer(text): dropped.add(m.group(1))
    for m in PG_SCHEDULE.finditer(text):
        first, second = m.group(1), m.group(2)
        if first is None and second is None: continue
        name, every = (first, second) if second is not None else (None, first)
        if name and (_own(name) or _placeholder(name)): continue
        line = text.count("\n", 0, m.start()) + 1
        out.append({"source": "pg_cron", "name": name or f"{rel.as_posix()}:{line}", "every": every or "?", "evidence": {"path": rel.as_posix(), "line": line, "symbol": "cron.schedule"}})


def _vercel(rel: Path, text: str, out: list[dict[str, Any]], not_checked: list[dict[str, str]]) -> None:
    try: crons = json.loads(text).get("crons") or []
    except (ValueError, AttributeError):
        if NAMES_SCHEDULE.search(text): not_checked.append({"path": rel.as_posix(), "why": "not readable as JSON, its crons not read"})
        return
    lines = text.split("\n"); at = 0
    for c in crons:
        if not isinstance(c, dict) or not isinstance(c.get("path"), str) or not isinstance(c.get("schedule"), str): continue
        start = _line_of(lines, at, re.compile(re.escape(json.dumps(c["path"])))) or 1
        line = _line_of(lines, start - 1, re.compile(r'"schedule"\s*:')) or start
        at = line
        out.append({"source": "vercel", "name": c["path"], "every": c["schedule"], "evidence": {"path": rel.as_posix(), "line": line, "symbol": "schedule"}})


def _render(rel: Path, text: str, out: list[dict[str, Any]]) -> None:
    """render.yaml without a YAML library: each item of services (a line `- ` at the indentation of the first item) with type cron, its name and schedule."""
    lines = text.split("\n")
    items: list[list[tuple[int, str]]] = []; indent: int | None = None
    for i, l in enumerate(lines):
        m = re.match(r"^(\s*)-\s+(.*)$", l)
        if m and (indent is None or len(m.group(1)) == indent):
            indent = len(m.group(1)); items.append([(i, m.group(2))])
        elif items and l.strip() and (indent is None or len(l) - len(l.lstrip()) > indent): items[-1].append((i, l.strip()))
    for it in items:
        kv = {}
        for i, l in it:
            m = re.match(r"^([A-Za-z_]+):\s*(.*?)\s*$", l)
            if m: kv[m.group(1)] = (m.group(2).strip("'\""), i)
        if kv.get("type", ("",))[0] != "cron" or "schedule" not in kv: continue
        name = kv.get("name", (f"{rel.as_posix()}:{it[0][0] + 1}",))[0]
        out.append({"source": "render", "name": name, "every": kv["schedule"][0], "evidence": {"path": rel.as_posix(), "line": kv["schedule"][1] + 1, "symbol": "schedule"}})


def _workflow(rel: Path, text: str, out: list[dict[str, Any]]) -> None:
    """A GitHub Actions workflow: each `- cron:` under `schedule:` of `on:`; the name is the workflow's name (or its file), a second cron gets #2."""
    lines = text.split("\n")
    m = next((re.match(r"^name:\s*(.+?)\s*$", l) for l in lines if re.match(r"^name:", l)), None)
    name = m.group(1).strip("'\"") if m else rel.stem
    if _own(name) or _own(rel.stem): return
    in_schedule = False; k = 0
    for i, l in enumerate(lines):
        if re.match(r"^\s*schedule:\s*$", l): in_schedule = True; continue
        c = re.match(r"""^\s*-\s*cron:\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$""", l)
        if in_schedule and c:
            k += 1
            out.append({"source": "github_actions", "name": name if k == 1 else f"{name}#{k}", "every": c.group(1).strip(), "evidence": {"path": rel.as_posix(), "line": i + 1, "symbol": "cron"}})
        elif in_schedule and l.strip() and not l.lstrip().startswith("#") and not c and not re.match(r"^\s*-", l): in_schedule = False


def detect_schedules(repo: Path) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """(schedules found, files not checked); each schedule {source, name, every, evidence}."""
    out: list[dict[str, Any]] = []; not_checked: list[dict[str, str]] = []; dropped: set[str] = set()
    for rel, p in _files(repo):
        name = rel.name; r = rel.as_posix()
        if p.stat().st_size > SCHEMA_FILE_MAX: continue
        if p.suffix == ".sql": _pg_cron(rel, p.read_text(encoding="utf-8", errors="replace"), out, dropped)
        elif name == "vercel.json": _vercel(rel, p.read_text(encoding="utf-8", errors="replace"), out, not_checked)
        elif name in ("render.yaml", "render.yml"): _render(rel, p.read_text(encoding="utf-8", errors="replace"), out)
        elif re.match(r"^\.github/workflows/[^/]+\.ya?ml$", r): _workflow(rel, p.read_text(encoding="utf-8", errors="replace"), out)
        elif name in OTHER_HOSTS:
            text = p.read_text(encoding="utf-8", errors="replace")
            if (m := NAMES_SCHEDULE.search(text)): not_checked.append({"path": r, "why": f"names a schedule (line {text.count(chr(10), 0, m.start()) + 1}) that everydeck-check does not read"})
    found = [s for s in out if not (s["source"] == "pg_cron" and s["name"] in dropped)]
    seen: set[tuple[str, str]] = set(); uniq = []
    for s in found:   # the same named job scheduled again in a later migration replaces it (pg_cron): keep the last place
        key = (s["source"], s["name"])
        if key in seen: uniq = [x for x in uniq if (x["source"], x["name"]) != key]
        seen.add(key); uniq.append(s)
    if len(uniq) > SHOWN:   # nothing falls away silently: the rest stays open as not checked, under the file of the first one left out
        rest = uniq[SHOWN:]
        not_checked.append({"path": rest[0]["evidence"]["path"], "why": f"{len(rest)} more schedules than everydeck-check lists ({SHOWN}), not listed"})
    return uniq[:SHOWN], not_checked[:SHOWN]
