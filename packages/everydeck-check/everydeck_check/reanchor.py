"""Re-anchor places that moved, only from facts (git and syntax tree), without approval.

Every place of the app map (an object with `path` and `line`) holds for the state `commit`. After a change to the app, lines are elsewhere.
everydeck does not see the code; re-anchoring runs where the code is (in the GitHub check or at the agent), in this order:

  1. git: the line stayed unchanged between `commit` and HEAD (also in a renamed file) → new line number from the diff.
  2. text: the line was moved (the diff sees delete + insert) and its text appears exactly once in the new file → that line.
  3. symbol: the place names a symbol and the file defines it exactly once → if the old text appears exactly once in the body, that line,
     otherwise the line of the definition.
Otherwise the place stays open (`unresolved`); nothing is guessed.
"""
from __future__ import annotations

import json
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


def _git_any(repo: Path, *args: str) -> str | None:
    """git that may exit 1 with output (diff --no-index exits 1 when the files differ)."""
    try:
        r = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
        return r.stdout if r.returncode in (0, 1) else None
    except Exception:
        return None


def places(doc: Any, at: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
    """Every place in the app map with its location (e.g. `flows[0].signals[1].evidence`): an object with file and line (not `database`)."""
    if isinstance(doc, dict):
        if isinstance(doc.get("path"), str) and isinstance(doc.get("line"), int) and doc["path"] != "database":
            yield at, doc
        for k, v in doc.items():
            yield from places(v, f"{at}.{k}" if at else k)
    elif isinstance(doc, list):
        for i, v in enumerate(doc):
            yield from places(v, f"{at}[{i}]")


def _hunks(repo: Path, base: str, head: str | None, old: str, new: str) -> list[tuple[int, int, int, int]]:
    """head None: against the working tree (the agent's edits before they are committed)."""
    rhs = [head] if head else []
    out = _git(repo, "diff", "-U0", "--no-color", "--no-ext-diff", base, *rhs, "--", old)
    if old != new:   # renamed file: compare contents directly
        if head: out = _git(repo, "diff", "-U0", "--no-color", "--no-ext-diff", f"{base}:{old}", f"{head}:{new}")
        else:
            import tempfile
            with tempfile.NamedTemporaryFile("w", suffix=Path(old).suffix, delete=False) as f: f.write(_git(repo, "show", f"{base}:{old}") or "")
            try: out = _git_any(repo, "diff", "--no-index", "-U0", "--no-color", "--no-ext-diff", f.name, str(repo / new))
            finally: Path(f.name).unlink(missing_ok=True)
    hs: list[tuple[int, int, int, int]] = []
    for ln in (out or "").splitlines():
        m = HUNK.match(ln)
        if m:
            hs.append((int(m.group(1)), int(m.group(2) or 1), int(m.group(3)), int(m.group(4) or 1)))
    return hs


def _map_line(hunks: list[tuple[int, int, int, int]], line: int) -> int | None:
    """Line in the old state → line in the new state; None if the line itself was changed or deleted."""
    shift = 0
    for a, b, _c, d in hunks:
        if b == 0:   # pure insertion after line a
            if line > a: shift += d
            continue
        if line < a: break
        if line <= a + b - 1: return None
        shift += d - b
    return line + shift


def _functions(repo: Path, rel: str, text: str) -> list[dict[str, Any]] | None:
    from .app_map import JS_FILE, PY_FILE, _py_functions
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


PLACES_RECORD = "everydeck/places.json"   # in the repository's git folder (never committed): the tree the places of the app map hold for


def tree_now(repo: Path) -> str | None:
    """The files as they are now as a commit object (`git stash create`: changes nothing, no ref; without changes HEAD)."""
    return (_git(repo, "stash", "create") or "").strip() or (_git(repo, "rev-parse", "HEAD") or "").strip() or None


def record_places(repo: Path, map_rel: str) -> None:
    """Note in .git which tree the app map's places now hold for (the scaffold writes the same note); the next reanchor --worktree starts there."""
    tree = tree_now(repo); where = (_git(repo, "rev-parse", "--git-path", PLACES_RECORD) or "").strip()
    if not tree or not where: return
    f = Path(where) if Path(where).is_absolute() else repo / where
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"tree": tree, "app_map": map_rel}) + "\n", encoding="utf-8")


