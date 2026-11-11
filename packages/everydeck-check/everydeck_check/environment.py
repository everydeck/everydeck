"""The environment of the app, read before anything is built in (`inventory.environment`). everydeck-check describes, its apply command executes.

- `workspaces`: the workspace manifests and the package roots they name (workspaces.py); a pattern that names nothing is listed as unmatched.
- `servers`: every server entry in a form everydeck-check knows (Deno.serve, also through a shared module, the old std `serve`, Bun.serve, a default
  export with fetch, Express, Fastify, Koa, Hono, node:http, Next.js route handlers and API routes, FastAPI, Starlette, Flask, Django) with the line of the
  SDK that hooks into it, or none where the SDK has no ready-made hook; and `unknown`: each place where a server entry belongs (an Edge Function's
  index, api/, netlify/functions/) in no known form. Never guessed, never left out: the agent and everydeck see it before the setup builds anything in.
- `monitoring`: Sentry and PostHog already in the app: packages, initialization, hooks (beforeSend, error boundaries, before_send), consent
  (PostHog opt_out_capturing_by_default, opt_in_capturing, cookieless mode) and build plugins.
- `transformations`: changes to the app that the setup needs, each checked here: the exact lines before and after, the digest of the file (apply only
  when it is unchanged) and `checked` (applied in memory, the result no longer has the conflict and nothing else changed). Today one: Sentry's build
  plugin that deletes the .map files after its own upload (filesToDeleteAfterUpload, deleteSourcemapsAfterUpload) before everydeck's plugin runs.
- `release_age`: the minimum age of packages the app's tools install (pnpm minimumReleaseAge, npm min-release-age, uv exclude-newer): everydeck then
  names a checked set of its packages that is old enough (apps/http/src/packages.ts), never a version the environment refuses.
"""
from __future__ import annotations

import hashlib
import os
import posixpath
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .detect import CODE_EXT, CODE_FILE_MAX, SKIP_DIRS, repo_files
from .workspaces import workspace_roots

SERVERS_MAX = 200
UNKNOWN_MAX = 50
MONITORING_MAX = 100
TRANSFORMATIONS_MAX = 20

# (form, runtime, pattern, the SDK line that hooks into it or None)
FORMS: list[tuple[str, str, re.Pattern[str], str | None]] = [
    ("deno_serve", "deno", re.compile(r"\bDeno\.serve\s*\("), "Deno.serve(everydeckServe(everydeck, handler))"),
    ("bun_serve", "bun", re.compile(r"\bBun\.serve\s*\("), None),
    ("fetch_export", "fetch", re.compile(r"(?m)^\s*export\s+default\s*\{\s*(?:\n\s*)*(?:async\s+)?fetch\b"), None),
    ("express", "node", re.compile(r"\bexpress\s*\(\s*\)"), "everydeckExpress(app, everydeck)"),
    ("fastify", "node", re.compile(r"\b[Ff]astify\s*\(\s*[{)]"), None),
    ("koa", "node", re.compile(r"\bnew\s+Koa\s*\("), None),
    ("hono", "fetch", re.compile(r"\bnew\s+Hono\s*[<(]"), None),
    ("node_http", "node", re.compile(r"\bhttps?\.createServer\s*\("), None),
    ("fastapi", "python", re.compile(r"\bFastAPI\s*\("), "app.add_middleware(EverydeckMiddleware, everydeck=everydeck)"),
    ("starlette", "python", re.compile(r"\bStarlette\s*\("), "app.add_middleware(EverydeckMiddleware, everydeck=everydeck)"),
    ("flask", "python", re.compile(r"\bFlask\s*\(\s*__name__"), None),
    ("django", "python", re.compile(r"\bget_(?:wsgi|asgi)_application\s*\("), None),
]
# a word each form needs, checked before its pattern (a scan reads thousands of files)
HINT = {"deno_serve": "Deno.serve", "bun_serve": "Bun.serve", "fetch_export": "fetch", "express": "express", "fastify": "astify", "koa": "Koa", "hono": "Hono",
        "node_http": "createServer", "fastapi": "FastAPI", "starlette": "Starlette", "flask": "Flask", "django": "_application"}
