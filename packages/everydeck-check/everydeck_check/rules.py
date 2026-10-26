"""everydeck's rules live in one place; here they are only called.

`rules/everydeck-rules.mjs` is bundled from everydeck's rules and runs with `node` (18 or newer, the same Node as `everydeck-agent`).
everydeck-check rebuilds none of everydeck's rules in Python: what everydeck rejects on submission, everydeck-check rejects with the same message.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from importlib import resources
from typing import Any


class RulesUnavailable(RuntimeError):
    pass


def run_rule(rule: str, payload: dict[str, Any], timeout: float = 120) -> dict[str, Any]:
    node = shutil.which("node")
    if not node:
        raise RulesUnavailable("node (≥ 18, the same as for everydeck-agent) is needed: everydeck-check runs everydeck's own rules from everydeck_check/rules/everydeck-rules.mjs")
    with resources.as_file(resources.files("everydeck_check").joinpath("rules/everydeck-rules.mjs")) as path:
        p = subprocess.run([node, str(path)], input=json.dumps({"rule": rule, **payload}), capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0 or not p.stdout.strip():
        raise RulesUnavailable(f"everydeck-rules failed ({p.returncode}): {(p.stderr or p.stdout).strip()[:300]}")
    return json.loads(p.stdout)


def app_map_open(doc: dict[str, Any]) -> dict[str, Any]:
    """What everydeck returns to the agent on submission: one sentence, the open parts nobody answered yet, how many stay open."""
    try:
        r = run_rule("app_map", {"input": doc})
    except RulesUnavailable as e:
        return {"setup": None, "open": [], "still_open": 0, "error": str(e)}
    return {"setup": r.get("setup"), "open": r.get("open", []), "still_open": r.get("still_open", 0)}


def app_map_rule_errors(doc: dict[str, Any]) -> list[str]:
    """The check everydeck runs when an app map is submitted: shape, references, result signal, derivation, derived manifest."""
    try:
        return list(run_rule("app_map", {"input": doc}).get("errors", []))
    except RulesUnavailable as e:
        return [f"everydeck rules: {e}"]