def _recorded_tree(repo: Path) -> str | None:
    where = (_git(repo, "rev-parse", "--git-path", PLACES_RECORD) or "").strip()
    f = Path(where) if where and Path(where).is_absolute() else repo / where if where else None
    try: tree = json.loads(f.read_text(encoding="utf-8")).get("tree") if f and f.is_file() else None
    except (OSError, ValueError): return None
    return tree if tree and _git(repo, "cat-file", "-e", f"{tree}^{{commit}}") is not None else None


def _last_map_commit(repo: Path, map_rel: str | None, commit: str | None) -> str | None:
    """The last commit that wrote the app map, when it comes after its `commit`: the places were checked against that tree when it was committed."""
    if not map_rel or not commit: return None
    last = (_git(repo, "log", "-1", "--format=%H", "--", map_rel) or "").strip()
    if not last or last.startswith(commit) or _git(repo, "merge-base", "--is-ancestor", commit, last) is None: return None
    return last


def reanchor(b: dict[str, Any], repo: Path, base: str | None = None, worktree: bool = False, map_rel: str | None = None) -> dict[str, Any]:
    """Re-anchors all places from `base` (default: the app map's `commit`) to HEAD; changes `b` and returns the report.
    With worktree=True to the files as they are now, before a commit (the agent's own edits during the setup): the places then hold
    for the working tree, `commit` stays (it becomes true with the next commit)."""
    repo = repo.resolve()
    head = (_git(repo, "rev-parse", "HEAD") or "").strip() or None
    # where the places hold: given; with --worktree the tree the scaffold or the last reanchor noted; else the last commit that wrote the app map; else its commit
    found = None if base else (_recorded_tree(repo) if worktree else None) or _last_map_commit(repo, map_rel, b.get("commit"))
    base = base or found or b.get("commit")
    rep: dict[str, Any] = {"base": base, "head": "working tree" if worktree and head else head, "places": 0, "unchanged": 0, "moved": 0, "by_text": 0, "by_symbol": 0, "renamed_files": {}, "unresolved": []}
    rhs = [] if worktree else [head or ""]
    if not head:
        rep["error"] = "not a git repository"; return rep
    if not base or _git(repo, "cat-file", "-e", f"{base}^{{commit}}") is None:
        rep["error"] = f"commit {str(base)[:12]} of the app map is not in this clone (fetch it: git fetch --depth=1 origin {base})"; return rep
    renames: dict[str, str] = {}; deleted: set[str] = set()
    for ln in (_git(repo, "diff", "-M", "--name-status", "--no-color", base, *rhs) or "").splitlines():
        parts = ln.split("\t")
        if parts[0].startswith("R") and len(parts) == 3: renames[parts[1]] = parts[2]
        elif parts[0] == "D" and len(parts) == 2: deleted.add(parts[1])
    changed = set((_git(repo, "diff", "--name-only", "--no-color", base, *rhs) or "").split())
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
        # the file did not exist at the app map's commit (e.g. a place added by hand after a rename): git cannot
        # move anything; the place stays as it is and the check judges it
        if old_path not in renames and _git(repo, "cat-file", "-e", f"{base}:{old_path}") is None:
            rep["unchanged"] += 1; rep.setdefault("not_at_base", []).append(at); continue
        if old_path in deleted:
            rep["unresolved"].append({"at": at, "path": old_path, "line": old_line, "reason": "file deleted"}); continue
        if new_path != old_path: rep["renamed_files"][old_path] = new_path
        key = f"{old_path}\0{new_path}"
        if key not in hunk_cache: hunk_cache[key] = _hunks(repo, base, None if worktree else head, old_path, new_path)
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
    if not worktree: b["commit"] = head
    return rep
