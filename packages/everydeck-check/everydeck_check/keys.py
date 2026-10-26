"""The key that can only upload source maps (`evd_smp_…`, EVERYDECK_SOURCEMAPS_KEY) is secret. This check refuses it where it would leak:

- under a public name (VITE_, NEXT_PUBLIC_, PUBLIC_, EXPO_PUBLIC_, REACT_APP_) in an env file or in the code: the bundler puts such values into the
  public code;
- in built code (dist, build, out, .next, .output, .vercel/output, .svelte-kit/output and folders given with --build);
- in a file git tracks, or in an env file git does not ignore.

The value never appears in the output: only the file, the line and the name."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

KEY = re.compile(r"evd_smp_[0-9a-f]{40}")
NAME = "EVERYDECK_SOURCEMAPS_KEY"
PUBLIC_PREFIXES = ("VITE_", "NEXT_PUBLIC_", "PUBLIC_", "EXPO_PUBLIC_", "REACT_APP_")
ENV_FILE = re.compile(r"^\.env(\.[A-Za-z0-9_.-]+)?$")
ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
PUBLIC_NAME_IN_CODE = re.compile(r"\b((?:" + "|".join(PUBLIC_PREFIXES) + r")[A-Z0-9_]*" + NAME + r")\b")
BUILD_PARTS = {"dist", "build", "out", ".output", ".next", ".vercel", ".svelte-kit"}
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "cache"}
MAX_BYTES = 5 * 1024 * 1024
REVOKE = "revoke this key under Technical in everydeck and issue a new one"


def _git(repo: Path, *a: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True)


def _tracked(repo: Path) -> set[str]:
    r = _git(repo, "ls-files", "-z")
    return set(x for x in r.stdout.split("\0") if x) if r.returncode == 0 else set()


def _ignored(repo: Path, rel: str) -> bool:
    return _git(repo, "check-ignore", "-q", rel).returncode == 0


def _text(p: Path, skipped: list[dict[str, Any]] | None = None, rel: str = "") -> str | None:
    try:
        size = p.stat().st_size
        if size > MAX_BYTES:
            # not silently - the result names every file it did not read
            if skipped is not None and len(skipped) < 50: skipped.append({"path": rel, "bytes": size})
            return None
        b = p.read_bytes()
    except OSError:
        return None
    return None if b"\0" in b[:4096] else b.decode("utf-8", errors="replace")


def _public(name: str) -> bool:
    return name.startswith(PUBLIC_PREFIXES)


def key_findings(repo: Path, builds: list[str] | None = None) -> dict[str, Any]:
    repo = repo.resolve()
    tracked = _tracked(repo)
    extra = [b.strip("/") for b in (builds or [])]
    errors: list[dict[str, Any]] = []
    set_in: list[str] = []
    skipped: list[dict[str, Any]] = []
    for d, dirs, files in os.walk(repo):
        rel_d = os.path.relpath(d, repo)
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        parts = set(Path(rel_d).parts)
        in_build = bool(parts & BUILD_PARTS) or any(rel_d == b or rel_d.startswith(b + "/") for b in extra)
        for f in sorted(files):
            rel = f if rel_d == "." else f"{rel_d}/{f}"
            text = None
            if ENV_FILE.match(f):
                text = _text(Path(d) / f, skipped, rel) or ""
                for i, line in enumerate(text.splitlines(), 1):
                    m = ENV_LINE.match(line)
                    if not m: continue
                    name, value = m.group(1), m.group(2)
                    if _public(name) and (name.endswith(NAME) or KEY.search(value)):
                        errors.append({"kind": "public_name", "path": rel, "line": i, "name": name,
                                       "fact": f"{name} is a public name: the bundler puts its value into the code every visitor downloads",
                                       "fix": f"remove {name}, {REVOKE}, and set it only as {NAME}"})
                    elif name == NAME and KEY.search(value):
                        set_in.append(rel)
                at = next((i for i, line in enumerate(text.splitlines(), 1) if KEY.search(line)), None)
                if at is not None and rel not in tracked and not _ignored(repo, rel):
                    errors.append({"kind": "not_ignored", "path": rel, "line": at, "name": NAME,
                                   "fact": f"{rel} holds a source map upload key and git does not ignore it: the next commit would take the key",
                                   "fix": f"add {f} to .gitignore (for example a line *.local or .env*) before the next commit"})
            if rel in tracked:
                text = text if text is not None else _text(Path(d) / f, skipped, rel)
                if text is None: continue
                for i, line in enumerate(text.splitlines(), 1):
                    if KEY.search(line):
                        errors.append({"kind": "tracked", "path": rel, "line": i, "name": NAME,
                                       "fact": f"{rel} is tracked by git and holds a source map upload key",
                                       "fix": f"remove it from the file and from the history you have not pushed yet, {REVOKE}, and keep it only in a git-ignored env file"})
                        break
                    m = PUBLIC_NAME_IN_CODE.search(line)
                    if m and not ENV_FILE.match(f):
                        errors.append({"kind": "public_name", "path": rel, "line": i, "name": m.group(1),
                                       "fact": f"the code reads {m.group(1)}, a public name: the bundler would put the key into the public code",
                                       "fix": f"do not read the key in the app's code at all: only the build plugin reads {NAME}"})
                        break
            elif in_build:
                text = _text(Path(d) / f, skipped, rel)
                if text and KEY.search(text):
                    errors.append({"kind": "in_build", "path": rel, "name": NAME,
                                   "fact": f"the built file {rel} contains a source map upload key: it is public once deployed",
                                   "fix": f"find where the code or config reads it (a public name), remove that, rebuild, and {REVOKE}"})
    errors.sort(key=lambda e: (e["path"], e["kind"]))
    out: dict[str, Any] = {"status": "ok" if not errors else "refused", "errors": errors, "set_in": sorted(set(set_in))}
    if skipped:
        out["skipped"] = skipped
        out["skipped_note"] = f"{len(skipped)} file(s) larger than {MAX_BYTES} bytes were not checked for keys; check them yourself"
    return out
