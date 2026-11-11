"""Everything mechanical of the setup in one command (`everydeck-check plan`, `everydeck-check apply`), like Sentry's wizard for the forms it knows.

The agent no longer writes what a program can write: the shared module of the Edge Functions and its import in each function, the checked
transformations the scan found (`inventory.environment.transformations`), the files everydeck generated for a live app (`everydeck_live_files`)
with their `verify_jwt` lines, and the signals of those files in the app map. `apply` then moves the places of the app map (reanchor) and checks it
(validate --repo: inventory, generated jobs, open parts), so the app map on disk is exactly what goes to everydeck.

- A plan is a list of whole-file changes, each with the digest of the file before and after; the app map gets a JSON Patch (RFC 6902) with a `test`
  before each change, the same form as the generated jobs of validate. `apply` writes a file only while it is as planned: a file someone changed since the plan
  stays as it is and is named (`changed_since_plan`); a file already as planned is left alone (`already`), so an interrupted run is simply run again.
- `apply` changes whole or not at all and writes only into the repository: the app map's patch runs on a copy and is written only when every
  operation holds and the app map is still the one the plan read (`app_map.before`); every path of the plan is resolved (symbolic links too) and must
  lie inside the repository, checked for all before the first write and again right before each. Otherwise nothing is written.
- Every form it does not know is named in `by_hand` with its place and what to do there, never guessed: an Edge Function that does not serve through
  Deno.serve (the old std `serve`, a default export with fetch, a form the scan does not know), every other server entry (Express, FastAPI, Next.js …:
  the SDK client there needs the app's keys and its error path), a transformation the scan could not check, a shared module someone changed.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import posixpath
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PLAN_VERSION = 1
SHARED_REL = "_shared/everydeck.ts"
# an Edge Function of the app: <…/>supabase/functions/<name>/index.<ext> (not _shared, not everydeck's own)
EDGE_INDEX = re.compile(r"^(?P<root>(?:.+/)?supabase/functions)/(?!_|everydeck-)(?P<name>[^/]+)/index\.(?:ts|js|mjs|tsx|jsx)$")
IMPORTS_SHARED = re.compile(r"""(?m)^\s*import\s+['"][^'"]*_shared/everydeck\.ts['"]""")
# lines that must stay before the import: a shebang and TypeScript's triple-slash directives (`/// <reference …>` only works above every statement)
KEEP_ON_TOP = re.compile(r"^(?:#!|///\s*<)")
SDK_SPEC = re.compile(r"npm:@everydeck/sdk@[^/'\"]+")
LIVE_MAX_BYTES = 4 << 20


def digest(text: str | None) -> str | None:
    return None if text is None else "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read(repo: Path, rel: str) -> str | None:
    p = repo / rel
    try: return p.read_text(encoding="utf-8") if p.is_file() else None
    except (OSError, UnicodeDecodeError): return None


def _change(rel: str, before: str | None, after: str, why: str, kind: str) -> dict[str, Any]:
    return {"path": rel, "kind": kind, "before": digest(before), "after": digest(after), "content": after, "why": why}


def with_import(text: str, line: str) -> str:
    """The function's file with `line` as its first statement (after a shebang and `/// <reference>` lines); nothing else changes."""
    rows = text.split("\n"); i = 0
    while i < len(rows) and KEEP_ON_TOP.match(rows[i]): i += 1
    return "\n".join(rows[:i] + [line] + rows[i:])


# --- the files everydeck generated (live app) ----------------------------------------------------------------------------------------------------------

