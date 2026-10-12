"""Die allgemeine Lese-Brücke (B29 Abnahme, docs/04 „Lese-Bridge“) – Python-Fassung des TypeScript-SDKs (read-bridge.ts), gleiches Verhalten.

Ein Endpunkt je deklarierter Tabelle, nur deklarierte Spalten, mit Cursor. Der Agent schreibt keine Brücke je App: er holt den Lese-Umfang
(`everydeck/everydeck-read-scope.json`, aus dem Befund abgeleitet) und gibt eine Funktion `rows(table, columns, keys, after, limit)` mit, die Zeilen aus
der Datenbank der App liest – über eine eigene Leserolle (nur SELECT). `psycopg_rows(conn)` ist die fertige Fassung für psycopg (2 oder 3).

    bridge = ReadBridge(scope=json.load(open("everydeck/everydeck-read-scope.json")), token=os.environ["EVERYDECK_READ_BRIDGE_TOKEN"], rows=psycopg_rows(conn))
    # FastAPI:  @app.api_route("/everydeck/read/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    #           async def everydeck_read(rest: str, request: Request):
    #               status, body = bridge.handle(request.method, request.url.path, dict(request.query_params), request.headers.get("authorization"))
    #               return JSONResponse(body, status_code=status)

Vertrag: GET /everydeck/read/capabilities · GET /everydeck/read/objects/{type}?cursor&limit · GET /everydeck/read/people?cursor&limit; eigener Bearer-Schlüssel;
jedes Schreibverb wird abgewiesen; Seiten ≤ 200; Kennungen als Text (mehrere Schlüsselspalten mit „|“); Zeitstempel ISO-8601; Objektwerte
als JSON-Text; kein Wert länger als 256 Zeichen. Beziehungen werden wie Objektarten geliefert (type = relations[].id).
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
# rows(table, columns, keys, after, limit[, changed]) – changed = {"column", "since"}: nur Geändertes, stabil nach (Änderungsspalte, Schlüssel); Cursor dann [Änderungszeit, …Schlüssel] (B30 Schnitt A)
Rows = Callable[..., Iterable[Mapping[str, Any]]]


def _text(v: Any) -> str:
    if isinstance(v, _dt.datetime):
        return (v if v.tzinfo else v.replace(tzinfo=_dt.timezone.utc)).isoformat().replace("+00:00", "Z")
    if isinstance(v, (_dt.date, _dt.time)):
        return v.isoformat()
    if isinstance(v, str):
        return v
    if isinstance(v, (dict, list)):
        return json.dumps(v, separators=(",", ":"), default=str)
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
    """Gegenstück (everydeck und Tests): Query-Parameter einer Freigabe – grant = base64url(JSON), grant_sig = v1=<hex> je Schlüssel."""
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
    """B46 Punkt 3: Freigabe prüfen – Signatur mit einem gültigen Schlüssel, genau dieses Gespräch, Grund, nicht abgelaufen, Nachrichtentabelle vollständig.
    Gibt das Gespräch ({messages, attachments}) zurück oder den Grund der Ablehnung."""
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
                 match: Callable[..., Iterable[Mapping[str, Any]]] | None = None) -> None:
        # B31 Schnitt A: match(table, columns, where_column, values, order, after, limit) → Zeilen eines Gesprächs (psycopg_match); ohne match keine Gespräche
        self.match = match
        # B30 Schnitt A: one(table, columns, keys, ref) → eine Zeile; deleted(table, keys, since, limit) → [{ref, deleted_at}] (Löschungen, die die App kennt)
        self.one = one; self.deleted = deleted
        # B30 Schnitt E: everydeck signiert jeden Aufruf – "required" (Standard) lehnt unsignierte ab, "optional" nimmt den Bearer ohne Signatur (ältere everydeck-Stände), "off" prüft nur den Bearer;
        # keys = gültige Schlüssel (Standard: token; während eines Tauschs der neue und der alte), seen = Replay-Schutz über mehrere Instanzen
        if signatures not in ("required", "optional", "off"): raise ValueError("signatures must be required, optional or off")
        self.signatures = signatures; self.keys = list(keys) if keys else [token]; self.seen = seen
        self.scope = scope
        self.token = token
        self.rows = rows
        self.app = app
        self.page_limit = min(PAGE_MAX, max(1, page_limit))
        self._rights = rights   # fest, oder eine Funktion, die beim ersten Aufruf prüft (psycopg_rights) – nie behauptet
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
        # B30 Schnitt A: je Objektart, ob changed_since geht (Änderungsspalte im Umfang), und ob der Einzelabruf geht
        objects = [{"type": o["type"], "fields": [f["name"] for f in o["fields"]], **({"statuses": list(o["statuses"])} if o.get("statuses") else {}), "changed_since": bool(o.get("changed"))} for o in self.scope.get("objects", [])]
        objects += [{"type": r["id"], "fields": [f["name"] for f in r["fields"]], "changed_since": False} for r in self.scope.get("relations", [])]
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
        # headers/url/body (B30 Schnitt E): Kopfzeilen und Pfad mit Query, wie die App sie sieht – für die Signaturprüfung; FastAPI: request.headers, str(request.url), await request.body()
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
            return 401, {"error": "signature required (X-Everydeck-Signature missing) – everydeck signs every call since B30; use signatures=\"optional\" for older everydeck instances"}
        elif not hmac.compare_digest((authorization or "").encode(), f"Bearer {self.token}".encode()):   # zeitkonstant
            return 401, {"error": "read key invalid"}
        if method.upper() != "GET":
            return 405, {"error": "read only"}
        if path == "/everydeck/read/capabilities":
            return 200, self.capabilities()
        as_of = _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")
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

            def name_of(r):   # B35 Punkt 3: Anzeigename nach der Regel der App – erste Stufe mit Inhalt, Teile mit dem Trennzeichen der App (wie read-bridge.ts)
                for st in steps:
                    parts = [x for x in ("" if r.get(c) is None else _text(r[c]).strip() for c in st["columns"]) if x]
                    if parts:
                        return st.get("separator", " ").join(parts)[:VALUE_MAX]
                return None
            items = [{"subject_ref": _text(r[p["ref"]])[:128], **{f: (None if r.get(c) is None else _text(r[c])[:VALUE_MAX]) for f, c in p["fields"].items()}, **({"display_name": name_of(r)} if steps and "display_name" in p["fields"] else {})} for r in kept]
            return 200, {"as_of": as_of, "items": items, "next_cursor": _b64([_text(kept[-1][p["ref"]])]) if len(rows) > limit else None}
        if path.startswith("/everydeck/read/messages/") and path[len("/everydeck/read/messages/"):].count("/") == 1:   # B31 Schnitt A: Nachrichten eines Gesprächs, nur auf Abruf
            typ, ref = path[len("/everydeck/read/messages/"):].split("/", 1)
            if self.match is None:
                return 404, {"error": "this bridge reads no conversations"}
            # B46 Punkt 3: nur mit der Freigabe von everydeck für genau dieses Gespräch (geöffnet mit Grund); Tabelle und Spalten stehen nur in ihr
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
        if rest is not None and rest.count("/") == 1:   # B30 Schnitt A: Einzelabruf GET /everydeck/read/objects/{type}/{ref}
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
            if since_raw is not None:   # B30 Schnitt A: nur Geändertes seit since, stabil nach (Änderungsspalte, Schlüssel); dazu Gelöschtes, wo die App es kennt
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
    """Zeitstempel als ISO-8601 (UTC, Z) oder None"""
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
    """Name der Sicht im Schema der Leserolle (everydeck’s SQL legt sie an): Tabelle, außerhalb von public `<schema>__<tabelle>`."""
    return table.replace(".", "__", 1) if "." in table else table


def psycopg_rows(conn: Any, schema: str | None = None) -> Rows:
    """`rows` für psycopg 2/3: Keyset-Cursor über die Schlüsselspalten, nur die genannten Spalten; die Verbindung gehört der Leserolle.
    `schema`: die Sichten der Leserolle (z. B. everydeck_read) statt der Tabellen – so greifen die Zeilenrechte der App nicht für den Leser."""
    def rows(table: str, columns: Sequence[str], keys: Sequence[str], after: Sequence[str] | None, limit: int, changed: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
        src = f"{_ident(schema)}.{_ident(read_view_name(table))}" if schema else _ident(table)
        lim = f"LIMIT {max(1, min(PAGE_MAX + 1, int(limit)))}"
        cur = conn.cursor()
        if changed:   # B30 Schnitt A: nur Geändertes seit since, stabil nach (Änderungsspalte, Schlüssel); Cursor = [Änderungszeit, …Schlüssel]
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


def psycopg_one(conn: Any, schema: str | None = None) -> Callable[[str, Sequence[str], Sequence[str], Sequence[str]], Mapping[str, Any] | None]:
    """B30 Schnitt A: `one` für psycopg – genau eine Zeile nach ihren Schlüsselwerten."""
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
    """B31 Schnitt A: `match` für psycopg – Zeilen mit where_column = ANY(values), Keyset-Cursor über order (Nachrichten eines Gesprächs)."""
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
    """Alle Tabellen des Umfangs (Objekte, Beziehungen, Gespräche, Personen)."""
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
    """Rechte der Rolle prüfen, nicht behaupten: Superuser (pg_roles.rolsuper) und INSERT/UPDATE/DELETE je Tabelle des Umfangs (has_table_privilege);
    mit `view_schema` (Sichten der Leserolle, z. B. everydeck_read) zusätzlich, ob das Schema über die Supabase-API (pgrst.db_schemas) oder für anon/authenticated/PUBLIC erreichbar ist."""
    def check() -> dict[str, Any]:
        cur = conn.cursor()
        cur.execute("SELECT current_user::text, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)")
        role, superuser = cur.fetchone()
        writable = []
        for t in scope_tables(scope):
            # über den Katalog (pg_class), nicht über den Namen: has_table_privilege(name) verlangt USAGE auf dem Schema – eine Leserolle hat das nicht
            schema, name = t.split(".", 1) if "." in t else ("public", t)
            cur.execute("SELECT (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE') OR has_table_privilege(current_user, c.oid, 'DELETE')) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s AND c.relname = %s", [schema, name])
            row = cur.fetchone()
            if row and row[0]:
                writable.append(t)
        out = {"role": role, "superuser": bool(superuser), "writable": writable, "select_only": not superuser and not writable, "checked_at": _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")}
        if view_schema:   # die Sichten laufen als Eigentümer (keine Zeilenrechte der App): niemand außer der Leserolle darf an das Schema
            cur.execute(EXPOSURE_SQL, {"s": view_schema})
            api, anon, authenticated, pub = cur.fetchone()
            out["exposed"] = [n for n, v in (("supabase api", api), ("anon", anon), ("authenticated", authenticated), ("public", pub)) if v]
        return out
    return check
