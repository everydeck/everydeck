"""The general read bridge: Python version of the TypeScript SDK (read-bridge.ts), same behavior.

One endpoint per declared table, only declared columns, with a cursor. The agent writes no bridge per app: it takes the read scope
(`everydeck/everydeck-read-scope.json`, derived from the app map) and passes a function `rows(table, columns, keys, after, limit)` that reads rows from
the app's database through a dedicated reader role (SELECT only). `psycopg_rows(conn)` is the ready-made version for psycopg (2 or 3).

    bridge = ReadBridge(scope=json.load(open("everydeck/everydeck-read-scope.json")), token=os.environ["EVERYDECK_READ_BRIDGE_TOKEN"], rows=psycopg_rows(conn))
    # FastAPI:  @app.api_route("/everydeck/read/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    #           async def everydeck_read(rest: str, request: Request):
    #               status, body = bridge.handle(request.method, request.url.path, dict(request.query_params), request.headers.get("authorization"))
    #               return JSONResponse(body, status_code=status)

Contract: GET /everydeck/read/capabilities · GET /everydeck/read/objects/{type}?cursor&limit · GET /everydeck/read/people?cursor&limit; own Bearer key;
every write verb is rejected; pages ≤ 200; identifiers as text (several key columns joined with "|"); timestamps ISO-8601; object values
as JSON text; no value longer than 256 characters. Relations are delivered like object types (type = relations[].id).
"""
from __future__ import annotations

import base64
import datetime as _dt
import decimal
import hashlib
import hmac

from .verify import verify_everydeck_request
import json
from typing import Any, Callable, Iterable, Mapping, Sequence

PAGE_MAX = 200
VALUE_MAX = 256
# rows(table, columns, keys, after, limit[, changed]); changed = {"column", "since"}: only changed rows, stable by (change column, keys); cursor is then [change time, …keys]
Rows = Callable[..., Iterable[Mapping[str, Any]]]


def _day(v: Any) -> str:
    """A calendar day (`date`) as midnight UTC of that day, the form everydeck accepts for a date field (like read-bridge.ts), in every time zone"""
    return f"{v.isoformat()}T00:00:00Z" if isinstance(v, _dt.date) and not isinstance(v, _dt.datetime) else str(v)


def _text(v: Any) -> str:
    if isinstance(v, _dt.datetime):
        return (v if v.tzinfo else v.replace(tzinfo=_dt.timezone.utc)).isoformat().replace("+00:00", "Z")
    if isinstance(v, _dt.date):
        return _day(v)
    if isinstance(v, _dt.time):
        return v.isoformat()
    if isinstance(v, str):
        return v
    if isinstance(v, (dict, list)):
        return json.dumps(v, separators=(",", ":"), default=_day)
    return str(v)


