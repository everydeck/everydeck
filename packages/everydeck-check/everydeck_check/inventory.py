"""The inventory, what everydeck-check finds in the repo itself, apart from what the agent describes.

`validate --repo` writes it into the app map (field `inventory`, never edited by hand): building blocks (detect.py), provider packages (also imported by URL),
flow candidates (the same search as the cross-check of the app map, one per way of a kind), every table of the schema, schedules without a package
(pg_cron, vercel.json, render.yaml, GitHub Actions; schedules.py), what was not read (files over the size limit, code in
languages everydeck-check does not read), and short excerpts of the code at the places found (redacted with everydeck's own rules, never from SQL or data
files: the schema goes as table and column names, rows never). With the version of the tool, the commit and a digest over the content. everydeck turns every finding into an
open part of the setup that only a flow, a channel, a money entry or an outcome closes; a finding missing from the description cannot disappear by leaving it
out. "Nothing found" in code that was not read means "not inspected", not "not there".
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from importlib import metadata
from pathlib import Path
from typing import Any

import re

from . import rules
from .app_map import candidate_ways, detect_providers, detect_tables, scan_candidates
from .schedules import detect_schedules
from .detect import CODE_EXT, CODE_FILE_MAX, NPM, PACKAGE_DEPTH, PY, SCHEMA_FILE_MAX, SKIP_DIRS, _match, detect_blocks

# code that everydeck-check does not read: a backend in this language is "not inspected"; native shells of an app (ios/, android/) are no backend
UNSUPPORTED = {".go": "go", ".rb": "ruby", ".php": "php", ".java": "java", ".kt": "kotlin", ".cs": "csharp", ".ex": "elixir", ".exs": "elixir", ".rs": "rust", ".scala": "scala"}
NATIVE_DIRS = {"ios", "android", "macos", "windows", "linux", "Pods", "gradle"}
SKIPPED_SHOWN = 50   # the inventory lists at most this many skipped files (schema maxItems); the count of files read stays exact
PACKAGE_FILES = {"package.json", "requirements.txt", "requirements-dev.txt", "pyproject.toml", "Pipfile", "pubspec.yaml"}
# excerpts: at most this many, each a window of lines from EXCERPT_BEFORE above the place, all together at most this many characters (the review of
# everydeck reads them once per setup; the schema allows 4000 characters per excerpt)
EXCERPT_MAX = 60
EXCERPT_LINES = 13
EXCERPT_BEFORE = 4
EXCERPT_TOTAL_CHARS = 40_000
EXCERPT_TEXT_MAX = 4000
EXCERPT_LINE_CHARS = 300
# never an excerpt from these: SQL carries rows (seeds, inserts in migrations), the others data or configuration
NO_EXCERPT = {".sql", ".json", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".lock", ".env", ".txt", ".md"}


def _version() -> str:
    try: return f"everydeck-check {metadata.version('everydeck-check')}"
    except metadata.PackageNotFoundError: return "everydeck-check (source)"


def _commit(repo: Path) -> str | None:
    try:
        p = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
        return p.stdout.strip() or None if p.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def canonical(obj: Any) -> str:
    """The text the digest is taken over; everydeck computes the same (sorted keys, no spaces, non-ASCII as \\uXXXX)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest_of(inv: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical({k: v for k, v in inv.items() if k != "digest"}).encode("ascii")).hexdigest()


def _scanned(repo: Path) -> dict[str, Any]:
    files = 0; skipped: list[dict[str, str]] = []; other: dict[str, list[str]] = {}
    for p in sorted(repo.rglob("*")):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file(): continue
        if p.name in PACKAGE_FILES and len(rel.parts) > PACKAGE_DEPTH:
            skipped.append({"path": rel.as_posix(), "why": f"deeper than {PACKAGE_DEPTH} folders, dependencies not read"})
        if p.suffix in CODE_EXT or p.suffix == ".sql":
            files += 1
            size = p.stat().st_size
            if p.suffix in CODE_EXT and size > CODE_FILE_MAX: skipped.append({"path": rel.as_posix(), "why": f"larger than {CODE_FILE_MAX // 1000} KB, code hints not read"})
            elif size > SCHEMA_FILE_MAX: skipped.append({"path": rel.as_posix(), "why": f"larger than {SCHEMA_FILE_MAX // 1_000_000} MB, tables not read"})
        elif p.suffix in UNSUPPORTED and not any(part in NATIVE_DIRS for part in rel.parts):
            other.setdefault(UNSUPPORTED[p.suffix], []).append(rel.as_posix())
    return {"files": files, "skipped": skipped[:SKIPPED_SHOWN], "unsupported": [{"language": lang, "files": len(ps), "example": ps[0]} for lang, ps in sorted(other.items())]}


