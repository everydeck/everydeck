"""The roots of the app's packages from its workspace manifests, not from a fixed folder depth.

A monorepo says itself where its packages are: `pnpm-workspace.yaml` (packages), `workspaces` in package.json (npm, Yarn, Bun), `lerna.json` (packages),
`workspace` in deno.json or deno.jsonc, `[tool.uv.workspace] members` in pyproject.toml (with exclude). Every folder such a pattern names and that holds a
package file is a root: everydeck-check reads its dependencies however deep it lies. A package file deeper than PACKAGE_DEPTH that no workspace names stays
unread and is listed as skipped (never left out silently); a pattern that names no folder with a package file is listed as unmatched.
Globs as the package managers read them: `*` one folder, `**` any number, `{a,b}`, a leading `!` excludes.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

PACKAGE_FILES = ("package.json", "pyproject.toml", "requirements.txt", "requirements-dev.txt", "Pipfile", "pubspec.yaml", "deno.json", "deno.jsonc")
MANIFEST_FILES = ("pnpm-workspace.yaml", "package.json", "lerna.json", "deno.json", "deno.jsonc", "pyproject.toml")
SKIP = {".git", "node_modules"}


def _glob(pattern: str) -> re.Pattern[str]:
    p = pattern.strip().lstrip("./").rstrip("/"); out = ""; i = 0
    while i < len(p):
        if p.startswith("**/", i): out += "(?:.*/)?"; i += 3
        elif p.startswith("**", i): out += ".*"; i += 2
        elif p[i] == "*": out += "[^/]*"; i += 1
        elif p[i] == "?": out += "[^/]"; i += 1
        elif p[i] == "{" and (j := p.find("}", i)) > i: out += "(?:" + "|".join(re.escape(x) for x in p[i + 1:j].split(",")) + ")"; i = j + 1
        else: out += re.escape(p[i]); i += 1
    return re.compile(out + r"\Z")


def _jsonc(text: str) -> Any:
    """deno.jsonc: JSON with // and /* */ comments and trailing commas (strings stay)."""
    out = re.sub(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/', lambda m: m.group(0) if m.group(0).startswith('"') else "", text, flags=re.S)
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", out))


def _yaml_list(text: str, key: str) -> list[str]:
    """The entries of a top-level list `key:` in a simple YAML file (pnpm-workspace.yaml), also in flow form [a, b]."""
    m = re.search(rf"(?m)^{re.escape(key)}\s*:\s*(\[[^\]]*\])?\s*$", text)
    if not m: return []
    if m.group(1): return [x.strip().strip("'\"") for x in m.group(1)[1:-1].split(",") if x.strip()]
    out = []
    for line in text[m.end():].split("\n")[1:]:
        if not line.strip() or line.lstrip().startswith("#"): continue
        if not line.startswith((" ", "\t", "-")): break
        if (e := re.match(r"\s*-\s*(.+?)\s*(?:#.*)?$", line)): out.append(e.group(1).strip().strip("'\""))
    return out


def _toml_list(text: str, section: str, key: str) -> list[str]:
    m = re.search(rf"(?ms)^\[{re.escape(section)}\]\s*$(.*?)(?=^\[|\Z)", text)
    if not m: return []
    k = re.search(rf"(?ms)^\s*{re.escape(key)}\s*=\s*\[(.*?)\]", m.group(1))
    return re.findall(r"""["']([^"']+)["']""", k.group(1)) if k else []


def manifests_of(repo: Path, rel: str, text: str) -> dict[str, Any] | None:
    """The workspace patterns one file declares (kind, patterns with ! for excludes), or None."""
    name = rel.rsplit("/", 1)[-1]
    try:
        if name == "pnpm-workspace.yaml": kind, pats = "pnpm", _yaml_list(text, "packages")
        elif name == "package.json":
            w = json.loads(text).get("workspaces"); kind = "npm"
            pats = w if isinstance(w, list) else (w.get("packages") if isinstance(w, dict) else None) or []
        elif name == "lerna.json": kind, pats = "lerna", json.loads(text).get("packages") or []
        elif name in ("deno.json", "deno.jsonc"): kind, pats = "deno", (_jsonc(text) or {}).get("workspace") or []
        elif name == "pyproject.toml": kind, pats = "uv", _toml_list(text, "tool.uv.workspace", "members") + ["!" + x for x in _toml_list(text, "tool.uv.workspace", "exclude")]
        else: return None
    except (ValueError, AttributeError):
        return None
    pats = [p for p in pats if isinstance(p, str) and p.strip()]
    return {"path": rel, "kind": kind, "patterns": pats} if pats else None


def package_dirs(repo: Path, files: list[Path]) -> set[str]:
    """Every folder (relative, "" for the repository) that holds a package file."""
    return {("" if (d := p.parent.relative_to(repo).as_posix()) == "." else d) for p in files if p.name in PACKAGE_FILES}


def workspace_roots(repo: Path, files: list[Path] | None = None) -> tuple[list[dict[str, Any]], list[str]]:
    """(manifests with their roots and unmatched patterns, all roots sorted). `files`: the app's files (detect.repo_files); without, a plain walk."""
    if files is None:
        files = sorted(p for p in repo.rglob("*") if p.is_file() and not (set(p.relative_to(repo).parts) & SKIP))
    dirs = package_dirs(repo, files); manifests: list[dict[str, Any]] = []
    for p in files:
        rel = p.relative_to(repo).as_posix()
        if p.name not in MANIFEST_FILES: continue
        try: m = manifests_of(repo, rel, p.read_text(encoding="utf-8", errors="replace"))
        except OSError: continue
        if not m: continue
        base = rel.rsplit("/", 1)[0] if "/" in rel else ""
        at = (lambda x: f"{base}/{x.lstrip('./')}") if base else (lambda x: x)
        inc = [(x, _glob(at(x))) for x in m["patterns"] if not x.startswith("!")]
        exc = [_glob(at(x[1:])) for x in m["patterns"] if x.startswith("!")]
        roots = sorted(d for d in dirs if d and any(rx.match(d) for _, rx in inc) and not any(rx.match(d) for rx in exc))
        unmatched = [x for x, rx in inc if not any(rx.match(d) for d in roots)]
        manifests.append({**m, "roots": roots, **({"unmatched": unmatched} if unmatched else {})})
    manifests.sort(key=lambda m: m["path"])
    return manifests, sorted({r for m in manifests for r in m["roots"]})