def _value(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v if -(2**53) < v < 2**53 else str(v)
    if isinstance(v, float):
        return v
    if isinstance(v, decimal.Decimal):
        f = float(v)
        return f if f == f and abs(f) != float("inf") else str(v)
    return _text(v)[:VALUE_MAX]


def _b64(values: Sequence[str]) -> str:
    return base64.urlsafe_b64encode(json.dumps(list(values)).encode()).decode().rstrip("=")


def _unb64(cursor: str) -> list[str] | None:
    try:
        v = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        return v if isinstance(v, list) and all(isinstance(x, str) for x in v) else None
    except Exception:
        return None


def _uniq(xs: Iterable[str]) -> list[str]:
    out: list[str] = []
    for x in xs:
        if x not in out:
            out.append(x)
    return out


GRANT_SIGNATURE_PREFIX = "EVERYDECK-GRANT-V1\n"
GRANT_MAX_SECONDS = 300


def sign_everydeck_grant(keys: Iterable[str], grant: Mapping[str, Any]) -> dict[str, str]:
    """Counterpart (everydeck and tests): query parameters of a grant; grant = base64url(JSON), grant_sig = v1=<hex> per key."""
    g = base64.urlsafe_b64encode(json.dumps(grant, separators=(",", ":")).encode()).decode().rstrip("=")
    sigs = []
    for k in keys:
        if k:
            sig = "v1=" + hmac.new(k.encode(), (GRANT_SIGNATURE_PREFIX + g).encode(), hashlib.sha256).hexdigest()
            if sig not in sigs:
                sigs.append(sig)
    return {"grant": g, "grant_sig": ",".join(sigs)}


def _is_name(x: Any) -> bool:
    return isinstance(x, str) and 0 < len(x) <= 160


def grant_of(keys: Iterable[str], query: Mapping[str, str] | None, typ: str, ref: str) -> dict[str, Any] | str:
    """Check a grant: signature with a valid key, exactly this conversation, a reason, not expired, message table complete.
    Returns the conversation ({messages, attachments}) or the reason for rejection."""
    q = query or {}; g = q.get("grant"); sig = q.get("grant_sig")
    if not g or not sig:
        return "grant missing"
    given = [p.strip()[3:].lower() for p in sig.split(",") if p.strip().startswith("v1=")]
    if not any(hmac.compare_digest(x, hmac.new(k.encode(), (GRANT_SIGNATURE_PREFIX + g).encode(), hashlib.sha256).hexdigest()) for k in keys if k for x in given):
        return "grant signature invalid"
    try:
        v = json.loads(base64.urlsafe_b64decode(g + "=" * (-len(g) % 4)).decode())
    except (ValueError, UnicodeDecodeError):
        return "grant unreadable"
    now = int(_dt.datetime.now(_dt.timezone.utc).timestamp())
    if not isinstance(v, dict) or v.get("v") != 1 or v.get("type") != typ or v.get("ref") != ref:
        return "grant is for another conversation"
    if not isinstance(v.get("reason"), str) or not v["reason"].strip():
        return "grant without a reason"
    if not isinstance(v.get("exp"), int) or v["exp"] < now or v["exp"] > now + GRANT_MAX_SECONDS + 30:
        return "grant expired"
    m = v.get("messages")
    if not isinstance(m, dict) or not _is_name(m.get("table")) or not isinstance(m.get("ref"), list) or not all(_is_name(x) for x in m["ref"]) or not all(_is_name(m.get(k)) for k in ("conversation", "sender", "time")) or not isinstance(m.get("text"), list) or not m["text"] or not all(_is_name(x) for x in m["text"]):
        return "grant names no message table"
    return {"messages": m, **({"attachments": v["attachments"]} if isinstance(v.get("attachments"), dict) else {})}


class ReadBridge:
    def __init__(self, scope: Mapping[str, Any], token: str, rows: Rows, app: str | None = None, page_limit: int = 100, rights: Mapping[str, Any] | Callable[[], Mapping[str, Any]] | None = None,
                 one: Callable[[str, Sequence[str], Sequence[str], Sequence[str]], Mapping[str, Any] | None] | None = None,
                 deleted: Callable[[str, Sequence[str], str, int], Sequence[Mapping[str, Any]]] | None = None,
                 signatures: str = "required", keys: Sequence[str] | None = None, seen: Callable[[str, float], bool] | None = None,
                 match: Callable[..., Iterable[Mapping[str, Any]]] | None = None,
                 count: Callable[[str, Sequence[str]], int] | None = None) -> None:
        # match(table, columns, where_column, values, order, after, limit) → rows of one conversation (psycopg_match); without match no conversations
        self.match = match
        # count(table, keys) → number of rows of the table (psycopg_count), GET /everydeck/read/counts; without count no counts (everydeck waits for a full read)
        self.count = count
        # one(table, columns, keys, ref) → one row; deleted(table, keys, since, limit) → [{ref, deleted_at}] (deletions the app knows about)
        self.one = one; self.deleted = deleted
        # everydeck signs every call: "required" (default) rejects unsigned calls, "optional" accepts the Bearer without a signature (everydeck instances that do not sign yet), "off" checks only the Bearer;
        # keys = valid keys (default: token; during a rotation the new and the old one), seen = replay protection across several instances
        if signatures not in ("required", "optional", "off"): raise ValueError("signatures must be required, optional or off")
        self.signatures = signatures; self.keys = list(keys) if keys else [token]; self.seen = seen
        self.scope = scope
        self.token = token
        self.rows = rows
        self.app = app
        self.page_limit = min(PAGE_MAX, max(1, page_limit))
        self._rights = rights   # fixed, or a function that checks on the first call (psycopg_rights); never just claimed
        self._rights_cache: dict[str, Any] | None = None
        self.types: dict[str, dict[str, Any]] = {}
        for o in scope.get("objects", []):
            cols = _uniq([*o["ref"], *([o["title"]] if o.get("title") else []), *([o["status"]] if o.get("status") else []), *([o["owner"]] if o.get("owner") else []), *(f["column"] for f in o["fields"])])
            if o.get("changed") and o["changed"] not in cols: cols = [*cols, o["changed"]]
            self.types[o["type"]] = {"table": o["table"], "keys": list(o["ref"]), "columns": cols, "title": o.get("title"), "status": o.get("status"), "owner": o.get("owner"), "changed": o.get("changed"), "fields": list(o["fields"])}
        for r in scope.get("relations", []):
            self.types[r["id"]] = {"table": r["table"], "keys": list(r["ref"]), "columns": _uniq([*r["ref"], *(f["column"] for f in r["fields"])]), "title": None, "status": None, "owner": None, "changed": None, "fields": list(r["fields"])}

    def rights(self) -> dict[str, Any]:
        if self._rights_cache is None:
            r = self._rights() if callable(self._rights) else self._rights
            self._rights_cache = dict(r) if r else {"role": "unknown", "select_only": False}
        return self._rights_cache

    def capabilities(self) -> dict[str, Any]:
        # per object type whether changed_since works (change column in the scope), and whether fetching one object works
        counted = {"count": True} if self.count is not None else {}
        objects = [{"type": o["type"], "fields": [f["name"] for f in o["fields"]], **({"statuses": list(o["statuses"])} if o.get("statuses") else {}), "changed_since": bool(o.get("changed")), **counted} for o in self.scope.get("objects", [])]
        objects += [{"type": r["id"], "fields": [f["name"] for f in r["fields"]], "changed_since": False, **counted} for r in self.scope.get("relations", [])]
        people = self.scope.get("people")
        convs = self.scope.get("conversations") or []
        return {"version": "1", **({"app": self.app} if self.app else {}), "identity": "subject_ref", "objects": objects, **({"people": {"fields": list(people["fields"].keys())}} if people else {}), **({"messages": [c["type"] for c in convs]} if self.match is not None and convs else {}), **({"messages_grant": True} if self.match is not None else {}), "signed": self.signatures != "off", "rights": self.rights(), "page_limit": self.page_limit, "fetch_one": self.one is not None}

    def _page(self, query: Mapping[str, str] | None) -> tuple[int, list[str] | None, bool]:
        q = query or {}
        try:
            limit = min(self.page_limit, max(1, int(q.get("limit") or self.page_limit)))
        except ValueError:
            limit = self.page_limit
        after = _unb64(q["cursor"]) if q.get("cursor") else None
        return limit, after, bool(q.get("cursor")) and after is None

    def handle(self, method: str, path: str, query: Mapping[str, str] | None = None, authorization: str | None = None,
               headers: Mapping[str, str] | None = None, body: bytes | str | None = None, url: str | None = None) -> tuple[int, Any]:
        # headers/url/body: headers and path with query as the app sees them, for the signature check; FastAPI: request.headers, str(request.url), await request.body()
        full = url if url is not None else (path + ("?" + "&".join(f"{k}={v}" for k, v in (query or {}).items()) if query else ""))
        path = path.split("?", 1)[0]
        if not path.startswith("/everydeck/read/"):
            return 404, {"error": "not found"}
        sig = None
        if self.signatures != "off" and headers:
            sig = next((v for k, v in headers.items() if k.lower() == "x-everydeck-signature"), None)
        if sig:
            v = verify_everydeck_request(method, full, headers or {}, body, keys=self.keys, seen=self.seen)
            if not v.ok:
                return 401, {"error": f"signature rejected: {v.reason}"}
        elif self.signatures == "required":
            return 401, {"error": "signature required (X-Everydeck-Signature missing): everydeck signs every call; use signatures=\"optional\" only for everydeck instances that do not sign calls yet"}
        elif not hmac.compare_digest((authorization or "").encode(), f"Bearer {self.token}".encode()):   # constant time
            return 401, {"error": "read key invalid"}
        if method.upper() != "GET":
            return 405, {"error": "read only"}
        if path == "/everydeck/read/capabilities":
            return 200, self.capabilities()
        as_of = _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")
        if path == "/everydeck/read/counts":   # per type of the scope the number of rows of its table, counted now
            if self.count is None:
                return 404, {"error": "this bridge does not count"}
            return 200, {"as_of": as_of, "counts": {typ: max(0, int(self.count(x["table"], x["keys"]) or 0)) for typ, x in self.types.items()}}
        if path == "/everydeck/read/people":
            p = self.scope.get("people")
            if not p:
                return 404, {"error": "no people in the read scope"}
            limit, after, bad = self._page(query)
            if bad:
                return 400, {"error": "bad cursor"}
            steps = p.get("name") or []
            cols = _uniq([p["ref"], *p["fields"].values(), *[c for st in steps for c in st["columns"]]])
            rows = list(self.rows(p["table"], cols, [p["ref"]], after, limit + 1))
            kept = rows[:limit]

            def name_of(r):   # display name by the app's rule: first step with content, parts joined with the app's separator (as in read-bridge.ts)
                for st in steps:
                    parts = [x for x in ("" if r.get(c) is None else _text(r[c]).strip() for c in st["columns"]) if x]
                    if parts:
                        return st.get("separator", " ").join(parts)[:VALUE_MAX]
                return None
            items = [{"subject_ref": _text(r[p["ref"]])[:128], **{f: (None if r.get(c) is None else _text(r[c])[:VALUE_MAX]) for f, c in p["fields"].items()}, **({"display_name": name_of(r)} if steps and "display_name" in p["fields"] else {})} for r in kept]
            return 200, {"as_of": as_of, "items": items, "next_cursor": _b64([_text(kept[-1][p["ref"]])]) if len(rows) > limit else None}
        if path.startswith("/everydeck/read/messages/") and path[len("/everydeck/read/messages/"):].count("/") == 1:   # messages of one conversation, on demand only
            typ, ref = path[len("/everydeck/read/messages/"):].split("/", 1)
            if self.match is None:
                return 404, {"error": "this bridge reads no conversations"}
            # only with everydeck's grant for exactly this conversation (opened with a reason); table and columns are only in the grant
            conv = grant_of(self.keys, query, typ, ref)
            if isinstance(conv, str):
                return 403, {"error": f"a conversation is read only when a moderator opens it with a reason in everydeck ({conv})"}
            limit, after, bad = self._page(query)
            m = conv["messages"]; order = [m["time"], *m["ref"]]
            if bad or (after is not None and len(after) != len(order)):
                return 400, {"error": "bad cursor"}
            rows = list(self.match(m["table"], _uniq([*m["ref"], m["conversation"], m["sender"], m["time"], *m["text"]]), m["conversation"], [ref], order, after, limit + 1))
            kept = rows[:limit]; ids = ["|".join(_text(r[k]) for k in m["ref"]) for r in kept]
            att: dict[str, list[dict[str, Any]]] = {}
            a = conv.get("attachments")
            if a and ids and len(m["ref"]) == 1:
                for r in self.match(a["table"], _uniq([a["message"], a["url"], *([a["name"]] if a.get("name") else [])]), a["message"], ids, [a["message"]], None, PAGE_MAX):
                    lst = att.setdefault(_text(r[a["message"]]), [])
                    if len(lst) < 10: lst.append({"kind": a["kind"], **({"name": _text(r[a["name"]])[:200]} if a.get("name") and r.get(a["name"]) is not None else {}), **({"url": _text(r[a["url"]])[:2048]} if r.get(a["url"]) is not None else {})})
            items = [{"id": ids[i][:128], "sender_ref": "unknown" if r.get(m["sender"]) is None else _text(r[m["sender"]])[:128], "sent_at": _iso(r.get(m["time"])) or as_of,
                      "text": "\n".join(_text(r[c]) for c in m["text"] if r.get(c) is not None)[:4000], **({"attachments": att[ids[i]]} if att.get(ids[i]) else {})} for i, r in enumerate(kept)]
            return 200, {"type": typ, "ref": ref[:128], "as_of": as_of, "items": items, "next_cursor": _b64([_iso(kept[-1][m["time"]]) or "", *(_text(kept[-1][k]) for k in m["ref"])]) if len(rows) > limit else None}
        rest = path[len("/everydeck/read/objects/"):] if path.startswith("/everydeck/read/objects/") else None
        if rest is not None and rest.count("/") == 1:   # fetch one object: GET /everydeck/read/objects/{type}/{ref}
            typ, ref_raw = rest.split("/", 1)
            x = self.types.get(typ)
            if not x:
                return 404, {"error": f"unknown type {typ}"}
            if self.one is None:
                return 404, {"error": "fetching one object is not supported by this bridge"}
            ref = ref_raw.split("|")
            if len(ref) != len(x["keys"]):
                return 400, {"error": "bad ref"}
            row = self.one(x["table"], x["columns"], x["keys"], ref)
            if row is None:
                return 404, {"error": "not found", "type": typ, "ref": ref_raw}
            return 200, {"type": typ, "as_of": as_of, "item": self._item(x, row)}
        if rest is not None and "/" not in rest:
            typ = rest
            x = self.types.get(typ)
            if not x:
                return 404, {"error": f"unknown type {typ}"}
            limit, after, bad = self._page(query)
            if bad:
                return 400, {"error": "bad cursor"}
            since_raw = (query or {}).get("changed_since")
            if since_raw is not None:   # only rows changed since `since`, stable by (change column, keys); plus deletions where the app knows them
                if not x["changed"]:
                    return 400, {"error": f"changed_since is not supported for {typ}: no column the database sets on every change"}
                since = _iso(since_raw)
                if since is None:
                    return 400, {"error": "bad changed_since (ISO-8601 expected)"}
                if after is not None and len(after) != len(x["keys"]) + 1:
                    return 400, {"error": "bad cursor"}
                rows = list(self.rows(x["table"], x["columns"], x["keys"], after, limit + 1, {"column": x["changed"], "since": since}))
                kept = rows[:limit]
                body: dict[str, Any] = {"type": typ, "as_of": as_of, "changed_since": since, "items": [self._item(x, r) for r in kept],
                                        "next_cursor": _b64([_iso(kept[-1][x["changed"]]) or "", *(_text(kept[-1][k]) for k in x["keys"])]) if len(rows) > limit else None}
                if self.deleted is not None and after is None:
                    body["deleted"] = [{"ref": _text(d["ref"])[:128], "deleted_at": _iso(d["deleted_at"]) or as_of} for d in list(self.deleted(x["table"], x["keys"], since, PAGE_MAX))[:PAGE_MAX]]
                return 200, body
            if after is not None and len(after) != len(x["keys"]):
                return 400, {"error": "bad cursor"}
            rows = list(self.rows(x["table"], x["columns"], x["keys"], after, limit + 1))
            kept = rows[:limit]
            return 200, {"type": typ, "as_of": as_of, "items": [self._item(x, r) for r in kept], "next_cursor": _b64([_text(kept[-1][k]) for k in x["keys"]]) if len(rows) > limit else None}
        return 404, {"error": "not found"}

    def _item(self, x: Mapping[str, Any], r: Mapping[str, Any]) -> dict[str, Any]:
        it: dict[str, Any] = {"ref": "|".join(_text(r[k]) for k in x["keys"])[:128]}
        if x["title"] and r.get(x["title"]) is not None:
            it["title"] = _text(r[x["title"]])[:200]
        if x["status"]:
            it["status"] = {"value": "none", "reason": f"no value in {x['status']}"} if r.get(x["status"]) is None else {"value": _text(r[x["status"]])[:64]}
        else:
            it["status"] = {"value": "present"}
        if x["owner"]:
            it["owner_ref"] = None if r.get(x["owner"]) is None else _text(r[x["owner"]])[:128]
        if x.get("changed"):
            it["updated_at"] = _iso(r.get(x["changed"]))
        it["fields"] = {f["name"]: _value(r.get(f["column"])) for f in x["fields"]}
        return it


def _iso(v: Any) -> str | None:
    """Timestamp as ISO-8601 (UTC, Z) or None"""
    if v is None:
        return None
    if isinstance(v, _dt.datetime):
        d = v if v.tzinfo else v.replace(tzinfo=_dt.timezone.utc)
        return d.astimezone(_dt.timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        d = _dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    d = d if d.tzinfo else d.replace(tzinfo=_dt.timezone.utc)
    return d.astimezone(_dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _ident(name: str) -> str:
    return ".".join('"' + p.replace('"', '""') + '"' for p in name.split("."))


def read_view_name(table: str) -> str:
    """Name of the view in the reader role's schema (everydeck's SQL creates it): the table name, outside public `<schema>__<table>`."""
    return table.replace(".", "__", 1) if "." in table else table


def psycopg_rows(conn: Any, schema: str | None = None) -> Rows:
    """`rows` for psycopg 2/3: keyset cursor over the key columns, only the given columns; the connection belongs to the reader role.
    `schema`: the reader role's views (e.g. everydeck_read) instead of the tables, so the app's row-level policies do not apply to the reader."""
    def rows(table: str, columns: Sequence[str], keys: Sequence[str], after: Sequence[str] | None, limit: int, changed: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
        src = f"{_ident(schema)}.{_ident(read_view_name(table))}" if schema else _ident(table)
        lim = f"LIMIT {max(1, min(PAGE_MAX + 1, int(limit)))}"
        cur = conn.cursor()
        if changed:   # only rows changed since `since`, stable by (change column, keys); cursor = [change time, …keys]
            order = [changed["column"], *keys]; params: list[Any] = [changed["since"]]
            where = f" WHERE {_ident(changed['column'])} >= %s"
            if after and len(after) == len(order):
                where += f" AND ({', '.join(_ident(c) for c in order)}) > ({', '.join('%s' for _ in order)})"; params += list(after)
            cols = list(columns) + ([changed["column"]] if changed["column"] not in columns else [])
            cur.execute(f"SELECT {', '.join(_ident(c) for c in cols)} FROM {src}{where} ORDER BY {', '.join(_ident(c) for c in order)} {lim}", params)
        else:
            where = f" WHERE ({', '.join(_ident(k) for k in keys)}) > ({', '.join('%s' for _ in keys)})" if after and len(after) == len(keys) else ""
            cur.execute(f"SELECT {', '.join(_ident(c) for c in columns)} FROM {src}{where} ORDER BY {', '.join(_ident(k) for k in keys)} {lim}", list(after) if where else [])
        names = [d[0] for d in cur.description]
        return [dict(zip(names, row)) for row in cur.fetchall()]
    return rows


def psycopg_count(conn: Any, schema: str | None = None) -> Callable[[str, Sequence[str]], int]:
    """`count` for psycopg: count(*) of the table (or the reader role's view)."""
    def count(table: str, keys: Sequence[str]) -> int:
        src = f"{_ident(schema)}.{_ident(read_view_name(table))}" if schema else _ident(table)
        cur = conn.cursor()
        cur.execute(f"SELECT count(*) AS n FROM {src}")
        row = cur.fetchone()
        return int(row[0]) if row else 0
    return count


def psycopg_one(conn: Any, schema: str | None = None) -> Callable[[str, Sequence[str], Sequence[str], Sequence[str]], Mapping[str, Any] | None]:
    """`one` for psycopg: exactly one row by its key values."""
    def one(table: str, columns: Sequence[str], keys: Sequence[str], ref: Sequence[str]) -> Mapping[str, Any] | None:
        src = f"{_ident(schema)}.{_ident(read_view_name(table))}" if schema else _ident(table)
        cur = conn.cursor()
        cur.execute(f"SELECT {', '.join(_ident(c) for c in columns)} FROM {src} WHERE ({', '.join(_ident(k) for k in keys)}) = ({', '.join('%s' for _ in keys)}) LIMIT 1", list(ref))
        row = cur.fetchone()
        if row is None:
            return None
        return dict(zip([d[0] for d in cur.description], row))
    return one


def psycopg_match(conn: Any, schema: str | None = None) -> Callable[..., list[dict[str, Any]]]:
    """`match` for psycopg: rows with where_column = ANY(values), keyset cursor over order (messages of one conversation)."""
    def match(table: str, columns: Sequence[str], where_column: str, values: Sequence[str], order: Sequence[str], after: Sequence[str] | None, limit: int) -> list[dict[str, Any]]:
        src = f"{_ident(schema)}.{_ident(read_view_name(table))}" if schema else _ident(table)
        params: list[Any] = [list(values)]; cond = f"{_ident(where_column)}::text = ANY(%s)"
        if after and len(after) == len(order):
            cond += f" AND ({', '.join(_ident(c) for c in order)}) > ({', '.join('%s' for _ in order)})"; params += list(after)
        cols = _uniq([*columns, *order])
        cur = conn.cursor()
        cur.execute(f"SELECT {', '.join(_ident(c) for c in cols)} FROM {src} WHERE {cond} ORDER BY {', '.join(_ident(c) for c in order)} LIMIT {max(1, min(PAGE_MAX + 1, int(limit)))}", params)
        names = [d[0] for d in cur.description]
        return [dict(zip(names, row)) for row in cur.fetchall()]
    return match


def scope_tables(scope: Mapping[str, Any]) -> list[str]:
    """All tables of the scope (objects, relations, conversations, people)."""
    out: list[str] = []
    convs = [t for c in (scope.get("conversations") or []) for t in [c["table"], c["messages"]["table"], *([c["attachments"]["table"]] if c.get("attachments") else [])]]
    for t in [o["table"] for o in scope.get("objects", [])] + [r["table"] for r in scope.get("relations", [])] + convs + ([scope["people"]["table"]] if scope.get("people") else []):
        if t not in out:
            out.append(t)
    return out


EXPOSURE_SQL = """SELECT
  coalesce((SELECT bool_or(cfg ~ ('(^|[=, ])' || %(s)s || '($|[, ])')) FROM pg_db_role_setting rs JOIN pg_roles r ON r.oid = rs.setrole CROSS JOIN LATERAL unnest(rs.setconfig) AS cfg WHERE r.rolname = 'authenticator' AND cfg LIKE 'pgrst.db_schemas=%%'), false) AS api,
  CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = %(s)s) THEN coalesce((SELECT bool_or(has_schema_privilege(r.rolname, %(s)s, 'USAGE')) FROM pg_roles r WHERE r.rolname = 'anon'), false) ELSE false END AS anon,
  CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = %(s)s) THEN coalesce((SELECT bool_or(has_schema_privilege(r.rolname, %(s)s, 'USAGE')) FROM pg_roles r WHERE r.rolname = 'authenticated'), false) ELSE false END AS authenticated,
  EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL unnest(coalesce(n.nspacl, '{}'::aclitem[])) AS a WHERE n.nspname = %(s)s AND a::text LIKE '=%%') AS pub"""


def psycopg_rights(conn: Any, scope: Mapping[str, Any], view_schema: str | None = None) -> Callable[[], dict[str, Any]]:
    """Check the role's rights instead of claiming them: superuser (pg_roles.rolsuper) and INSERT/UPDATE/DELETE per scope table (has_table_privilege);
    with `view_schema` (the reader role's views, e.g. everydeck_read) also whether the schema is reachable through the Supabase API (pgrst.db_schemas) or for anon/authenticated/PUBLIC."""
    def check() -> dict[str, Any]:
        cur = conn.cursor()
        cur.execute("SELECT current_user::text, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)")
        role, superuser = cur.fetchone()
        writable = []
        for t in scope_tables(scope):
            # via the catalog (pg_class), not by name: has_table_privilege(name) requires USAGE on the schema, which a reader role does not have
            schema, name = t.split(".", 1) if "." in t else ("public", t)
            cur.execute("SELECT (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE') OR has_table_privilege(current_user, c.oid, 'DELETE')) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s AND c.relname = %s", [schema, name])
            row = cur.fetchone()
            if row and row[0]:
                writable.append(t)
        out = {"role": role, "superuser": bool(superuser), "writable": writable, "select_only": not superuser and not writable, "checked_at": _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")}
        if view_schema:   # the views run as their owner (no app row-level policies): nobody but the reader role may access the schema
            cur.execute(EXPOSURE_SQL, {"s": view_schema})
            api, anon, authenticated, pub = cur.fetchone()
            out["exposed"] = [n for n, v in (("supabase api", api), ("anon", anon), ("authenticated", authenticated), ("public", pub)) if v]
        return out
    return check
