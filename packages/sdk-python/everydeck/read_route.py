"""The read bridge as a ready-made route: Python version of @everydeck/sdk/read-bridge, same behavior.

FastAPI or Starlette: two lines in the module that creates `app`, with the connection the app already has (no helper module, no reader role,
no views, no read scope file in the repo):

    # everydeck read bridge: everydeck reads only the data the owner approved, read-only, and only with everydeck's signature
    from everydeck.read_route import mount_read_bridge, SupabaseReadOnly
    mount_read_bridge(app, SupabaseReadOnly(supabase_admin))   # or PsycopgReadOnly(os.environ["DATABASE_URL"])

It adds the route /everydeck/read/{rest:path} (not in the API schema) and reads EVERYDECK_URL and EVERYDECK_READ_BRIDGE_TOKEN from the environment
when the first call arrives. Other frameworks call the bridge themselves:

    from everydeck.read_route import EverydeckReadBridge, SupabaseReadOnly   # or PsycopgReadOnly(os.environ["DATABASE_URL"])
    bridge = EverydeckReadBridge(os.environ["EVERYDECK_URL"], os.environ["EVERYDECK_READ_BRIDGE_TOKEN"], SupabaseReadOnly(supabase_admin))
    @app.api_route("/everydeck/read/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    async def everydeck_read(rest: str, request: Request):
        status, body = await run_in_threadpool(bridge.handle, request.method, request.url.path, dict(request.query_params),
                                               request.headers.get("authorization"), request.headers, await request.body(), str(request.url))
        return JSONResponse(body, status_code=status)

- The route fetches the read scope from everydeck (GET <endpoint>/v1/read-scope with the bridge key as Bearer) and uses it only with a valid
  signature (HMAC-SHA256 with the same key over "EVERYDECK-SCOPE-V1\\n" + payload); otherwise it reads nothing (503).
- PsycopgReadOnly: every query runs in its own BEGIN READ ONLY transaction on the app's connection; the database rejects any write inside it.
  The rights are checked: role, superuser, rolbypassrls, current_setting('transaction_read_only').
- SupabaseReadOnly: the app's Supabase client (PostgREST). The route only calls select(), so only GET requests; PostgREST runs GET requests
  in a read-only transaction. Only tables in schemas exposed by the Supabase API are reachable.
- It says whether anything changed (GET /everydeck/read/etags): per type the fingerprint of what a full read delivers now, read like a full read
  but not sent, so a quiet app answers each read with a few hundred bytes instead of every page.
No dependencies beyond the standard library; the app brings psycopg or supabase itself.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Iterable, Mapping, Sequence

from .read_bridge import PAGE_MAX, ReadBridge, _uniq, psycopg_count, psycopg_match, psycopg_one, psycopg_rights, psycopg_rows
from .verify import MemorySeen

SCOPE_SIGNATURE_PREFIX = "EVERYDECK-SCOPE-V1\n"
ROLE_SQL = "SELECT current_user::text AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls, current_setting('transaction_read_only') AS read_only FROM pg_roles r WHERE r.rolname = current_user"


def _hmac_hex(key: str, text: str) -> str:
    return hmac.new(key.encode(), text.encode(), hashlib.sha256).hexdigest()


def sign_scope_payload(keys: Iterable[str], payload: str) -> str:
    out: list[str] = []
    for k in keys:
        if k and f"v1={_hmac_hex(k, SCOPE_SIGNATURE_PREFIX + payload)}" not in out:
            out.append(f"v1={_hmac_hex(k, SCOPE_SIGNATURE_PREFIX + payload)}")
    return ",".join(out)


def verify_scope_signature(keys: Iterable[str], payload: str, signature: str | None) -> bool:
    if not isinstance(signature, str):
        return False
    given = [p.strip()[3:].lower() for p in signature.split(",") if p.strip().startswith("v1=")]
    for k in keys:
        if not k:
            continue
        expected = _hmac_hex(k, SCOPE_SIGNATURE_PREFIX + payload)
        if any(hmac.compare_digest(g, expected) for g in given):
            return True
    return False


class PsycopgReadOnly:
    """The app's connection via psycopg 3: `PsycopgReadOnly(conninfo)` or `PsycopgReadOnly(connect=lambda: …)`; every query in BEGIN READ ONLY … COMMIT."""

    def __init__(self, conninfo: str | None = None, *, connect: Callable[[], Any] | None = None) -> None:
        if conninfo is None and connect is None:
            raise ValueError("PsycopgReadOnly needs a connection string or connect()")
        self._connect = connect or (lambda: __import__("psycopg").connect(conninfo, autocommit=True))
        self._conn: Any = None
        self._lock = threading.Lock()

    def read_only(self, fn: Callable[[Any], Any]) -> Any:
        with self._lock:
            if self._conn is None or getattr(self._conn, "closed", False):
                self._conn = self._connect()
            conn = self._conn
            cur = conn.cursor()
            cur.execute("BEGIN READ ONLY")
            try:
                out = fn(conn)
                conn.cursor().execute("COMMIT")
                return out
            except Exception:
                try:
                    conn.cursor().execute("ROLLBACK")
                except Exception:
                    self._conn = None   # connection broken: reconnect on the next call
                raise

    def rows(self, *a: Any, **k: Any) -> list[dict[str, Any]]:
        return self.read_only(lambda c: psycopg_rows(c)(*a, **k))

    def one(self, *a: Any) -> Mapping[str, Any] | None:
        return self.read_only(lambda c: psycopg_one(c)(*a))

    def match(self, *a: Any) -> list[dict[str, Any]]:
        return self.read_only(lambda c: psycopg_match(c)(*a))

    def count(self, *a: Any) -> int:
        return self.read_only(lambda c: psycopg_count(c)(*a))

    def rights(self, scope: Mapping[str, Any]) -> dict[str, Any]:
        def check(c: Any) -> dict[str, Any]:
            base = psycopg_rights(c, scope)()
            cur = c.cursor(); cur.execute(ROLE_SQL); row = cur.fetchone()
            if row:
                base.update({"role": row[0], "superuser": bool(row[1]), "bypass_rls": bool(row[2]), "read_only_transaction": row[3] == "on"})
            return base
        return self.read_only(check)


