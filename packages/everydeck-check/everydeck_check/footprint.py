"""The footprint of the setup in the app's repository: which files the change adds and changes against the commit before the setup, whether a lockfile
was rewritten beyond the new packages, and what was left behind (browser automation folders, screenshots, scripts with a probe id). Facts from git only."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

LOCKFILES = ("package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "poetry.lock", "uv.lock", "Pipfile.lock")
MEDIA = re.compile(r"\.(png|jpe?g|gif|webp|webm|mp4|mov|har|trace|zip)$", re.I)
LEFT_DIRS = re.compile(r"(^|/)(\.playwright-mcp|\.playwright|playwright-report|test-results)/")
PROBE = re.compile(r"""probe_?[iI]d\W{1,8}["'`][0-9a-f]{8}-|everydeck_(?:start|end)_probe""")   # a fixed probe id or the probe tools; an app client that reads one from its environment is none


def _git(repo: Path, *a: str) -> str:
    return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True, check=True).stdout


def _lock_entries(text: str) -> dict[str, Any]:
    try: return json.loads(text).get("packages", {}) or {}
    except ValueError: return {}


def _npm_lock_report(repo: Path, base: str, rel: str) -> dict[str, Any] | None:
    try: old = _git(repo, "show", f"{base}:{rel}")
    except subprocess.CalledProcessError: return None   # new lockfile: nothing rewritten
    a, b = _lock_entries(old), _lock_entries((repo / rel).read_text(encoding="utf-8"))
    removed = sorted(k for k in a if k and k not in b)
    changed = sorted(k for k in a if k and k in b and a[k] != b[k])
    return {"file": rel, "removed": removed[:50], "changed": changed[:50]} if removed or changed else None


def _text_lock_report(repo: Path, base: str, rel: str) -> dict[str, Any] | None:
    diff = _git(repo, "diff", "-U0", base, "--", rel)
    gone = [l[1:].strip() for l in diff.split("\n") if l.startswith("-") and not l.startswith("---") and "everydeck" not in l]
    return {"file": rel, "removed": gone[:20], "changed": []} if gone else None


def fix_npm_lock(repo: Path, base: str, rel: str) -> None:
    """The lockfile as it was before the setup, plus only the packages the change adds and the root's new dependencies."""
    old = json.loads(_git(repo, "show", f"{base}:{rel}")); new = json.loads((repo / rel).read_text(encoding="utf-8"))
    pk = old.setdefault("packages", {})
    pk[""] = new.get("packages", {}).get("", pk.get(""))
    for k, v in (new.get("packages") or {}).items():
        if k and k not in pk: pk[k] = v
    old["packages"] = {"": pk[""], **{k: pk[k] for k in sorted(k for k in pk if k)}}
    (repo / rel).write_text(json.dumps(old, indent=2) + "\n", encoding="utf-8")


def footprint(repo: Path, base: str, fix_lock: bool = False) -> dict[str, Any]:
    status = [l.split("\t") for l in _git(repo, "diff", "--name-status", "-M", base).strip().split("\n") if l]
    untracked = [l for l in _git(repo, "ls-files", "--others", "--exclude-standard").strip().split("\n") if l]
    added = [s[-1] for s in status if s[0].startswith("A")]
    changed = [s[-1] for s in status if not s[0].startswith(("A", "D"))]
    locks = []
    for rel in changed:
        name = rel.split("/")[-1]
        if name not in LOCKFILES: continue
        if name in ("package-lock.json", "npm-shrinkwrap.json"):
            if fix_lock: fix_npm_lock(repo, base, rel)
            rep = _npm_lock_report(repo, base, rel)
        else: rep = _text_lock_report(repo, base, rel)
        if rep: locks.append({**rep, "fix": f"everydeck-check footprint --base {base} --fix-lock" if name in ("package-lock.json", "npm-shrinkwrap.json") else f"git checkout {base} -- {rel}, then add only the new packages"})
    left: list[dict[str, str]] = []; dirs: set[str] = set()
    for rel in added + untracked:
        m = LEFT_DIRS.search(rel)
        if m:
            d = rel[: m.end()].lstrip("/")
            if d not in dirs: dirs.add(d); left.append({"path": d, "fact": "a folder of browser automation, not part of the app"})
        elif MEDIA.search(rel): left.append({"path": rel, "fact": "a screenshot, video or trace"})
        elif (repo / rel).is_file() and re.search(r"\.(m?[jt]sx?|py|sh)$", rel) and PROBE.search((repo / rel).read_text(encoding="utf-8", errors="replace")): left.append({"path": rel, "fact": "a script that uses the probe run, only for verifying the setup"})
    return {"status": "ok" if not locks and not left else "refused", "base": base, "files_added": len(added), "files_changed": len(changed),
            "added": added[:200], "changed": changed[:200], "untracked": untracked[:200], "lockfiles": locks, "leftovers": left}
