"""The runtimes the app really uses, read from the repository, so that the checks of the setup run with them and not with whatever this session has.
A check of the setup that imports the server with the Python of the session proves nothing for an app whose Dockerfile says python:3.11 (a backslash in an
f-string expression is valid from 3.12 on and stops the import on 3.11). In this order, every file that names a version:
- Python: the image of a Dockerfile (`FROM python:3.11…`), `.python-version`, `runtime.txt` (`python-3.11.9`), `requires-python` in pyproject.toml
  (the lowest version it allows), `python_version` in Pipfile;
- Node: `.nvmrc`, `.node-version`, `engines.node` in package.json (the lowest version it allows), the image of a Dockerfile (`FROM node:22…`).
For each language the version the deployment uses (Dockerfile, runtime file) comes first; the lowest allowed version stands for itself when nothing else
names one. Then what this session has (`python3 --version`, `node --version`) and how to run a check with the app's version without changing the
machine: `uv run --python <version> …` (uv fetches the interpreter), `docker run python:<version>` or `npx -y node@<version>`. Nothing is installed here."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .detect import PACKAGE_DEPTH, SKIP_DIRS

VERSION = re.compile(r"(\d+)\.(\d+)(?:\.(\d+))?")
FROM = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(?:docker\.io/)?(?:library/)?(python|node)(?::([^\s@]+))?", re.I | re.M)


def _files(repo: Path, names: tuple[str, ...]) -> list[Path]:
    """Files with one of these names (any `Dockerfile*` for "Dockerfile") down to PACKAGE_DEPTH folders, without node_modules and the like (never walked)."""
    out: list[Path] = []
    for root, dirs, files in os.walk(repo):
        depth = len(Path(root).relative_to(repo).parts)
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and depth < PACKAGE_DEPTH)
        out += [Path(root) / f for f in sorted(files) if f in names or ("Dockerfile" in names and f.startswith("Dockerfile"))]
    return out


def _minor(text: str) -> str | None:
    m = VERSION.search(text)
    return f"{m.group(1)}.{m.group(2)}" if m else None


def _lowest(spec: str) -> str | None:
    """The lowest version a range allows (`>=3.11`, `^20.10`, `>=18 <23`, `3.11.*`); a bare upper bound names none."""
    for part in re.split(r"\s*(?:,|\|\||\s)\s*", spec.strip()):
        part = part.strip()
        if not part or part.startswith("<") or part.startswith("!="):
            continue
        v = _minor(part) or (f"{m.group(1)}" if (m := re.match(r"^[\^~>=v]*(\d+)$", part)) else None)
        if v:
            return v
    return None


def _found(language: str, version: str, path: Path, repo: Path, line: int, kind: str) -> dict[str, Any]:
    return {"language": language, "version": version, "evidence": {"path": str(path.relative_to(repo)), "line": line}, "kind": kind}


def app_runtimes(repo: Path) -> list[dict[str, Any]]:
    """Every place in the repository that names a Python or Node version; kind `deploy` (what runs) or `allowed` (the lowest version allowed)."""
    repo = repo.resolve(); out: list[dict[str, Any]] = []
    for p in _files(repo, ("Dockerfile",)):
        text = p.read_text(encoding="utf-8", errors="replace")
        for m in FROM.finditer(text):
            v = _minor(m.group(2) or "")
            if v:
                out.append(_found(m.group(1).lower(), v, p, repo, text[: m.start()].count("\n") + 1, "deploy"))
    for name, lang in ((".python-version", "python"), ("runtime.txt", "python"), (".nvmrc", "node"), (".node-version", "node")):
        for p in _files(repo, (name,)):
            text = p.read_text(encoding="utf-8", errors="replace").strip()
            v = _minor(text) or (text.lstrip("v") if lang == "node" and re.fullmatch(r"v?\d+", text) else None)
            if v:
                out.append(_found(lang, v, p, repo, 1, "deploy"))
    for p in _files(repo, ("pyproject.toml",)):
        text = p.read_text(encoding="utf-8", errors="replace")
        m = re.search(r'^\s*requires-python\s*=\s*["\']([^"\']+)["\']', text, re.M)
        if m and (v := _lowest(m.group(1))):
            out.append(_found("python", v, p, repo, text[: m.start()].count("\n") + 1, "allowed"))
    for p in _files(repo, ("Pipfile",)):
        text = p.read_text(encoding="utf-8", errors="replace")
        m = re.search(r'^\s*python_version\s*=\s*["\']([^"\']+)["\']', text, re.M)
        if m and (v := _minor(m.group(1))):
            out.append(_found("python", v, p, repo, text[: m.start()].count("\n") + 1, "deploy"))
    for p in _files(repo, ("package.json",)):
        try:
            engines = json.loads(p.read_text(encoding="utf-8", errors="replace")).get("engines") or {}
        except (ValueError, AttributeError):
            continue
        spec = engines.get("node") if isinstance(engines, dict) else None
        if isinstance(spec, str) and (v := _lowest(spec)):
            text = p.read_text(encoding="utf-8", errors="replace")
            out.append(_found("node", v, p, repo, text[: text.find('"node"')].count("\n") + 1 if '"node"' in text else 1, "allowed"))
    return out


def _session(cmd: list[str]) -> str | None:
    if not shutil.which(cmd[0]):
        return None
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return _minor(r.stdout + r.stderr)


def runtime_report(repo: Path, session: dict[str, str | None] | None = None) -> dict[str, Any]:
    """Per language the version to check with (the one the deployment uses, else the lowest allowed), what this session has and how to run with the app's."""
    found = app_runtimes(repo)
    have = session if session is not None else {"python": _session(["python3", "--version"]), "node": _session(["node", "--version"])}
    uv = shutil.which("uv") is not None; docker = shutil.which("docker") is not None
    langs: list[dict[str, Any]] = []
    for lang in ("python", "node"):
        mine = [f for f in found if f["language"] == lang]
        if not mine:
            continue
        pick = next((f for f in mine if f["kind"] == "deploy"), mine[0])
        want = pick["version"]; got = have.get(lang)
        same = got is not None and (got == want if lang == "python" else got.split(".")[0] == want.split(".")[0])
        if lang == "python":
            run = f"uv run --python {want} --with-requirements <requirements file> python -c 'import <module>'" if uv else (f"docker run --rm -v \"$PWD\":/app -w /app python:{want} …" if docker else None)
        else:
            run = f"npx -y node@{want.split('.')[0]} <script>" if shutil.which("npx") else (f"docker run --rm -v \"$PWD\":/app -w /app node:{want.split('.')[0]} …" if docker else None)
        langs.append({"language": lang, "app": want, "from": pick["evidence"], "session": got, "same": same, "run_with": None if same else run,
                      "remark": None if same or run else f"not tested with {'Python' if lang == 'python' else 'Node'} {want}: this session has {got or 'none'} and neither uv nor docker"})
    return {"status": "ok" if all(x["same"] or x["run_with"] for x in langs) else "remark", "runtimes": langs, "found": found}
