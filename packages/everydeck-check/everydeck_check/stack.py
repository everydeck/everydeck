"""The restart of the app's local Supabase stack during the setup: one narrow, repeatable step instead of free shell calls.
Only the Supabase CLI installed for the app (node_modules/.bin of the repository, then PATH), never npx (it downloads another CLI version); only the stack
of this repository (--workdir); each command with a time limit; on a hang only the process group this command started is stopped, never a process by name.
The output of the CLI is never printed (supabase start prints the stack's keys)."""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
from pathlib import Path
from typing import Any

from .detect import PACKAGE_DEPTH, SKIP_DIRS

STACK_RESTART_TIMEOUT = 300   # seconds per command (supabase stop, supabase start)

STALLED = ('Do not restart it any other way (no npx supabase, no pkill, killall or kill, no docker commands, no sandbox bypass): call everydeck_report_progress '
           'with stage stalled and stalled_on stack_restart, tell the owner exactly say_to_owner, then call everydeck_wait_for_owner right away and again each '
           'time it returns waiting_for "owner". When it returns waiting_for "agent", run everydeck-check restart-stack --repo . once more.')


def stack_dir(repo: Path) -> Path | None:
    """The folder of this repository's local stack: the one with supabase/config.toml, the repository itself first."""
    if (repo / "supabase/config.toml").is_file(): return repo
    for cfg in sorted(repo.rglob("supabase/config.toml"), key=lambda p: len(p.parts)):
        rel = cfg.relative_to(repo).parts
        if len(rel) - 2 <= PACKAGE_DEPTH and not any(part in SKIP_DIRS for part in rel): return cfg.parent.parent
    return None


def installed_cli(repo: Path, stack: Path) -> str | None:
    for folder in (stack, repo):
        p = folder / "node_modules/.bin/supabase"
        if p.is_file() and os.access(p, os.X_OK): return str(p)
    return shutil.which("supabase")


def _reason(text: str) -> str:
    t = text.lower()
    if "docker daemon" in t or "docker desktop" in t or "is docker running" in t: return "docker_not_running"
    if "port is already allocated" in t or "address already in use" in t: return "port_in_use"
    return "cli_error"


def _run(cmd: list[str], timeout: int) -> tuple[str, int | None, str]:
    """('ok' | 'failed' | 'timeout', exit code, stderr). The command runs in its own process group; on timeout only that group is stopped."""
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        _, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            try: os.killpg(p.pid, sig)
            except ProcessLookupError: break
            try: p.wait(timeout=wait); break
            except subprocess.TimeoutExpired: continue
        return "timeout", None, ""
    return ("ok" if p.returncode == 0 else "failed"), p.returncode, err or ""


def restart_stack(repo: Path, timeout: int = STACK_RESTART_TIMEOUT) -> dict[str, Any]:
    stack = stack_dir(repo)
    if stack is None:
        return {"status": "no_stack", "next": "This repository has no local Supabase stack (no supabase/config.toml): restart what reads the keys the way the repository documents it, never a process you did not start."}
    cli = installed_cli(repo, stack)
    if cli is None:
        return {"status": "no_cli", "stack": str(stack), "next": f"No Supabase CLI is installed for this app (node_modules/.bin/supabase or supabase on PATH). {STALLED}"}
    for step in ("stop", "start"):
        state, code, err = _run([cli, step, "--workdir", str(stack)], timeout)
        if state == "timeout":
            return {"status": "timeout", "stack": str(stack), "cli": cli, "step": step, "seconds": timeout, "next": f"supabase {step} did not finish within {timeout} seconds; everydeck-check stopped only the process it started. {STALLED}"}
        if state == "failed":
            return {"status": "failed", "stack": str(stack), "cli": cli, "step": step, "exit": code, "reason": _reason(err), "next": f"supabase {step} failed. {STALLED}"}
    return {"status": "ok", "stack": str(stack), "cli": cli, "next": "The local stack runs again with its data; go on with the step."}
