"""B37 Baustein 2 – verschobene Fundstellen neu verankern, nur aus Fakten (git und Syntaxbaum), ohne Freigabe.

Jede Fundstelle des Befunds (ein Objekt mit `path` und `line`) gilt für den Stand `commit`. Nach einer Änderung der App stehen Zeilen woanders.
everydeck sieht den Code nicht – das Neuverankern läuft dort, wo der Code ist (im Wächter auf GitHub oder beim Agenten), in dieser Reihenfolge:

  1. git: die Zeile ist zwischen `commit` und HEAD unverändert geblieben (auch in einer umbenannten Datei) → neue Zeilennummer aus dem Diff.
  2. Text: die Zeile wurde verschoben (Diff sieht Löschen + Einfügen) und ihr Text steht in der neuen Datei genau einmal → diese Zeile.
  3. Symbol: die Fundstelle nennt ein Symbol und die Datei definiert es genau einmal → steht der alte Text im Körper genau einmal, diese Zeile,
     sonst die Zeile der Definition.
Sonst bleibt die Fundstelle offen (`unresolved`) – nichts wird geraten.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any, Iterator

HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _git(repo: Path, *args: str) -> str | None:
    try:
        return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout
    except Exception:
        return None


def places(doc: Any, at: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
    """Jede Fundstelle im Befund mit ihrem Ort (z. B. `flows[0].signals[1].evidence`) – ein Objekt mit Datei und Zeile (nicht `database`)."""
    if isinstance(doc, dict):
        if isinstance(doc.get("path"), str) and isinstance(doc.get("line"), int) and doc["path"] != "database":
            yield at, doc
        for k, v in doc.items():
            yield from places(v, f"{at}.{k}" if at else k)
    elif isinstance(doc, list):
        for i, v in enumerate(doc):
            yield from places(v, f"{at}[{i}]")


def _hunks(repo: Path, base: str, head: str, old: str, new: str) -> list[tuple[int, int, int, int]]:
    out = _git(repo, "diff", "-U0", "--no-color", "--no-ext-diff", base, head, "--", old, new) if old != new else _git(repo, "diff", "-U0", "--no-color", "--no-ext-diff", base, head, "--", old)
    if old != new:   # umbenannte Datei: Inhalte direkt vergleichen
        out = _git(repo, "diff", "-U0", "--no-color", "--no-ext-diff", f"{base}:{old}", f"{head}:{new}")
    hs: list[tuple[int, int, int, int]] = []
    for ln in (out or "").splitlines():
        m = HUNK.match(ln)
        if m:
            hs.append((int(m.group(1)), int(m.group(2) or 1), int(m.group(3)), int(m.group(4) or 1)))
    return hs


def _map_line(hunks: list[tuple[int, int, int, int]], line: int) -> int | None:
    """Zeile im alten Stand → Zeile im neuen Stand; None, wenn die Zeile selbst geändert oder gelöscht wurde."""
    shift = 0
    for a, b, _c, d in hunks:
        if b == 0:   # reine Einfügung nach Zeile a
            if line > a: shift += d
            continue
        if line < a: break
        if line <= a + b - 1: return None
        shift += d - b
    return line + shift


def _functions(repo: Path, rel: str, text: str) -> list[dict[str, Any]] | None:
    from .befund import JS_FILE, PY_FILE, _py_functions
    if PY_FILE.search(rel):
        r = _py_functions(text)
        return r if isinstance(r, list) else None
    if JS_FILE.search(rel):
        from .rules import RulesUnavailable, run_rule
        try:
            r = run_rule("functions", {"repo": str(repo), "paths": [rel]})["files"][rel]
        except (RulesUnavailable, KeyError):
            return None
        return r if isinstance(r, list) else None
    return None


def reanchor(b: dict[str, Any], repo: Path, base: str | None = None) -> dict[str, Any]:
    """Verankert alle Fundstellen von `base` (Standard: `commit` des Befunds) auf HEAD um; ändert `b` und liefert den Bericht."""
    repo = repo.resolve()
    head = (_git(repo, "rev-parse", "HEAD") or "").strip() or None
    base = base or b.get("commit")
    rep: dict[str, Any] = {"base": base, "head": head, "places": 0, "unchanged": 0, "moved": 0, "by_text": 0, "by_symbol": 0, "renamed_files": {}, "unresolved": []}
    if not head:
        rep["error"] = "not a git repository"; return rep
    if not base or _git(repo, "cat-file", "-e", f"{base}^{{commit}}") is None:
        rep["error"] = f"commit {str(base)[:12]} of the Befund is not in this clone (fetch it: git fetch --depth=1 origin {base})"; return rep
    renames: dict[str, str] = {}; deleted: set[str] = set()
    for ln in (_git(repo, "diff", "-M", "--name-status", "--no-color", base, head) or "").splitlines():
        parts = ln.split("\t")
        if parts[0].startswith("R") and len(parts) == 3: renames[parts[1]] = parts[2]
        elif parts[0] == "D" and len(parts) == 2: deleted.add(parts[1])
    changed = set((_git(repo, "diff", "--name-only", "--no-color", base, head) or "").split())
    hunk_cache: dict[str, list[tuple[int, int, int, int]]] = {}; old_text: dict[str, list[str]] = {}; new_text: dict[str, list[str] | None] = {}; fn_cache: dict[str, list[dict[str, Any]] | None] = {}

    def lines_new(rel: str) -> list[str] | None:
        if rel not in new_text:
            p = repo / rel
            new_text[rel] = p.read_text(encoding="utf-8", errors="replace").splitlines() if p.is_file() else None
        return new_text[rel]

    def lines_old(rel: str) -> list[str]:
        if rel not in old_text: old_text[rel] = (_git(repo, "show", f"{base}:{rel}") or "").splitlines()
        return old_text[rel]

    for at, ev in places(b):
        rep["places"] += 1
        old_path = ev["path"]; old_line = ev["line"]
        new_path = renames.get(old_path, old_path)
        if old_path not in changed and new_path == old_path:
            rep["unchanged"] += 1; continue
        # die Datei gab es am Commit des Befunds nicht (z. B. eine Fundstelle, die nach einer Umbenennung von Hand nachgetragen wurde): git kann nichts
        # verschieben – die Fundstelle bleibt, wie sie ist, und die Prüfung urteilt über sie
        if old_path not in renames and _git(repo, "cat-file", "-e", f"{base}:{old_path}") is None:
            rep["unchanged"] += 1; rep.setdefault("not_at_base", []).append(at); continue
        if old_path in deleted:
            rep["unresolved"].append({"at": at, "path": old_path, "line": old_line, "reason": "file deleted"}); continue
        if new_path != old_path: rep["renamed_files"][old_path] = new_path
        key = f"{old_path}\0{new_path}"
        if key not in hunk_cache: hunk_cache[key] = _hunks(repo, base, head, old_path, new_path)
        mapped = _map_line(hunk_cache[key], old_line)
        if mapped is not None:
            if mapped != old_line or new_path != old_path: rep["moved"] += 1
            else: rep["unchanged"] += 1
            ev["path"] = new_path; ev["line"] = mapped; continue
        old = lines_old(old_path); text = old[old_line - 1].strip() if 0 < old_line <= len(old) else ""
        new = lines_new(new_path)
        if new is None:
            rep["unresolved"].append({"at": at, "path": old_path, "line": old_line, "reason": "file missing"}); continue
        hits = [i + 1 for i, l in enumerate(new) if text and len(text) >= 4 and l.strip() == text]
        if len(hits) == 1:
            ev["path"] = new_path; ev["line"] = hits[0]; rep["by_text"] += 1; continue
        sym = ev.get("symbol")
        if sym:
            if new_path not in fn_cache: fn_cache[new_path] = _functions(repo, new_path, "\n".join(new))
            defs = [f for f in (fn_cache[new_path] or []) if sym in (f["name"], f["qualified"])]
            if len(defs) == 1:
                d = defs[0]
                inside = [i for i in range(d["start"], d["end"] + 1) if text and i <= len(new) and new[i - 1].strip() == text]
                ev["path"] = new_path; ev["line"] = inside[0] if len(inside) == 1 else d["start"]; rep["by_symbol"] += 1; continue
        rep["unresolved"].append({"at": at, "path": old_path, "line": old_line, "reason": "line changed" + (f" and {sym} is not defined exactly once" if sym else " and its text is not found exactly once")})
    b["commit"] = head
    return rep