def _quote(v: str) -> str:
    """Value in a PostgREST filter (or=…): in double quotes, with \\ and \" escaped"""
    return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'


class SupabaseReadOnly:
    """The app's Supabase client (supabase-py, PostgREST): only select(), so only GET requests; PostgREST runs them in a read-only transaction."""

    def __init__(self, client: Any) -> None:
        self.client = client

    def _table(self, table: str) -> Any:
        if "." in table:
            schema, name = table.split(".", 1)
            return self.client.schema(schema).table(name)
        return self.client.table(table)

    def _after(self, q: Any, order: Sequence[str], after: Sequence[str] | None) -> Any:
        if not after or len(after) != len(order):
            return q
        if len(order) == 1:
            return q.gt(order[0], after[0])
        parts = []
        for i in range(len(order)):
            eqs = [f"{order[j]}.eq.{_quote(after[j])}" for j in range(i)]
            gt = f"{order[i]}.gt.{_quote(after[i])}"
            parts.append(gt if not eqs else f"and({','.join([*eqs, gt])})")
        return q.or_(",".join(parts))

    def rows(self, table: str, columns: Sequence[str], keys: Sequence[str], after: Sequence[str] | None, limit: int, changed: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
        order = [changed["column"], *keys] if changed else list(keys)
        q = self._table(table).select(",".join(_uniq([*columns, *([changed["column"]] if changed else [])])))
        if changed:
            q = q.gte(changed["column"], changed["since"])
        q = self._after(q, order, after)
        for c in order:
            q = q.order(c)
        return list(q.limit(max(1, min(PAGE_MAX + 1, int(limit)))).execute().data or [])

    def one(self, table: str, columns: Sequence[str], keys: Sequence[str], ref: Sequence[str]) -> Mapping[str, Any] | None:
        q = self._table(table).select(",".join(columns))
        for k, v in zip(keys, ref):
            q = q.eq(k, v)
        data = q.limit(1).execute().data or []
        return data[0] if data else None

    def match(self, table: str, columns: Sequence[str], where_column: str, values: Sequence[str], order: Sequence[str], after: Sequence[str] | None, limit: int) -> list[dict[str, Any]]:
        q = self._table(table).select(",".join(_uniq([*columns, *order]))).in_(where_column, list(values))
        q = self._after(q, order, after)
        for c in order:
            q = q.order(c)
        return list(q.limit(max(1, min(PAGE_MAX + 1, int(limit)))).execute().data or [])

    def count(self, table: str, keys: Sequence[str]) -> int:
        # PostgREST counts exactly (Prefer: count=exact) without returning rows
        return int(self._table(table).select(keys[0], count="exact", head=True).execute().count or 0)

    def rights(self, scope: Mapping[str, Any]) -> dict[str, Any]:
        # The role cannot be checked by SQL through PostgREST; the path is fixed: only GET (select), run read-only by PostgREST.
        return {"role": "supabase api (postgrest)", "select_only": False, "read_only_transaction": True, "checked_at": _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")}


def _default_fetch(url: str, headers: Mapping[str, str]) -> tuple[int, str]:
    req = urllib.request.Request(url, headers=dict(headers), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:   # noqa: S310 (everydeck address from the app's environment)
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, ""


class EverydeckReadBridge:
    """The ready-made read bridge: read scope signed by everydeck, reads through `db` (PsycopgReadOnly or SupabaseReadOnly)."""

    def __init__(self, endpoint: str | None, key: str | None, db: Any, *, previous_key: str | None = None, app: str | None = None, scope_ttl: float = 60.0,
                 seen: Callable[[str, float], bool] | None = None, fetch: Callable[[str, Mapping[str, str]], tuple[int, str]] | None = None) -> None:
        self.endpoint = (endpoint or "").rstrip("/")
        self.keys = [k for k in (key, previous_key) if k]
        self.db = db
        self.app = app or "everydeck read bridge (everydeck for Python)"
        self.ttl = max(0.0, scope_ttl)
        self.seen = seen or MemorySeen()
        self.fetch = fetch or _default_fetch
        self._cached: tuple[float, dict[str, Any], ReadBridge] | None = None
        self._lock = threading.Lock()

    def _load(self) -> tuple[dict[str, Any], ReadBridge] | str:
        with self._lock:
            if self._cached and time.monotonic() - self._cached[0] < self.ttl:
                return self._cached[1], self._cached[2]
            if not self.endpoint:
                return "EVERYDECK_URL is not set: the read bridge cannot fetch its read scope from everydeck"
            if not self.keys:
                return "EVERYDECK_READ_BRIDGE_TOKEN is not set"
            try:
                status, text = self.fetch(f"{self.endpoint}/v1/read-scope", {"authorization": f"Bearer {self.keys[0]}", "accept": "application/json"})
            except Exception:
                return "everydeck is not reachable: read scope unavailable"
            if status != 200:
                return f"everydeck refused the read scope (HTTP {status})"
            try:
                body = json.loads(text)
            except ValueError:
                return "read scope is not JSON"
            payload = body.get("payload") if isinstance(body, dict) else None
            if not isinstance(payload, str) or not verify_scope_signature(self.keys, payload, body.get("signature")):
                return "read scope signature invalid: not signed by everydeck with this key"
            p = json.loads(payload)
            if p.get("version") != "1" or not isinstance(p.get("scope"), dict) or p["scope"].get("version") != "1":
                return "read scope version not supported"
            scope = p["scope"]; db = self.db
            bridge = ReadBridge(scope, self.keys[0], db.rows, app=self.app, page_limit=200, rights=lambda: db.rights(scope), one=db.one, match=db.match, count=getattr(db, "count", None),
                                signatures="required", keys=self.keys, seen=self.seen)
            self._cached = (time.monotonic(), p, bridge)
            return p, bridge

    def scope(self) -> dict[str, Any] | None:
        out = self._load()
        return None if isinstance(out, str) else out[0]

    def handle(self, method: str, path: str, query: Mapping[str, str] | None = None, authorization: str | None = None,
               headers: Mapping[str, str] | None = None, body: bytes | str | None = None, url: str | None = None) -> tuple[int, Any]:
        if not path.split("?", 1)[0].startswith("/everydeck/read/"):
            return 404, {"error": "not found"}
        out = self._load()
        if isinstance(out, str):
            return 503, {"error": out}
        return out[1].handle(method, path, query, authorization, headers=headers, body=body, url=url)


def _default_http(method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float) -> tuple[int, str]:
    req = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310 (everydeck address from the app's environment)
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, ""


# Longest wait of one pull, like GitHub's runners (50 s, under the 60 s of common proxies). 0.5.3: 50 s (before 25 s); an older everydeck caps it at 25 s itself
PULL_WAIT_S = 50


def pull_once(bridge: "EverydeckReadBridge", wait: int = PULL_WAIT_S, http: Callable[..., tuple[int, str]] | None = None) -> str:
    """Pull (outbound only, like a GitHub self-hosted runner): fetch the next request from everydeck with a long poll (GET /v1/read-bridge/next), answer it
    with this bridge and send the answer back (POST /v1/read-bridge/reply/<id>). Returns answered, idle (nothing within `wait` seconds), refused (key not
    valid or not set up yet) or unreachable. everydeck needs no address and no key of the app."""
    call = http or _default_http
    if not bridge.endpoint or not bridge.keys:
        return "refused"
    auth = {"authorization": f"Bearer {bridge.keys[0]}", "accept": "application/json"}
    try:
        status, text = call("GET", f"{bridge.endpoint}/v1/read-bridge/next?wait={max(0, min(PULL_WAIT_S, int(wait)))}", auth, None, wait + 10)
    except Exception:
        return "unreachable"
    if status == 204:
        return "idle"
    if status in (401, 403, 409):
        return "refused"
    if status != 200:
        return "unreachable"
    job = json.loads(text)
    path = str(job.get("path", ""))
    parts = urllib.parse.urlsplit(path)
    query = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    body = job.get("body")
    code, out = bridge.handle(str(job.get("method", "GET")), parts.path, query, None, headers=dict(job.get("headers") or {}),
                              body=body.encode() if isinstance(body, str) else None, url=path)
    try:
        call("POST", f"{bridge.endpoint}/v1/read-bridge/reply/{urllib.parse.quote(str(job.get('id', '')))}", {**auth, "content-type": "application/json"},
             json.dumps({"status": code, "body": json.dumps(out)}).encode(), 30)
    except Exception:
        return "unreachable"
    return "answered"


def start_read_bridge(db: Any, *, http: Callable[..., tuple[int, str]] | None = None, **options: Any) -> threading.Event:
    """Starts everydeck's read bridge in a background thread of this process: it fetches its requests from everydeck and answers them (pull_once), for as long
    as the process runs. EVERYDECK_URL and EVERYDECK_READ_BRIDGE_TOKEN come from the environment and are read again when they change. Returns an Event; set()
    stops it. Not set up yet or everydeck away: it waits (30 s, or 2 s when everydeck is unreachable, with jitter) and asks again."""
    import os
    import random

    stop = threading.Event()

    def loop() -> None:
        bridge: EverydeckReadBridge | None = None
        while not stop.is_set():
            key = os.environ.get("EVERYDECK_READ_BRIDGE_TOKEN"); url = os.environ.get("EVERYDECK_URL")
            if bridge is None or (key and key not in bridge.keys) or bridge.endpoint != (url or "").rstrip("/"):
                bridge = EverydeckReadBridge(url, key, db, **options)
            out = pull_once(bridge, PULL_WAIT_S, http)
            if out == "refused":
                stop.wait(30 + random.random() * 5)
            elif out == "unreachable":
                stop.wait(2 + random.random() * 3)

    threading.Thread(target=loop, name="everydeck-read-bridge", daemon=True).start()
    return stop


READ_ROUTE = "/everydeck/read/{rest:path}"


def mount_read_bridge(app: Any, db: Any, **options: Any) -> threading.Event:
    """Starts everydeck's read bridge for a FastAPI or Starlette app (or any other app object): it fetches its requests from everydeck and answers them,
    outbound only; there is no route on the app and everydeck needs no address. `db` is the connection the app already has: SupabaseReadOnly(<the app's
    Supabase client>) or PsycopgReadOnly(<database URL>). It only answers requests signed by everydeck, reads only the approved columns and never writes
    (see EverydeckReadBridge). Started once per app object; `options` go to start_read_bridge and EverydeckReadBridge."""
    running = getattr(app, "_everydeck_read_bridge", None)
    if isinstance(running, threading.Event):
        return running
    stop = start_read_bridge(db, **options)
    try:
        setattr(app, "_everydeck_read_bridge", stop)
    except Exception:
        pass
    return stop
