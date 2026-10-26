"""The footprint of the setup in the app's repository: which files the change adds and changes against the commit before the setup, whether a lockfile
was rewritten beyond the new packages, what was left behind (browser automation folders, screenshots, scripts with a probe id), and every AI client of the
app map that the setup did not wrap. Facts from git and the app map only."""
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


def _rows(url: str, sql: str) -> list[list[str]]:
    """Rows of a query through psycopg or psql (tab-separated), like database_tables in app_map."""
    import shutil
    try:
        import psycopg  # type: ignore
        with psycopg.connect(url) as conn: return [[str(v) for v in r] for r in conn.execute(sql).fetchall()]
    except ImportError:
        pass
    if not shutil.which("psql"): raise RuntimeError("--db needs psql or the psycopg package")
    out = subprocess.run(["psql", url, "-X", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0: raise RuntimeError(f"cannot read the database: {out.stderr.strip().splitlines()[0] if out.stderr.strip() else out.returncode}")
    return [l.split("\t") for l in out.stdout.splitlines() if l.strip()]


def outside_writes(repo: Path, base: str, url: str) -> list[dict[str, str]]:
    """What footprint can see of writes outside the repository: a migration the database applied during the setup (version from the
    date of the commit before the setup on) that is not a file of this repository. Rows written by hand are not visible here."""
    since = _git(repo, "show", "-s", "--format=%cd", "--date=format-local:%Y%m%d%H%M%S", base).strip()
    known = _rows(url, "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL")[0][0] in ("t", "True")
    rows = _rows(url, "SELECT version, coalesce(name, '') FROM supabase_migrations.schema_migrations ORDER BY version") if known else []
    files = {p.name.split("_", 1)[0] for p in repo.rglob("migrations/*.sql") if "node_modules" not in p.parts}
    return [{"what": f"migration {v} {n}".strip(), "fact": "applied to the database during the setup, but not in this repository: it was written outside the repository"}
            for v, n in rows if v >= since and v not in files]


# The wrapper around every AI client of the app map (ai_calls). OpenAI and providers reached through the OpenAI client: wrap_openai/wrapOpenAI in the
# client's file; Anthropic: wrap_anthropic/wrapAnthropic; any other provider without a wrapper (Google, Mistral, AI SDK, HTTP): ai_call/aiCall where it is called.
OPENAI_LIKE = {"openai", "openrouter", "groq", "together", "azure", "azure.ai.openai", "deepseek", "x_ai", "xai", "perplexity", "fireworks"}
WRAP = {"openai": re.compile(r"\bwrap_?[oO]pen[aA][iI]\("), "anthropic": re.compile(r"\bwrap_?[aA]nthropic\(")}
MEASURED = re.compile(r"\bai_?[cC]all\(")
# The methods the wrappers measure (the same lists as METHODS in sdk-ts/src/ai.ts and _METHODS in sdk-python/everydeck/ai.py). A wrapped client is
# no proof for a call of another method (e.g. Anthropic messages.stream): that call needs ai_call/aiCall where it is called, else it stays "not measured".
WRAPPED = {
    "openai": {"chat.completions.create", "chat.completions.parse", "beta.chat.completions.parse", "responses.create", "responses.parse", "embeddings.create",
               "completions.create", "images.generate", "images.edit", "audio.transcriptions.create", "audio.translations.create", "audio.speech.create"},
    "anthropic": {"messages.create", "messages.parse", "beta.messages.create", "beta.messages.parse"},
}


def _wrapped(family: str, symbol: str) -> bool:
    """the found method is one the wrapper measures (a bare name like `create` counts when a measured method ends with it)"""
    return any(m == symbol or m.endswith("." + symbol) for m in WRAPPED[family]) if symbol else True


def ai_unwrapped(repo: Path, app_map: Path | None = None) -> list[dict[str, Any]]:
    path = app_map or repo / "everydeck/app-map.json"
    try: calls = json.loads(path.read_text(encoding="utf-8")).get("ai_calls") or []
    except (OSError, ValueError): return []
    out: list[dict[str, Any]] = []; seen: set[tuple[str, str]] = set()
    for a in calls:
        prov = str(a.get("provider", "")); ev = a.get("evidence") or {}; rel = str(ev.get("path", ""))
        if not rel: continue
        family = "openai" if prov in OPENAI_LIKE else "anthropic" if prov == "anthropic" else None
        symbol = str(ev.get("symbol") or "")
        # a call of a method the wrapper does not measure is checked like a call of a provider without a wrapper
        unmeasured = family is not None and a.get("kind") == "call" and not _wrapped(family, symbol)
        if family is None and a.get("kind") != "call": continue   # other providers: their call places carry ai_call
        if family is not None and a.get("kind") != "client" and not unmeasured: continue
        key = (rel, prov) if not unmeasured else (rel, f"{prov}:{symbol}")
        if key in seen: continue
        try: text = (repo / rel).read_text(encoding="utf-8", errors="replace")
        except OSError: continue
        seen.add(key)
        py = rel.endswith(".py")
        if family and not unmeasured and WRAP[family].search(text): continue
        if (family is None or unmeasured) and MEASURED.search(text): continue
        fix = (f"everydeck.wrap_{family}(client)" if py else f"everydeck.wrap{'OpenAI' if family == 'openai' else 'Anthropic'}(client)") if family and not unmeasured else ("everydeck.ai_call(...)" if py else "everydeck.aiCall({...})")
        fact = (f"the AI call {symbol} of {prov} here is not measured: the everydeck wrapper does not measure {symbol}" if unmeasured
                else f"the AI {'client' if family else 'call'} of {prov} here is not measured")
        out.append({"path": rel, "line": ev.get("line"), "provider": prov, "fact": fact, "fix": fix})
    return out


def footprint(repo: Path, base: str, fix_lock: bool = False, db: str | None = None) -> dict[str, Any]:
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
    outside = outside_writes(repo, base, db) if db else None
    ai = ai_unwrapped(repo)
    # the source map upload key: never under a public name, in built code, in a tracked file or in an env file git does not ignore
    from .keys import key_findings
    keys = key_findings(repo)
    return {"status": "ok" if not locks and not left and not outside and not ai and not keys["errors"] else "refused", "ai_unwrapped": ai, "keys": keys, "base": base, "files_added": len(added), "files_changed": len(changed),
            "added": added[:200], "changed": changed[:200], "untracked": untracked[:200], "lockfiles": locks, "leftovers": left, **({"outside": outside} if outside is not None else {})}
