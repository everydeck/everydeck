"""The app's local database, found from facts, never guessed and never by the agent reading an env file.
The agent may not read .env files (SECRETS_RULE). Like Prisma, which loads DATABASE_URL from .env itself, everydeck-check reads the app's env files
itself and prints no value of them: only the file, the variable name and the port. In this order:
1. supabase/config.toml of this repository: the port under [db] (54322 when the file sets none, the Supabase CLI default), when it answers;
2. a variable in an env file of the app that points to a local Supabase gateway (http://127.0.0.1:<port>): the running local Supabase stack whose
   gateway publishes that port (Docker label com.supabase.cli.project, set by the Supabase CLI), and that stack's database port;
3. a local PostgreSQL address in an env file: printed only with the fixed password of a local Supabase stack (postgres), else only its name.
The url of a local Supabase stack carries its fixed password `postgres`, which is no secret of the app. Nothing else is printed."""
from __future__ import annotations

import re
import socket
import subprocess
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from .detect import PACKAGE_DEPTH, SKIP_DIRS
from .stack import stack_dir

SUPABASE_DB_PORT = 54322   # `supabase init` writes [db] port = 54322; the CLI uses it when config.toml sets none
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0", "host.docker.internal"}
ENV_FILE = re.compile(r"^\.env(\.[A-Za-z0-9_-]+)*$")
NOT_ENV = (".example", ".sample", ".template", ".dist", ".defaults")   # documented examples: the agent reads those itself (README rule)
LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
DOCKER_FORMAT = '{{.Label "com.supabase.cli.project"}}\t{{.Names}}\t{{.Ports}}'
HOST_PORT = re.compile(r"(?:\d{1,3}(?:\.\d{1,3}){3}|\[::\]|::):(\d+)->(\d+)/tcp")

NOT_FOUND = ("No local database of this app answers. Run the scaffold and everydeck-check validate without --db: they read the schema from the "
             "repository (migrations, models). If the app uses tables that no file in the repository creates (they were made in the dashboard of "
             "the hosted database), their structure lives only there: follow the step app_map for that case (one question to the owner, through "
             "everydeck_report_progress stage asked with asked_about database), never look into a hosted project the owner has not named.")


def _url(port: int) -> str:
    return f"postgresql://postgres:postgres@127.0.0.1:{port}/postgres"


def _answers(port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout): return True
    except OSError:
        return False


def _db_port(config: Path) -> int:
    """The port under [db] in supabase/config.toml (not the shadow_port), else the CLI default."""
    section = None
    for raw in config.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.split("#", 1)[0].strip()
        if m := re.match(r"^\[([^\]]+)\]$", line): section = m.group(1).strip(); continue
        if section == "db" and (m := re.match(r"^port\s*=\s*(\d+)$", line)): return int(m.group(1))
    return SUPABASE_DB_PORT


def env_files(repo: Path) -> list[Path]:
    """The app's env files (also git-ignored ones), at most PACKAGE_DEPTH folders deep; no examples."""
    out: list[Path] = []
    for p in sorted(repo.rglob(".env*")):
        rel = p.relative_to(repo).parts
        if len(rel) - 1 > PACKAGE_DEPTH or any(part in SKIP_DIRS for part in rel[:-1]) or not p.is_file(): continue
        if ENV_FILE.match(p.name) and not p.name.endswith(NOT_ENV): out.append(p)
    return out


def _local_values(repo: Path) -> list[dict[str, Any]]:
    """Variables whose value is an address on this computer: file, name, scheme, port (the value itself stays here)."""
    found: list[dict[str, Any]] = []
    for f in env_files(repo):
        for raw in f.read_text(encoding="utf-8", errors="replace").splitlines():
            m = LINE.match(raw)
            if not m: continue
            value = m.group(2).strip().strip('"').strip("'")
            if "://" not in value: continue
            try: u = urlsplit(value); port = u.port
            except ValueError: continue
            if (u.hostname or "") not in LOCAL_HOSTS: continue
            found.append({"file": str(f.relative_to(repo)), "name": m.group(1), "scheme": u.scheme, "port": port,
                          "fixed_password": u.scheme.startswith("postgres") and u.username == "postgres" and u.password == "postgres"})
    return found