# the old Deno standard library: `serve` imported from deno.land/std/http/server.ts
STD_SERVE_IMPORT = re.compile(r"""import\s*\{[^}]*\bserve\b[^}]*\}\s*from\s*['"]https://deno\.land/std[^'"]*/http/server\.ts['"]""")
STD_SERVE = re.compile(r"(?m)^\s*(?:await\s+)?serve\s*\(")
NEXT_ROUTE = re.compile(r"(^|/)app/(?:.+/)?route\.[jt]sx?$")
NEXT_ROUTE_EXPORT = re.compile(r"(?m)^\s*export\s+(?:async\s+function\s+|function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b")
NEXT_API = re.compile(r"(^|/)pages/api/.+\.[jt]sx?$")
DEFAULT_EXPORT = re.compile(r"(?m)^\s*export\s+default\b")
REL_IMPORT = re.compile(r"""(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}/[^'"]+)['"]""")
# where a server entry belongs: an Edge Function's index (not _shared, not everydeck's own), Vercel's api/ folder, Netlify functions
EDGE_INDEX = re.compile(r"(^|/)supabase/functions/(?!_|everydeck-)[^/]+/index\.(?:ts|js|mjs|tsx|jsx)$")
# Vercel: api/ at the root of the repository or of a project with vercel.json, also in subfolders; a folder or file starting with _ is no function
API_DIR = re.compile(r"^(?:(.+)/)?api/(?:[^/_][^/]*/)*[^/_][^/]*\.(?:ts|js|mjs|cjs)$")
# what Vercel and Netlify take as the function of a file: a default export (also the result of the app's own wrapper), module.exports, named HTTP methods
SERVERLESS_DEFAULT = re.compile(r"(?m)^\s*export\s+default\b|^\s*module\.exports\s*=|^\s*export\s+(?:async\s+function|function|const)\s+(?:GET|POST|PUT|PATCH|DELETE)\b")
WRAPPED_DEFAULT = re.compile(r"(?m)^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*\(")
NETLIFY_HANDLER = re.compile(r"(?m)^\s*export\s+(?:const\s+handler\b|(?:async\s+)?function\s+handler\b)|^\s*exports\.handler\s*=")
NETLIFY_FN = re.compile(r"(^|/)netlify/functions/[^/]+\.(?:ts|js|mjs|cjs)$")
EVERYDECK_OWN = re.compile(r"(^|/)supabase/functions/everydeck-")

COMMENT = ("//", "#", "*", "/*")


def _code(repo: Path, files: list[Path] | None = None) -> list[tuple[str, str]]:
    out = []
    for p in (files if files is not None else repo_files(repo)):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file() or p.suffix not in CODE_EXT or p.stat().st_size > CODE_FILE_MAX: continue
        try: out.append((rel.as_posix(), p.read_text(encoding="utf-8", errors="replace")))
        except OSError: continue
    return out


