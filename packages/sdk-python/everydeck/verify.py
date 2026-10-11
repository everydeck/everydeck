"""B30 Schnitt E – Prüfhilfe für Brücken: everydeck signiert jeden Aufruf an eine Lese- oder App-Brücke (wie Stripe).

Kopfzeilen: X-Everydeck-Timestamp (Unix-Sekunden), X-Everydeck-Request-Id (UUID), X-Everydeck-Signature (v1=<hex>[,v1=<hex>] – eine je gültigem Schlüssel).
Signatur = HMAC-SHA256(Schlüssel, "EVERYDECK-V1\\n" + METHOD + "\\n" + Pfad ab /everydeck/ mit Query + "\\n" + Zeitstempel + "\\n" + request_id + "\\n" + SHA-256(Körper) hex).
Die App lehnt ab, wenn der Zeitstempel mehr als 5 Minuten abweicht oder die request_id in dieser Zeit schon gesehen wurde.
B31 Abnahme (A8): Die request_id der Signatur (X-Everydeck-Request-Id) ist je HTTP-Aufruf neu, auch wenn everydeck denselben Auftrag wiederholt – der
Replay-Schutz trifft nur eine wörtlich wiederholte Anfrage. Die Idempotenz einer Aktion trägt `request_id` im Körper und `Idempotency-Key`;
eine Wiederholung beantwortet die Tür mit dem festgehaltenen Ergebnis, nie mit 401.

Eine Zeile in der Tür der App (FastAPI):
    v = verify_everydeck_request(request.method, str(request.url), request.headers, await request.body(), keys=[os.environ["EVERYDECK_BRIDGE_KEY"]])
    if not v.ok: raise HTTPException(401)
"""
from __future__ import annotations

import hashlib
import hmac
import threading
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping
from urllib.parse import urlsplit

SIGNATURE_WINDOW_SECONDS = 300


def bridge_path(url_or_path: str) -> str:
    i = url_or_path.find("/everydeck/")
    if i >= 0:
        return url_or_path[i:]
    u = urlsplit(url_or_path)
    return u.path + (("?" + u.query) if u.query else "")


def canonical_string(method: str, url_or_path: str, timestamp: int | str, request_id: str, body: bytes | str | None) -> str:
    raw = body.encode() if isinstance(body, str) else (body or b"")
    return f"EVERYDECK-V1\n{method.upper()}\n{bridge_path(url_or_path)}\n{timestamp}\n{request_id}\n{hashlib.sha256(raw).hexdigest()}"


def signature_for(key: str, canonical: str) -> str:
    return hmac.new(key.encode(), canonical.encode(), hashlib.sha256).hexdigest()


class MemorySeen:
    """Replay-Speicher je Prozess: request_id → Zeitstempel, aufgeräumt nach dem Fenster (mehrere Instanzen: eigene Prüfung, z. B. Redis/Postgres)."""

    def __init__(self, window_seconds: int = SIGNATURE_WINDOW_SECONDS, now: Callable[[], float] = time.time) -> None:
        self._m: dict[str, float] = {}; self._lock = threading.Lock(); self.window = window_seconds; self.now = now

    def __call__(self, request_id: str, timestamp: float) -> bool:
        with self._lock:
            t = self.now()
            for k in [k for k, v in self._m.items() if v < t - self.window]:
                del self._m[k]
            if request_id in self._m:
                return True
            self._m[request_id] = timestamp
            return False


_default_seen = MemorySeen()


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    reason: str | None = None   # missing_headers | bad_timestamp | stale | no_signature_matches | replay | no_keys
    request_id: str | None = None
    timestamp: int | None = None


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for k in (name, name.lower(), name.upper(), name.title()):
        v = headers.get(k)
        if v is not None:
            return v if isinstance(v, str) else str(v)
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v if isinstance(v, str) else str(v)
    return None


def verify_everydeck_request(method: str, url_or_path: str, headers: Mapping[str, str], body: bytes | str | None, *, keys: Iterable[str | None],
                       max_skew_seconds: int = SIGNATURE_WINDOW_SECONDS, seen: Callable[[str, float], bool] | None = None, now: Callable[[], float] = time.time) -> VerifyResult:
    ks = [k for k in keys if isinstance(k, str) and k]
    if not ks:
        return VerifyResult(False, "no_keys")
    ts = _header(headers, "x-everydeck-timestamp"); rid = _header(headers, "x-everydeck-request-id"); sig = _header(headers, "x-everydeck-signature")
    if not ts or not rid or not sig:
        return VerifyResult(False, "missing_headers")
    if not ts.strip().isdigit() or len(ts.strip()) > 12 or len(rid) > 128:
        return VerifyResult(False, "bad_timestamp")
    timestamp = int(ts.strip())
    if abs(now() - timestamp) > max_skew_seconds:
        return VerifyResult(False, "stale")
    given = [p.strip()[3:].lower() for p in sig.split(",") if p.strip().startswith("v1=")]
    canonical = canonical_string(method, url_or_path, timestamp, rid, body)
    matched = False
    for key in ks:
        expected = signature_for(key, canonical)
        for g in given:
            if hmac.compare_digest(g, expected):
                matched = True
    if not matched:
        return VerifyResult(False, "no_signature_matches")
    if (seen or _default_seen)(rid, timestamp):
        return VerifyResult(False, "replay")
    return VerifyResult(True, None, rid, timestamp)


def sign_everydeck_request(keys: Iterable[str], method: str, url_or_path: str, body: bytes | str | None = None, request_id: str | None = None, now: float | None = None) -> dict[str, str]:
    """Gegenstück für Tests und Prüfskripte der App: Kopfzeilen, wie everydeck sie schickt (erster Schlüssel aktuell, weitere vorige). Im Produkt signiert nur everydeck."""
    import uuid
    timestamp = int((time.time() if now is None else now))
    rid = request_id or str(uuid.uuid4())
    canonical = canonical_string(method, url_or_path, timestamp, rid, body)
    ks: list[str] = []
    for k in keys:
        if k and k not in ks:
            ks.append(k)
    return {"X-Everydeck-Timestamp": str(timestamp), "X-Everydeck-Request-Id": rid, "X-Everydeck-Signature": ",".join(f"v1={signature_for(k, canonical)}" for k in ks)}