def build_inventory(repo: Path, app_map: dict[str, Any]) -> dict[str, Any]:
    tables = detect_tables(repo)
    known = set(tables) | {t["name"] for t in app_map.get("tables", [])}
    first = {c["id"]: c for c in candidate_ways(scan_candidates(repo, known))}   # each way of a kind, not only the first place
    providers = []
    for name, where in sorted(detect_providers(repo).items()):
        block = _match(name, NPM) or PY.get(name.lower())
        if block: providers.append({"package": name, "block": block, "evidence": where[:300]})
    used = _money_uses(repo, tables)
    schedules, not_checked = detect_schedules(repo)   # planned work without a package
    scanned = _scanned(repo)
    if not_checked: scanned["not_checked"] = not_checked
    inv: dict[str, Any] = {
        "scanner": _version(), "commit": _commit(repo), "digest": "",
        "scanned": scanned,
        "blocks": [{"block": d.block, "evidence": d.evidence[:300]} for d in detect_blocks(repo)],
        "providers": providers,
        "candidates": [first[k] for k in sorted(first)],
        "tables": [{"table": n, "evidence": w[:300], **({"used": u} if (u := used.get(n)) else {})} for n, w in sorted(tables.items())],
        **({"schedules": schedules} if schedules else {}),
    }
    inv["excerpts"] = _excerpts(repo, inv)
    inv["digest"] = digest_of(inv)
    return inv


def _money_uses(repo: Path, tables: dict[str, str]) -> dict[str, str]:
    """EVX 7.2: for each money table (everydeck's word list, from the rules) the first place where the code reads or writes it, found the same way validate
    refuses a not_applicable. A money table that is only a name stays without a place; without node no places (the parts stay as weak as before)."""
    from .app_map import _first_use, _table_use
    try:
        money = rules.run_rule("money_tables", {"names": sorted(tables)})["money"]
    except (rules.RulesUnavailable, KeyError, ValueError, OSError):
        return {}
    out: dict[str, str] = {}
    for t in money:
        if (where := _first_use(repo, _table_use(t))): out[t] = where[:300]
    return out


def _places(inv: dict[str, Any]) -> list[tuple[str, int | None, str | None]]:
    """Where to cut an excerpt, most telling first: sign-in and payment, new rows from the browser, other writes and triggers, then providers by file."""
    rank = {"auth": 0, "payment": 0}
    cands = sorted(inv["candidates"], key=lambda c: (rank.get(c["source"], 1 if c.get("kind") == "insert" else 2), c["id"]))
    out: list[tuple[str, int | None, str | None]] = [(c["evidence"]["path"], c["evidence"]["line"], None) for c in cands]
    for d in [*inv["providers"], *inv["blocks"]]:
        m = re.search(r"\bin ([\w./@-]+\.[A-Za-z0-9]+)(?::(\d+))?$", d["evidence"])
        if m: out.append((m.group(1), int(m.group(2)) if m.group(2) else None, d["evidence"].split(" in ")[0]))
    return out


def _excerpts(repo: Path, inv: dict[str, Any]) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []; total = 0
    for path, line, hint in _places(inv):
        if len(windows) >= EXCERPT_MAX: break
        f = repo / path
        if Path(path).suffix.lower() in NO_EXCERPT or Path(path).name.startswith(".env") or not f.is_file() or f.stat().st_size > CODE_FILE_MAX: continue
        lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        if line is None:   # a provider named by file: the first line that mentions it
            words = [w for w in re.findall(r"[\w@./-]{4,}", hint or "") if w not in {"imported", "called"}]
            line = next((i + 1 for i, l in enumerate(lines) if any(w in l for w in words)), 1)
        if any(w["path"] == path and w["line"] <= line < w["line"] + EXCERPT_LINES for w in windows): continue
        start = max(1, line - EXCERPT_BEFORE)
        text = "\n".join(l[:EXCERPT_LINE_CHARS] for l in lines[start - 1:start - 1 + EXCERPT_LINES])[:EXCERPT_TEXT_MAX]
        if not text.strip(): continue
        if total + len(text) > EXCERPT_TOTAL_CHARS: break
        windows.append({"path": path, "line": start, "text": text}); total += len(text)
    if not windows: return []
    try:
        clean = rules.run_rule("redact", {"texts": [w["text"] for w in windows]})["texts"]
    except (rules.RulesUnavailable, KeyError, ValueError, OSError):
        return []   # never an excerpt that was not redacted
    # a label may make a text longer than it was; the limit of the schema holds
    return [{**w, "text": t[:EXCERPT_TEXT_MAX]} for w, t in zip(windows, clean)]