def _line(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _live(text: str, m: re.Match[str]) -> bool:
    """The match is code, not a comment line."""
    start = text.rfind("\n", 0, m.start()) + 1
    return not text[start:m.start()].lstrip().startswith(COMMENT) and not text[start:].lstrip().startswith(COMMENT)


def _form(rel: str, text: str, place: str | None = None) -> tuple[str, str, int, str | None] | None:
    # a function of the host: Vercel (export default function handler(req, res)), Netlify (export const handler, or export default async (req, context))
    if place and "Netlify" in place and (m := NETLIFY_HANDLER.search(text) or SERVERLESS_DEFAULT.search(text)): return "netlify_function", "node", _line(text, m.start()), None
    if place and "(api/)" in place and (m := SERVERLESS_DEFAULT.search(text)): return "vercel_function", "node", _line(text, m.start()), None
    if NEXT_ROUTE.search(rel) and (m := NEXT_ROUTE_EXPORT.search(text)): return "next_route", "node", _line(text, m.start()), "everydeckRoute(everydeck, handler)"
    if NEXT_API.search(rel) and (m := DEFAULT_EXPORT.search(text)): return "next_api", "node", _line(text, m.start()), "everydeckApiRoute(everydeck, handler)"
    for form, runtime, rx, hook in FORMS:
        if rel.endswith(".py") != (runtime == "python") or HINT[form] not in text: continue
        for m in rx.finditer(text):
            if _live(text, m): return form, runtime, _line(text, m.start()), hook
    if STD_SERVE_IMPORT.search(text) and (m := STD_SERVE.search(text)): return "deno_std_serve", "deno", _line(text, m.start()), "serve(everydeckServe(everydeck, handler))"
    return None


def _entry_place(rel: str, vercel: set[str]) -> str | None:
    """Why this file is a place where a server entry belongs (None: it is not one). `vercel`: the folders with a vercel.json."""
    if EDGE_INDEX.search(rel): return "an Edge Function in no form everydeck-check knows (no Deno.serve, serve or default fetch)"
    if NETLIFY_FN.search(rel): return "a Netlify function in no form everydeck-check knows"
    if (m := API_DIR.match(rel)) and (m.group(1) or "") in vercel | {""}: return "a server function (api/) in no form everydeck-check knows"
    return None


def _resolve(code: dict[str, str], rel: str, imp: str) -> str | None:
    base = posixpath.normpath(f"{posixpath.dirname(rel)}/{imp}")
    return next((c for c in (base, *(base + x for x in (".ts", ".js", ".mjs", ".tsx", "/index.ts", "/index.js"))) if c in code), None)


def server_entries(repo: Path, files: list[Path] | None = None, code_list: list[tuple[str, str]] | None = None) -> dict[str, Any]:
    files = files if files is not None else repo_files(repo)
    code = dict(code_list if code_list is not None else _code(repo, files)); entries: list[dict[str, Any]] = []; unknown: list[dict[str, str]] = []
    vercel = {("" if (d := p.parent.relative_to(repo).as_posix()) == "." else d) for p in files if p.name == "vercel.json"}
    for rel, text in sorted(code.items()):
        if EVERYDECK_OWN.search(rel) or "/_shared/" in rel: continue
        place = _entry_place(rel, vercel)
        got = _form(rel, text, place)
        if got:
            form, runtime, line, hook = got
            entry = {"path": rel, "line": line, "form": form, "runtime": runtime, "hookup": hook}
            # the function is the result of the app's own wrapper (export default route('POST', …) from api/_lib): name the module of the wrapper
            if form in ("vercel_function", "netlify_function") and (w := WRAPPED_DEFAULT.search(text)):
                src = re.search(rf"""import\s*(?:\{{[^}}]*\b{re.escape(w.group(1))}\b[^}}]*\}}|{re.escape(w.group(1))})\s*from\s*['"](\.{{1,2}}/[^'"]+)['"]""", text)
                if src and (target := _resolve(code, rel, src.group(1))): entry["via"] = target
            entries.append(entry)
            continue
        if place is None: continue
        # an Edge Function that serves through a module of its own (supabase/functions/_shared/serve.ts with Deno.serve)
        via = None
        for imp in REL_IMPORT.findall(text):
            target = _resolve(code, rel, imp)
            if target and (inner := _form(target, code[target])) and inner[0] in ("deno_serve", "deno_std_serve"):
                via = (target, inner); break
        if via:
            target, (form, runtime, line, hook) = via
            call = next((i + 1 for i, l in enumerate(text.splitlines()) if re.search(r"\w+\s*\(", l) and not l.lstrip().startswith(("import", "export", *COMMENT))), 1)
            entries.append({"path": rel, "line": call, "form": form, "runtime": runtime, "hookup": hook, "via": f"{target}:{line}"})
        else:
            unknown.append({"path": rel, "why": place})
    out: dict[str, Any] = {"entries": entries[:SERVERS_MAX], "unknown": unknown[:UNKNOWN_MAX]}
    if len(entries) > SERVERS_MAX or len(unknown) > UNKNOWN_MAX: out["counts"] = {"entries": len(entries), "unknown": len(unknown)}
    return out


# --- Sentry and PostHog already in the app -------------------------------------------------------------------------------------------------------------

TOOL_WORD = {"sentry": re.compile(r"sentry", re.I), "posthog": re.compile(r"posthog", re.I)}
NPM_TOOL = re.compile(r'"(@sentry/[\w.-]+|posthog-js|posthog-node|posthog-react-native|@posthog/[\w.-]+)"\s*:')
PY_TOOL = re.compile(r"(?im)^\s*[\"']?(sentry-sdk|posthog)(?:\[[^\]]*\])?\s*(?:[=<>!~;\"' ,]|$)")
SIGNS: list[tuple[str, str, re.Pattern[str]]] = [
    ("sentry", "build_plugin", re.compile(r"\b(?:sentryVitePlugin|sentryWebpackPlugin|sentryRollupPlugin|sentryEsbuildPlugin|withSentryConfig)\s*\(|\bnew\s+SentryWebpackPlugin\s*\(")),
    ("sentry", "init", re.compile(r"\bSentry\.init\s*\(|\bsentry_sdk\.init\s*\(")),
    ("sentry", "hook", re.compile(r"\bbeforeSend(?:Transaction|Span)?\s*[:(]|\bbeforeBreadcrumb\s*[:(]|\bbefore_send(?:_transaction)?\s*=|\bSentry\.ErrorBoundary\b|\bwithErrorBoundary\s*\(")),
    ("posthog", "init", re.compile(r"\bposthog\.init\s*\(|\bnew\s+PostHog\s*\(|<PostHogProvider\b|\bPosthog\s*\(")),
    ("posthog", "hook", re.compile(r"\bbefore_send\s*:")),
    ("posthog", "consent", re.compile(r"\bopt_out_capturing_by_default\b|\.opt_in_capturing\s*\(|\.opt_out_capturing\s*\(|\bcookieless_mode\b")),
]
PACKAGE_NAMES = {"package.json", "requirements.txt", "requirements-dev.txt", "pyproject.toml", "Pipfile"}


def monitoring(repo: Path, files: list[Path] | None = None, code_list: list[tuple[str, str]] | None = None) -> list[dict[str, Any]]:
    files = files if files is not None else repo_files(repo)
    out: list[dict[str, Any]] = []

    def add(tool: str, kind: str, rel: str, line: int, detail: str) -> None:
        if len(out) < MONITORING_MAX: out.append({"tool": tool, "kind": kind, "path": rel, "line": line, "detail": detail[:160]})
    for p in files:
        rel = p.relative_to(repo)
        if p.name not in PACKAGE_NAMES or any(part in SKIP_DIRS for part in rel.parts) or not p.is_file(): continue
        text = p.read_text(encoding="utf-8", errors="replace")
        rx = NPM_TOOL if p.name == "package.json" else PY_TOOL
        for m in rx.finditer(text):
            name = m.group(1).lower(); add("sentry" if "sentry" in name else "posthog", "package", rel.as_posix(), _line(text, m.start(1)), name)
    for rel, text in (code_list if code_list is not None else _code(repo, files)):
        # a file counts for a tool only where code (not a comment) names it
        tools = {tool for tool, rx in TOOL_WORD.items() if tool in text.lower() and any(_live(text, m) for m in rx.finditer(text))}
        for tool, kind, rx in SIGNS:
            if tool not in tools: continue
            for m in rx.finditer(text):
                if _live(text, m): add(tool, kind, rel, _line(text, m.start()), m.group(0).strip())
    out.sort(key=lambda m: (m["path"], m["line"], m["tool"], m["kind"]))
    return out


# --- the source map conflict as a checked transformation -----------------------------------------------------------------------------------------------

DELETE_AFTER = re.compile(r"\bfilesToDeleteAfterUpload\s*:\s*")
DELETE_FLAG = re.compile(r"\bdeleteSourcemapsAfterUpload\s*:\s*true\b")
STRING = re.compile(r"""'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`""")
WHY = ("Sentry's build plugin deletes the .map files after its own upload (in writeBundle), before everydeck's plugin runs (in closeBundle), so everydeck "
       "finds none. Keep the rest of Sentry's setup: everydeck's plugin removes every .map from the output after its upload, also when that fails.")


def _maps(glob: str) -> bool:
    """The pattern deletes source maps: it ends in .map (also *.js.map, *.{js,map})."""
    g = glob.strip("'\"`")
    return bool(re.search(r"\.map$|\.\{[^}]*\bmap\b[^}]*\}$|\.(?:js|css|mjs|cjs)\.map$", g))


def _array_end(text: str, start: int) -> int | None:
    """Index after the `]` that closes the `[` at start (strings skipped), or None."""
    depth = 0; i = start
    while i < len(text):
        if (s := STRING.match(text, i)): i = s.end(); continue
        if text[i] == "[": depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0: return i + 1
        i += 1
    return None


def _lines(text: str, a: int, b: int) -> tuple[int, int, str]:
    """(first line, last line, the text of these whole lines) around text[a:b]."""
    s = text.rfind("\n", 0, a) + 1; e = text.find("\n", b); e = len(text) if e < 0 else e
    return _line(text, a), _line(text, b), text[s:e]


def _transform(text: str, rel: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []; digest = "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
    for m in DELETE_AFTER.finditer(text):
        if not _live(text, m): continue
        v = m.end(); base = {"id": "sentry_keeps_source_maps", "path": rel, "file_digest": digest, "why": WHY}
        if text.startswith("[", v) and (end := _array_end(text, v)):
            items = STRING.findall(text[v + 1:end - 1]); rest = STRING.sub("", text[v + 1:end - 1])
            if re.sub(r"[\s,]", "", rest):   # something other than string literals (a spread, a variable)
                a, b, before = _lines(text, m.start(), end)
                out.append({**base, "line": a, "end_line": b, "before": before, "after": None, "checked": False, "why_not": "the list is not written out as strings here; remove its .map patterns by hand"}); continue
            if not any(_maps(x) for x in items): continue
            new = "[" + ", ".join(x for x in items if not _maps(x)) + "]"
            span = (v, end)
        elif (s := STRING.match(text, v)):
            if not _maps(s.group(0)): continue
            new = "[]"; span = (v, s.end())
        else:
            a, b, before = _lines(text, m.start(), m.end() + 40)
            out.append({**base, "line": a, "end_line": a, "before": before.split("\n")[0], "after": None, "checked": False, "why_not": "the value is not written out here (a variable or a call); remove its .map patterns by hand"}); continue
        a, b, before = _lines(text, m.start(), span[1])
        s0 = text.rfind("\n", 0, m.start()) + 1
        after = before[: span[0] - s0] + new + before[span[1] - s0:]
        changed = text[:s0] + after + text[s0 + len(before):]
        ok = changed.replace(after, "", 1) == text.replace(before, "", 1) and not _transform_needed(changed[s0:s0 + len(after)])
        out.append({**base, "line": a, "end_line": b, "before": before, "after": after, "checked": ok})
    for m in DELETE_FLAG.finditer(text):
        if not _live(text, m): continue
        a, b, before = _lines(text, m.start(), m.end())
        s0 = text.rfind("\n", 0, m.start()) + 1
        after = before[: m.start() - s0] + "deleteSourcemapsAfterUpload: false" + before[m.end() - s0:]
        out.append({"id": "sentry_keeps_source_maps", "path": rel, "file_digest": digest, "why": WHY, "line": a, "end_line": b, "before": before, "after": after, "checked": not DELETE_FLAG.search(after)})
    return out


def _transform_needed(snippet: str) -> bool:
    """After the change: does the snippet still delete .map files?"""
    m = DELETE_AFTER.search(snippet)
    if not m: return False
    v = m.end()
    if snippet.startswith("[", v) and (end := _array_end(snippet, v)): return any(_maps(x) for x in STRING.findall(snippet[v + 1:end - 1]))
    s = STRING.match(snippet, v)
    return bool(s and _maps(s.group(0)))


def source_map_transformations(repo: Path, code_list: list[tuple[str, str]] | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for rel, text in (code_list if code_list is not None else _code(repo)):
        if not TOOL_WORD["sentry"].search(text) or not (DELETE_AFTER.search(text) or DELETE_FLAG.search(text)): continue
        out += _transform(text, rel)
    return out[:TRANSFORMATIONS_MAX]


# --- minimum release age of the app's tools -----------------------------------------------------------------------------------------------------------

DURATION = re.compile(r"^\s*(?:P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?)?|(\d+)\s*(hours?|days?|weeks?))\s*$", re.I)


def _setting(text: str, rx: str) -> tuple[str, int] | None:
    m = re.search(rx, text, re.M)
    return (m.group(1).strip().strip("'\""), _line(text, m.start())) if m else None


def _uv_rule(value: str) -> dict[str, Any]:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00")); return {"before": value}
    except ValueError: pass
    if (m := DURATION.match(value)) and any(m.groups()):
        w, d, h, n, unit = m.groups()
        hours = int(n) * {"h": 1, "d": 24, "w": 168}[unit[0].lower()] if n else int(w or 0) * 168 + int(d or 0) * 24 + int(h or 0)
        return {"hours": hours}
    return {"understood": False}


def release_age(repo: Path, files: list[Path] | None = None) -> list[dict[str, Any]]:
    """The settings in the app's files, and in .npmrc next to them also when git leaves it out (it often carries a token, never read here)."""
    out: list[dict[str, Any]] = []
    files = files if files is not None else repo_files(repo)
    seen = set(files); npmrc: list[Path] = []
    for d, dirs, names in os.walk(repo):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS and x != "node_modules"]
        if ".npmrc" in names and (Path(d) / ".npmrc") not in seen: npmrc.append(Path(d) / ".npmrc")
        if len(npmrc) >= 20: break
    for p in [*files, *npmrc]:
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file() or p.name not in ("pnpm-workspace.yaml", ".npmrc", "pyproject.toml", "uv.toml"): continue
        text = p.read_text(encoding="utf-8", errors="replace"); at = rel.as_posix()
        if p.name == "pnpm-workspace.yaml" and (s := _setting(text, r"^minimumReleaseAge\s*:\s*(\S+)")):
            out.append({"tool": "pnpm", "setting": "minimumReleaseAge", "value": s[0], **({"hours": -(-int(s[0]) // 60)} if s[0].isdigit() else {"understood": False}), "path": at, "line": s[1]})
        if p.name == ".npmrc":
            if (s := _setting(text, r"^\s*minimum-release-age\s*=\s*(\S+)")):   # pnpm reads its settings from .npmrc too (minutes)
                out.append({"tool": "pnpm", "setting": "minimum-release-age", "value": s[0], **({"hours": -(-int(s[0]) // 60)} if s[0].isdigit() else {"understood": False}), "path": at, "line": s[1]})
            if (s := _setting(text, r"^\s*min-release-age\s*=\s*(\S+)")):        # npm 11.10: days
                out.append({"tool": "npm", "setting": "min-release-age", "value": s[0], **({"hours": int(s[0]) * 24} if s[0].isdigit() else {"understood": False}), "path": at, "line": s[1]})
        if p.name in ("pyproject.toml", "uv.toml"):
            body = text if p.name == "uv.toml" else (m.group(0) if (m := re.search(r"(?ms)^\[tool\.uv\]\s*$.*?(?=^\[|\Z)", text)) else "")
            if body and (s := _setting(body, r"^\s*exclude-newer\s*=\s*(.+?)\s*$")):
                line = s[1] + (_line(text, text.find(body)) - 1 if p.name == "pyproject.toml" else 0)
                out.append({"tool": "uv", "setting": "exclude-newer", "value": s[0], **_uv_rule(s[0]), "path": at, "line": line})
    out.sort(key=lambda r: (r["path"], r["line"]))
    return out


def detect_environment(repo: Path) -> dict[str, Any]:
    """`inventory.environment`: only the parts that have something (an app without any of it carries no field)."""
    files = repo_files(repo); code = _code(repo, files)   # once per scan, shared by every part
    manifests, _ = workspace_roots(repo, files)
    servers = server_entries(repo, files, code)
    parts: dict[str, Any] = {
        "workspaces": manifests, "servers": servers if servers["entries"] or servers["unknown"] else None,
        "monitoring": monitoring(repo, files, code), "transformations": source_map_transformations(repo, code), "release_age": release_age(repo, files),
    }
    return {k: v for k, v in parts.items() if v}