def load_live(source: str) -> dict[str, Any]:
    """The files of everydeck_live_files: from the address its answer names (files_address), or a JSON file with that answer."""
    if re.match(r"^https?://", source):
        req = urllib.request.Request(source, headers={"accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read(LIVE_MAX_BYTES + 1)
        except urllib.error.HTTPError as e:
            raise SetupError(f"everydeck answered {e.code} for the files address: {e.read(500).decode('utf-8', 'replace')}") from e
        except urllib.error.URLError as e:
            raise SetupError(f"the files address did not answer: {e.reason}") from e
        if len(body) > LIVE_MAX_BYTES: raise SetupError(f"the files of everydeck are larger than {LIVE_MAX_BYTES} bytes")
        doc = json.loads(body)
    else:
        doc = json.loads(Path(source).read_text(encoding="utf-8"))
    files = doc.get("files"); signals = doc.get("app_map_signals", doc.get("signals", []))
    if not isinstance(files, list) or not all(isinstance(f, dict) and isinstance(f.get("path"), str) and isinstance(f.get("content"), str) for f in files):
        raise SetupError("the files of everydeck have no list files[] with path and content")
    return {"files": files, "signals": signals if isinstance(signals, list) else []}


class SetupError(RuntimeError):
    pass


def _safe_rel(rel: str) -> bool:
    n = posixpath.normpath(rel)
    return not (n.startswith("../") or n == ".." or n.startswith("/") or n.startswith(".git/") or "\\" in rel)


def verify_jwt_lines(text: str, slugs: list[str]) -> str:
    """supabase/config.toml with `[functions.<slug>]` and `verify_jwt = false` for each of everydeck's functions (a schedule calls them; each checks its
    own key). A section that exists keeps every other line; only its verify_jwt is set."""
    out = text
    for slug in slugs:
        head = re.compile(rf"(?m)^\[functions\.{re.escape(slug)}\]\s*$")
        m = head.search(out)
        if not m:
            out = out.rstrip("\n") + ("\n\n" if out.strip() else "") + f"[functions.{slug}]\nverify_jwt = false\n"
            continue
        nxt = re.search(r"(?m)^\[", out[m.end():]); end = m.end() + (nxt.start() if nxt else len(out) - m.end())
        body = out[m.end():end]
        new = re.sub(r"(?m)^verify_jwt\s*=.*$", "verify_jwt = false", body) if re.search(r"(?m)^verify_jwt\s*=", body) else "\nverify_jwt = false" + body
        out = out[:m.end()] + new + out[end:]
    return out


def signal_patch(doc: dict[str, Any], signals: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """JSON Patch (RFC 6902) that adds each returned signal to its flow, with a `test` of the flow's id before; (patch, flows the app map lacks)."""
    patch: list[dict[str, Any]] = []; missing: list[dict[str, Any]] = []
    flows = doc.get("flows") if isinstance(doc.get("flows"), list) else []
    for s in signals:
        flow, sig = s.get("flow"), s.get("signal")
        if not isinstance(sig, dict) or not sig.get("name"): continue
        i = next((k for k, f in enumerate(flows) if isinstance(f, dict) and f.get("id") == flow), None)
        if i is None:
            missing.append({"flow": flow, "signal": sig.get("name"), "do": f"flows[] has no flow {flow}: add it (or call everydeck_live_files without it), then run apply again"}); continue
        have = flows[i].get("signals")
        patch.append({"op": "test", "path": f"/flows/{i}/id", "value": flow})
        if not isinstance(have, list):
            patch.append({"op": "add", "path": f"/flows/{i}/signals", "value": [sig]}); continue
        j = next((k for k, x in enumerate(have) if isinstance(x, dict) and x.get("name") == sig["name"]), None)
        if j is None: patch.append({"op": "add", "path": f"/flows/{i}/signals/-", "value": sig})
        elif have[j] != sig: patch.append({"op": "replace", "path": f"/flows/{i}/signals/{j}", "value": sig})
        else: patch.pop()   # already there: nothing to test either
    return patch, missing


def _pointer(path: str) -> list[str]:
    return [p.replace("~1", "/").replace("~0", "~") for p in path.split("/")[1:]]


def apply_patch(doc: Any, patch: list[dict[str, Any]]) -> Any:
    """RFC 6902 add, remove, replace and test (what plan and the generated jobs use), whole or not at all: returns the patched copy, `doc` stays as it
    is; raises PatchFailed when a test does not hold."""
    doc = copy.deepcopy(doc)
    for op in patch:
        *parents, last = _pointer(op["path"])
        target = doc
        for k in parents: target = target[int(k)] if isinstance(target, list) else target[k]
        o = op["op"]
        if o == "test":
            cur = target[int(last)] if isinstance(target, list) else target.get(last)
            if cur != op["value"]: raise PatchFailed(f"{op['path']} is {json.dumps(cur)[:80]}, the plan read {json.dumps(op['value'])[:80]}")
        elif o == "add":
            if isinstance(target, list): target.append(op["value"]) if last == "-" else target.insert(int(last), op["value"])
            else: target[last] = op["value"]
        elif o == "replace":
            if isinstance(target, list): target[int(last)] = op["value"]
            else: target[last] = op["value"]
        elif o == "remove":
            del target[int(last) if isinstance(target, list) else last]
        else:
            raise PatchFailed(f"operation {o} is not used here")
    return doc


class PatchFailed(RuntimeError):
    pass


# --- plan ------------------------------------------------------------------------------------------------------------------------------------------------

def plan(repo: Path, app_map: dict[str, Any] | None, map_rel: str, sdk: str | None, live: dict[str, Any] | None) -> dict[str, Any]:
    """What `apply` changes and what stays by hand. Reads the code as it is now (the same scan as validate --repo), never the app map's inventory."""
    from .environment import detect_environment
    from .rules import RulesUnavailable, run_rule
    env = detect_environment(repo)
    changes: list[dict[str, Any]] = []; by_hand: list[dict[str, Any]] = []
    servers = env.get("servers") or {}
    # 1. Edge Functions: one shared module per functions folder, its import as the first line of each function that serves through Deno.serve
    roots: dict[str, list[str]] = {}
    for e in servers.get("entries", []):
        m = EDGE_INDEX.match(e["path"])
        if not m:
            by_hand.append({"path": e["path"], "line": e["line"], "form": e["form"], "kind": "server_sdk",
                            "do": (f"wire the server SDK into this server: {e['hookup']}, with the client and keys as the step keys says" if e.get("hookup")
                                   else "the server SDK has no ready hookup for this form: report its errors from its central error path with everydeck.error(…), as the guide's Step 3 says")})
            continue
        if e["form"] == "deno_serve":
            roots.setdefault(m.group("root"), []).append(e["path"])
        else:
            by_hand.append({"path": e["path"], "line": e["line"], "form": e["form"], "kind": "edge_function",
                            "do": (f"this function does not serve through Deno.serve, which the shared module wraps: wrap its handler where it serves, {e['hookup']}, "
                                   "with everydeck imported from ../_shared/everydeck.ts" if e.get("hookup") else
                                   "this function does not serve through Deno.serve, which the shared module wraps: wrap its handler with everydeckServe(everydeck, handler) where it serves, with everydeck imported from ../_shared/everydeck.ts")})
    for u in servers.get("unknown", []):
        if EDGE_INDEX.match(u["path"]):
            by_hand.append({"path": u["path"], "kind": "edge_function", "form": None, "do": f"{u['why']}: find where it serves and wrap that handler with everydeckServe(everydeck, handler) from ../_shared/everydeck.ts"})
        else:
            by_hand.append({"path": u["path"], "kind": "server_sdk", "form": None, "do": f"{u['why']}: wire the server SDK where it handles requests"})
    if roots and not sdk:
        raise SetupError("pass --sdk with the @everydeck/sdk version of the packages line (for example --sdk @everydeck/sdk@0.5.20): the shared module of the Edge Functions imports it")
    for root, paths in sorted(roots.items()):
        rel = f"{root}/{SHARED_REL}"
        module = run_rule("edge_module", {"sdk": sdk})["content"]
        now = _read(repo, rel)
        if now is None or now == module:
            if now is None: changes.append(_change(rel, None, module, "the shared module that reports server errors of every Edge Function", "edge_module"))
        elif SDK_SPEC.sub(f"npm:{sdk}", now) == module:
            changes.append(_change(rel, now, module, f"the shared module with {sdk} (it named another version)", "edge_module"))
        else:
            by_hand.append({"path": rel, "kind": "edge_module", "form": None, "do": "this file is not everydeck's module as it was written (someone changed it): it stays as it is; compare it with the module of the step keys and keep what the change needs"})
        for p in sorted(paths):
            text = _read(repo, p)
            if text is None or IMPORTS_SHARED.search(text): continue
            line = f"import '{posixpath.relpath(rel, posixpath.dirname(p))}';"
            changes.append(_change(p, text, with_import(text, line), "the import of the shared module, as the first line of the function", "edge_import"))
    # 2. the checked transformations of the scan: the exact lines, only in the file the scan read
    for t in env.get("transformations", []):
        text = _read(repo, t["path"])
        if not t.get("checked") or t.get("after") is None:
            by_hand.append({"path": t["path"], "line": t["line"], "kind": "transformation", "form": t["id"], "do": t.get("why_not") or t["why"]}); continue
        if text is None or digest(text) != t["file_digest"]: continue   # the scan read this very file a moment ago
        rows = text.split("\n"); a, b = t["line"] - 1, t["end_line"]
        if "\n".join(rows[a:b]) != t["before"]:
            by_hand.append({"path": t["path"], "line": t["line"], "kind": "transformation", "form": t["id"], "do": f"the lines are not as the scan read them: {t['why']}"}); continue
        changes.append(_change(t["path"], text, "\n".join(rows[:a] + t["after"].split("\n") + rows[b:]), t["why"], "transformation"))
    # 3. the files everydeck generated for a live app, with verify_jwt for each of its functions and the signals in the app map
    patch: list[dict[str, Any]] = []
    if live:
        slugs = []
        for f in live["files"]:
            rel = f["path"]
            if not _safe_rel(rel): raise SetupError(f"everydeck named a file outside the repository: {rel}")
            if f.get("sha256") and hashlib.sha256(f["content"].encode("utf-8")).hexdigest() != f["sha256"]: raise SetupError(f"{rel}: the content does not match its sha256")
            now = _read(repo, rel)
            if now != f["content"]: changes.append(_change(rel, now, f["content"], "a file everydeck generated for this app (everydeck_live_files)", "live_file"))
            if (m := re.match(r"^supabase/functions/(everydeck-[^/]+)/index\.ts$", rel)): slugs.append(m.group(1))
        cfg = _read(repo, "supabase/config.toml")
        if cfg is not None and slugs and (new := verify_jwt_lines(cfg, slugs)) != cfg:
            changes.append(_change("supabase/config.toml", cfg, new, "verify_jwt = false for everydeck's functions (a schedule calls them; each checks its own key)", "verify_jwt"))
        if app_map is not None:
            patch, missing = signal_patch(app_map, live["signals"])
            by_hand += [{"path": map_rel, "kind": "signal", "form": None, **m} for m in missing]
    try: map_digest = digest(_read(repo, map_rel))
    except OSError: map_digest = None
    return {"version": PLAN_VERSION, "sdk": sdk, "changes": changes, "app_map": {"path": map_rel, "before": map_digest, "patch": patch}, "by_hand": by_hand,
            "counts": {"files": len(changes), "app_map_changes": sum(1 for o in patch if o["op"] != "test"), "by_hand": len(by_hand)}}


# --- apply -----------------------------------------------------------------------------------------------------------------------------------------------

def _write(path: Path, text: str) -> None:
    """Whole or not at all: a run stopped in the middle leaves each file as it was or as planned, never half written."""
    new = not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".everydeck")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f: f.write(text)
        if path.exists(): os.chmod(tmp, path.stat().st_mode & 0o777)
        os.replace(tmp, path)
        if new:
            from .detect import forget_files
            forget_files()   # the scans after it (validate in the same run) see the new file
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def inside(repo: Path, rel: Any) -> Path:
    """The file a path of a plan names, resolved (symbolic links of its folders and of the file itself) and inside the repository, not in .git;
    raises SetupError with the path otherwise. A loaded plan is a file anyone can edit, and a link in the repository may point anywhere."""
    if not isinstance(rel, str) or not rel or not _safe_rel(rel): raise SetupError(f"the plan names a path outside the repository: {rel!r}")
    return within(repo, repo.resolve() / rel, rel, "the plan names a path")


def within(repo: Path, path: Path, shown: str, what: str) -> Path:
    """`path` resolved (relative to the working directory, every symbolic link followed) when it lies in the repository's files, not in .git and not
    the repository itself; raises SetupError naming `shown` and where it resolves otherwise."""
    root = repo.resolve(); real = path.resolve()
    try: under = real.relative_to(root).as_posix()
    except ValueError: raise SetupError(f"{what} outside the repository: {shown} resolves to {real}") from None
    if under == "." or under == ".git" or under.startswith(".git/"): raise SetupError(f"{what} outside the repository's files: {shown} resolves to {real}")
    return real


def check_paths(repo: Path, p: dict[str, Any]) -> None:
    """Every path of the plan, before the first write: one path outside the repository and nothing is written."""
    for c in p["changes"]:
        try: inside(repo, c.get("path"))
        except SetupError as e: raise SetupError(f"{e}; nothing was written") from None


def apply_changes(repo: Path, p: dict[str, Any]) -> dict[str, list[str]]:
    """Each file of the plan: written while it is as planned, left alone when it already is, named when someone changed it since. Its path is resolved
    again right before (a link made in between)."""
    out: dict[str, list[str]] = {"written": [], "already": [], "changed_since_plan": []}
    check_paths(repo, p)

    def again(rel: str) -> Path:
        try: return inside(repo, rel)
        except SetupError as e: raise SetupError(f"{e} (since the check a moment ago); stopped before it, written before: {out['written']}") from None

    for c in p["changes"]:
        path = again(c["path"])
        try: now = digest(path.read_text(encoding="utf-8") if path.is_file() else None)
        except (OSError, UnicodeDecodeError): now = None
        if now == c["after"]: out["already"].append(c["path"])
        elif now != c["before"]: out["changed_since_plan"].append(c["path"])
        else: _write(again(c["path"]), c["content"]); out["written"].append(c["path"])
    return out
