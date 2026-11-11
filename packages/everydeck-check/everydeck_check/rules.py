"""everydeck's rules live in one place; here they are only called.

`rules/everydeck-rules.mjs` is bundled from everydeck's rules and runs with `node` (18 or newer, the same Node as `everydeck-agent`).
everydeck-check rebuilds none of everydeck's rules in Python: what everydeck rejects on submission, everydeck-check rejects with the same message.

A command that calls the rules many times (validate, apply) opens one `session()`: one node process answers every call of that command, one request per
line (before, each call started node and read the bundle again). Without a session every call starts node once.
"""
from __future__ import annotations

import json
import os
import select
import shutil
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
from importlib import resources
from typing import Any, Iterator


class RulesUnavailable(RuntimeError):
    pass


STARTS = 0   # how often node was started in this process (measured by the tests)
_open: "_Server | None" = None
_session: ExitStack | None = None


def _node() -> str:
    node = shutil.which("node")
    if not node:
        raise RulesUnavailable("node (≥ 18, the same as for everydeck-agent) is needed: everydeck-check runs everydeck's own rules from everydeck_check/rules/everydeck-rules.mjs")
    return node


class _Server:
    """`node everydeck-rules.mjs --serve`: a request is one line of JSON, its answer one line."""

    def __init__(self, path: str) -> None:
        global STARTS
        self.err = tempfile.TemporaryFile()
        self.p = subprocess.Popen([_node(), path, "--serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err)
        STARTS += 1
        self.buf = b""

    def ask(self, req: dict[str, Any], timeout: float) -> dict[str, Any]:
        assert self.p.stdin and self.p.stdout
        try:
            self.p.stdin.write(json.dumps(req).encode("utf-8") + b"\n"); self.p.stdin.flush()
        except OSError as e:
            raise RulesUnavailable(f"everydeck-rules stopped: {self._stderr()[:300] or e}") from e
        fd = self.p.stdout.fileno()
        while b"\n" not in self.buf:
            ready, _, _ = select.select([fd], [], [], timeout)
            if not ready:
                raise RulesUnavailable(f"everydeck-rules did not answer within {timeout:.0f} s")
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                raise RulesUnavailable(f"everydeck-rules stopped ({self.p.poll()}): {self._stderr()[:300]}")
            self.buf += chunk
        line, _, self.buf = self.buf.partition(b"\n")
        return json.loads(line)

    def _stderr(self) -> str:
        self.err.seek(0)
        return self.err.read().decode("utf-8", "replace").strip()

    def close(self) -> None:
        try:
            if self.p.stdin: self.p.stdin.close()
            self.p.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.p.kill()
        self.err.close()


@contextmanager
def session() -> Iterator[None]:
    """Every rule called inside goes to one node process, started at the first call (a nested session shares it). Without node nothing opens: each
    call then says why itself."""
    global _session, _open
    # Windows has no select() on pipes: there every call starts node, as before
    if _session is not None or os.name == "nt":
        yield
        return
    with ExitStack() as stack:
        _session = stack
        try:
            yield
        finally:
            if _open is not None:
                _open.close()
            _open = None; _session = None


def run_rule(rule: str, payload: dict[str, Any], timeout: float = 120) -> dict[str, Any]:
    global STARTS, _open
    if _session is not None:
        if _open is None:
            path = _session.enter_context(resources.as_file(resources.files("everydeck_check").joinpath("rules/everydeck-rules.mjs")))
            _open = _Server(str(path))
        try:
            return _open.ask({"rule": rule, **payload}, timeout)
        except RulesUnavailable:
            _open.close(); _open = None   # the next call starts it again
            raise
    node = _node()
    with resources.as_file(resources.files("everydeck_check").joinpath("rules/everydeck-rules.mjs")) as path:
        STARTS += 1
        p = subprocess.run([node, str(path)], input=json.dumps({"rule": rule, **payload}), capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0 or not p.stdout.strip():
        raise RulesUnavailable(f"everydeck-rules failed ({p.returncode}): {(p.stderr or p.stdout).strip()[:300]}")
    return json.loads(p.stdout)


def app_map_check(doc: dict[str, Any]) -> dict[str, Any]:
    """everydeck's check of an app map on submission and what it returns to the agent, in one call (before two, each deriving the whole map):
    the errors of every stage that can run, the stages, the open parts nobody answered yet (also while errors remain), the outbox entries with their limit."""
    return run_rule("app_map", {"input": doc})


def app_map_open(doc: dict[str, Any], require_result_signal: bool = True) -> dict[str, Any]:
    """What everydeck returns to the agent on submission: one sentence, the open parts nobody answered yet, how many stay open (also while errors remain)."""
    try:
        r = app_map_check(doc)
    except RulesUnavailable as e:
        return {"setup": None, "open": [], "still_open": 0, "error": str(e)}
    return open_of(r)


def open_of(r: dict[str, Any]) -> dict[str, Any]:
    return {"setup": r.get("setup"), "open": r.get("open", []), "still_open": r.get("still_open", 0), **({"outbox": r["outbox"]} if r.get("outbox") else {})}


def schedule_jobs(doc: dict[str, Any], before: dict[str, Any] | None) -> dict[str, Any]:
    """The jobs[] entries the inventory proves by itself (a named pg_cron schedule: name, rhythm and place, nothing to decide), with the fields this rule
    wrote before following the code; every field the agent changed or added stays. `before` is the inventory the app map carried before this run."""
    return run_rule("jobs", {"input": doc, "before": before})


def app_map_rule_errors(doc: dict[str, Any]) -> list[str]:
    """The check everydeck runs when an app map is submitted: shape, references, result signal, derivation, derived manifest."""
    try:
        return list(app_map_check(doc).get("errors", []))
    except RulesUnavailable as e:
        return [f"everydeck rules: {e}"]


def lost_agent_facts(before: dict[str, Any], after: dict[str, Any]) -> dict[str, list[str]]:
    """Which facts the agent set in `before` are missing in `after` (kept: fields, dropped: whole entries of the agent's lists), by the same rule as
    the scaffold's --merge and everydeck's GitHub check (keepAgentFacts); everydeck-check writes an app map in reanchor and validate and loses none."""
    r = run_rule("keep", {"before": before, "after": after})
    return {"kept": list(r.get("kept", [])), "dropped": list(r.get("dropped", []))}