def docker_ps() -> str | None:
    """Running containers of local Supabase stacks (label of the Supabase CLI); None when Docker does not answer."""
    try:
        p = subprocess.run(["docker", "ps", "--filter", "label=com.supabase.cli.project", "--format", DOCKER_FORMAT],
                           capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout if p.returncode == 0 else None


def _stacks(docker_rows: str) -> dict[str, dict[str, int]]:
    """project → {gateway: host port of supabase_kong_<project>, db: host port of supabase_db_<project>}"""
    out: dict[str, dict[str, int]] = {}
    for row in docker_rows.splitlines():
        parts = row.split("\t")
        if len(parts) < 3 or not parts[0]: continue
        project, name, ports = parts[0], parts[1], parts[2]
        role = "gateway" if name.startswith("supabase_kong_") else "db" if name.startswith("supabase_db_") else None
        if not role: continue
        inside = 8000 if role == "gateway" else 5432
        for host, cont in HOST_PORT.findall(ports):
            if int(cont) == inside: out.setdefault(project, {})[role] = int(host)
    return out


def find_local_db(repo: Path, docker: Callable[[], str | None] = docker_ps, answers: Callable[[int], bool] = _answers) -> dict[str, Any]:
    repo = repo.resolve()
    # 1. the stack of this repository
    stack = stack_dir(repo)
    if stack is not None:
        cfg = stack / "supabase/config.toml"; port = _db_port(cfg); where = str(cfg.relative_to(repo))
        if answers(port):
            return {"status": "found", "url": _url(port), "source": where, "evidence": f"{where}: the local Supabase stack of this repository, database port {port}"}
        return {"status": "not_running", "source": where, "port": port,
                "next": f"{where} names a local Supabase stack (database port {port}), but it does not answer. Start it once with `everydeck-check restart-stack --repo .` "
                        "(it keeps the data), then run everydeck-check local-db again."}
    # 2. the app's environment names a local Supabase gateway: the running stack that publishes that port
    values = _local_values(repo)
    gateways = [v for v in values if v["scheme"] in ("http", "https") and v["port"]]
    docker_rows = docker(); stacks = _stacks(docker_rows) if docker_rows else {}
    for v in gateways:
        for project, s in sorted(stacks.items()):
            if s.get("gateway") == v["port"] and s.get("db") and answers(s["db"]):
                return {"status": "found", "url": _url(s["db"]), "source": f"{v['file']} {v['name']}",
                        "evidence": f"{v['name']} in {v['file']} points to port {v['port']}, the gateway of the running local Supabase stack {project}; its database publishes port {s['db']}"}
    # 3. a local PostgreSQL address in the environment
    for v in (x for x in values if x["scheme"].startswith("postgres") and x["port"]):
        if v["fixed_password"] and answers(v["port"]):
            return {"status": "found", "url": _url(v["port"]), "source": f"{v['file']} {v['name']}",
                    "evidence": f"{v['name']} in {v['file']} is a local PostgreSQL with the fixed password of a local Supabase stack, port {v['port']}"}
    named = [f"{v['name']} in {v['file']}" for v in values if v["scheme"].startswith("postgres")]
    out: dict[str, Any] = {"status": "none", "next": NOT_FOUND}
    if named:
        out["local_postgres_named"] = named
        out["next"] = (f"A local PostgreSQL address is set as {', '.join(named)}; everydeck-check does not pass it on because it can hold a password, and you never "
                       "read it. Take the address the repository documents (README, docker-compose.yml, .env.example) if it documents one. " + NOT_FOUND)
    if gateways and docker_rows is None:
        out["docker"] = "not answering"
    return out
