"""everydeck Python SDK (R0, Transportvertrag 1.0-r0).

Zusagen (docs/05, belegt in P2a und tests/):
- `signal()/error()/log()` blockieren nie und werfen nie: O(1) Enqueue in einen begrenzten Speicherpuffer. Kein Datei- oder Netz-IO im Aufrufer.
- Ein Sender-Thread überträgt Batches (max. 50 Ereignisse, 64 KiB). Drei getrennte Ergebnisse je Batch:
  angenommen (202) · erneut versuchen (429, 5xx, Timeout, Netz) · endgültig abgewiesen (400/401/403/409/413/422).
  Abgewiesene Batches zählen nie als gesendet; 401/403 pausieren den Sender (auth_pause_seconds) und melden eine Warnung.
- B30 Schnitt D (0.1.1): Batches gehen gzip-komprimiert (`compress=False` schaltet es ab), `Retry-After` bei 429/503 wird befolgt,
  Wiederholungen mit vollem Zufallsanteil (`full_jitter`); `stats`: batches_compressed, bytes_raw, bytes_sent, retry_after_waits – wie das TypeScript-SDK.
- B30 Schnitt E (0.1.2): `everydeck.verify.verify_everydeck_request` prüft die Signatur von everydeck an Brücken (5-Minuten-Fenster, request_id einmalig); `ReadBridge` prüft selbst (`signatures="required"`).
- B33 (0.1.5): `error(..., exc=e)` schickt zu bis zu 5 Frames im Code der App die Code-Zeilen mit (Fundzeile und je 5 davor und danach, je höchstens 200 Zeichen, bereinigt wie Fehlermeldungen); gelesen im Sender-Thread, nie im Aufruf; `Everydeck(..., source_context=False)` schaltet es ab. `error.context_status` sagt, ob Zeilen dabei sind oder warum nicht.
- B34b (0.1.6): `error(..., response={code, message})` wie im TS-SDK (Code nur als Kennung, Meldung bereinigt, 300 Zeichen); `answer_of(exc)` liest beides aus Attributen der Ausnahme (z. B. postgrest `APIError.code`/`.message`), nie aus ihrem Text.
- B32 (0.1.4): `signal`, `error` und `log` nehmen `object_type`/`object_ref` wie das TS-SDK (`objectType`/`objectRef`).
- B31 (0.1.3): `Everydeck.error(..., exc=e)` sendet die Stack-Frames der Ausnahme (`error.frames`, innerste zuerst) – oder fertige `frames=[…]`; `ReadBridge(match=psycopg_match(conn))` liefert die Nachrichten eines Gesprächs auf Abruf (`GET /everydeck/read/messages/{type}/{ref}`).
- Der Sender-Thread endet nie unbemerkt: jede Ausnahme wird gezählt, gemeldet und die Schleife fortgesetzt.
- Pufferüberlauf wird als Ereignis `gap` (buffer_overflow) gemeldet: eine *erkennbare* Datenlücke.
- Optionaler Spool (JSONL, begrenzte Größe) läuft in einem eigenen Thread, der als einziger die Datei anfasst: Schreibvorgänge und
  Bestätigungen (angenommene/abgewiesene Ereignisse) kommen über zwei begrenzte Warteschlangen im RAM (`max_spool_queue`) und werden im
  Spool-Thread gemeinsam ausgewertet – eine Bestätigung, die vor dem Schreiben eintrifft, verhindert das Schreiben, statt eine Waise zu
  hinterlassen. Weder Aufrufer noch Sender halten während Datei-IO eine Sperre. Fehler (voll, nicht beschreibbar) werden gezählt und
  gemeldet, betreffen aber weder Kundenrequests noch den Sender. Beim Start werden unbeschädigte Spool-Zeilen nachgeliefert (`gap`
  restart_recovered); beschädigte Zeilen (abgebrochener Schreibvorgang) werden gezählt und verworfen. Ohne Spool bleibt ein SIGKILL unsichtbar.
  Laufen die Warteschlangen über (Spool-Thread hängt an langsamem Datenträger), werden die ältesten Einträge verworfen und gezählt
  (`spool_queue_dropped`, `spool_ack_dropped`); Folge einer verworfenen Bestätigung ist höchstens eine erneute Zustellung bereits angenommener
  Ereignisse nach einem Neustart (everydeck dedupliziert je event_id), nie ein Verlust.
- Lebenszeichen (R1): mit `heartbeat_interval` sendet der Sender-Thread alle n Sekunden ein Signal `everydeck.sdk.heartbeat`
  (operation_id `everydeck.sdk:<instance_id>`, Felder instance_id/interval_seconds/pid). Ausbleibende Lebenszeichen sind für everydeck eine
  Überwachungslücke, kein bewiesener Ausfall der App.
- Das SDK kennt keine Datenbank von everydeck und entscheidet keine Engine-Urteile.
"""
from __future__ import annotations

import atexit
import gzip
import json
import logging
import os
import random
import re
import signal as _signal
import socket
import threading
import time
import uuid
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable, Literal

__all__ = ["Everydeck", "AfterCommit", "SCHEMA_VERSION", "BATCH_MAX", "error_class_of", "scrub_text", "answer_of"]

SCHEMA_VERSION = "1.3-r0"
# B23: Herkunft jedes Ereignisses – ein Server-Schlüssel meldet immer die Plattform `server`
CLIENT = {"platform": "server", "runtime": "python"}
BATCH_MAX = 50
BATCH_MAX_BYTES = 64 * 1024
EVENT_MAX_BYTES = 8 * 1024
_REJECT = {400, 401, 403, 409, 413, 422}
_AUTH = {401, 403}
Outcome = Literal["accepted", "retry", "rejected"]
_log = logging.getLogger("everydeck")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


_COMMIT_ENV = ("GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA", "RENDER_GIT_COMMIT", "CF_PAGES_COMMIT_SHA", "COMMIT_REF", "SOURCE_VERSION", "CI_COMMIT_SHA")


def resolve_release_key(env: dict[str, str] | None = None, cwd: str | None = None) -> str:
    """B15/C5: automatische Versionskennung – gleiche Regel wie @everydeck/sdk resolveReleaseKey und everydeck-agent version.

    EVERYDECK_RELEASE_KEY (außer "auto") > Commit aus CI/Hosting (git:<sha12>) > lokales Git (git:<sha12>[+dirty.<hash8>]) > "unknown".
    """
    import hashlib
    import re
    import subprocess

    e = os.environ if env is None else env
    explicit = e.get("EVERYDECK_RELEASE_KEY")
    if explicit and explicit != "auto":
        return explicit[:128]
    for k in _COMMIT_ENV:
        v = e.get(k)
        if v and re.fullmatch(r"[0-9a-fA-F]{7,64}", v):
            return f"git:{v.lower()[:12]}"

    def run(d: str, *a: str) -> bytes:
        return subprocess.run(["git", *a], cwd=d, capture_output=True, check=True).stdout

    try:
        top = run(cwd or os.getcwd(), "rev-parse", "--show-toplevel").decode().strip()
        head = run(top, "rev-parse", "HEAD").decode().strip()[:12]
        h = hashlib.sha256(run(top, "diff", "HEAD", "--binary"))
        untracked = sorted(x for x in run(top, "ls-files", "--others", "--exclude-standard", "-z").decode().split("\0") if x)
        for f in untracked:
            h.update(f"\0{f}\0".encode())
            try:
                with open(os.path.join(top, f), "rb") as fh:
                    h.update(fh.read())
            except OSError:
                pass
        dirty = bool(untracked) or bool(run(top, "status", "--porcelain", "--untracked-files=no").strip())
        return f"git:{head}+dirty.{h.hexdigest()[:8]}" if dirty else f"git:{head}"
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _dumps(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"))


def full_jitter(failures: int, cap: float, rnd: Callable[[], float] = random.random) -> float:
    """B30 Schnitt D: Backoff mit vollem Zufallsanteil („full jitter"): gleichverteilt in [0, min(cap, 0.5 s · 2^n)] – wie das TypeScript-SDK."""
    ceiling = min(cap, 0.5 * 2 ** max(0, min(6, failures)))
    return rnd() * ceiling


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """`Retry-After` als Sekunden oder HTTP-Datum → Sekunden, begrenzt auf eine Stunde; None, wenn fehlt oder unlesbar."""
    if not value:
        return None
    v = value.strip()
    if v.isdigit():
        secs = float(v)
    else:
        from email.utils import parsedate_to_datetime
        try:
            secs = parsedate_to_datetime(v).timestamp() - (time.time() if now is None else now)
        except (TypeError, ValueError):
            return None
    return max(0.0, min(3600.0, secs))


class Everydeck:
    def __init__(
        self,
        endpoint: str,
        credential: str,
        *,
        release_key: str,
        manifest_digest: str,
        max_buffer: int = 500,
        flush_interval: float = 1.0,
        http_timeout: float = 2.0,
        shutdown_budget: float = 5.0,
        spool_path: str | None = None,
        max_spool_bytes: int = 5 * 1024 * 1024,
        max_spool_queue: int = 1000,
        auth_pause_seconds: float = 30.0,
        max_send_backoff: float = 30.0,
        on_warning: Callable[[str], None] | None = None,
        install_signal_handlers: bool = False,
        enabled: bool = True,
        heartbeat_interval: float | None = None,
        instance_id: str | None = None,
        probe_id: str | None = None,
        compress: bool = True,
        source_context: bool = True,
    ) -> None:
        self.endpoint = (endpoint or "").rstrip("/")
        self.credential = credential or ""
        self.release_key = resolve_release_key() if not release_key or release_key == "auto" else release_key
        self.manifest_digest = manifest_digest or ""
        # B15/C7: Prüflauf der Einrichtung (nur Verifikationsskripte)
        self.probe_id = probe_id
        self.max_buffer = max_buffer
        self.flush_interval = flush_interval
        self.http_timeout = http_timeout
        self.shutdown_budget = shutdown_budget
        self.spool_path = spool_path
        self.max_spool_bytes = max_spool_bytes
        self.max_spool_queue = max(1, int(max_spool_queue))
        self.auth_pause_seconds = auth_pause_seconds
        self.max_send_backoff = max_send_backoff
        # B30 Schnitt D: Batches gzip-komprimiert senden (Standard an); everydeck nimmt Content-Encoding: gzip an
        self.compress = compress
        # B33: Code-Zeilen zu den Frames im Code der App (Standard an); Dateien liest der Sender-Thread, zwischengespeichert je Pfad
        self.source_context = source_context
        self._source_cache: dict[str, list[str] | None] = {}
        self._warn_cb = on_warning or (lambda m: _log.warning(m))
        self.enabled = enabled
        # B36: fehlt Adresse oder Schlüssel (z. B. nach einem Update mit neuen Variablennamen), schaltet das SDK ab – aber laut, nie still
        if self.enabled and (not self.endpoint or not self.credential or not self.manifest_digest):
            self.enabled = False
            missing = "no endpoint" if not self.endpoint else "no key" if not self.credential else "no manifest digest"
            self._warn_cb(f"everydeck: disabled: {missing} – nothing is sent to everydeck until the app passes endpoint, key and manifest digest")
        self.heartbeat_interval = heartbeat_interval
        self.instance_id = instance_id or f"{socket.gethostname()[:40]}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self._next_heartbeat = 0.0
        self._q: deque[dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._inflight = False
        self._unreported_loss = 0
        self._paused_until = 0.0
        self._consecutive_failures = 0
        self._spool_q: deque[dict[str, Any]] = deque()          # ausstehende Schreibvorgänge (begrenzt)
        self._spool_acks: dict[str, None] = {}                  # ausstehende Bestätigungen, geordnet (begrenzt)
        self._spool_q_lock = threading.Lock()   # nur Warteschlangen (Aufrufer, Sender, Spool-Thread), nie während Datei-IO gehalten
        self._spool_lock = threading.Lock()     # Datei; nur Spool-Thread (und Wiederherstellung im Konstruktor)
        self._spool_ack_overflow_warned = False
        self._spool_wake = threading.Event()
        self._spool_disabled = False
        self._spool_bytes = 0
        self.stats: dict[str, Any] = {
            "enqueued": 0, "accepted": 0, "dropped_overflow": 0, "dropped_rejected": 0, "dropped_oversize": 0,
            "retries": 0, "batches_accepted": 0, "batches_retried": 0, "batches_rejected": 0,
            "auth_failures": 0, "last_rejection": None, "sender_errors": 0,
            "spool_errors": 0, "spool_corrupt_lines": 0, "spool_dropped": 0, "spool_queue_dropped": 0, "spool_ack_dropped": 0,
            "replayed_from_spool": 0, "spool_disabled": False, "heartbeats": 0,
            "batches_compressed": 0, "bytes_raw": 0, "bytes_sent": 0, "retry_after_waits": 0,   # B30 Schnitt D
        }
        if not enabled:
            return
        self._t = threading.Thread(target=self._run, name="everydeck-sender", daemon=True)
        if self.spool_path:
            self._spool_replay()
            self._st = threading.Thread(target=self._spool_run, name="everydeck-spool", daemon=True)
            self._st.start()
        self._t.start()
        atexit.register(self.close)
        if install_signal_handlers and threading.current_thread() is threading.main_thread():
            for sig in (_signal.SIGTERM, _signal.SIGINT):
                prev = _signal.getsignal(sig)

                def handler(signum: int, frame: Any, prev: Any = prev) -> None:
                    self.close(self.shutdown_budget)
                    if callable(prev):
                        prev(signum, frame)
                    else:
                        raise SystemExit(0)

                _signal.signal(sig, handler)

    # ---------------- API (nie blockierend, nie werfend) ----------------
    def signal(self, name: str, operation_id: str, *, attempt_id: str | None = None, subject_ref: str | None = None,
               account_ref: str | None = None, fields: dict[str, Any] | None = None, request_id: str | None = None,
               business_key: str | None = None, object_type: str | None = None, object_ref: str | None = None) -> str | None:
        """B32 (0.1.4): `object_type`/`object_ref` nennen das Objekt des Ergebnisses (wie `objectType`/`objectRef` im TS-SDK)."""
        return self._enq({"kind": "signal", "name": name, "operation_id": str(operation_id),
                          **_opt(attempt_id=attempt_id, subject_ref=subject_ref, account_ref=account_ref, fields=fields,
                                 request_id=request_id, business_key=business_key, object_type=object_type, object_ref=object_ref)})

    def heartbeat(self, interval_seconds: float, *, job: str | None = None) -> str | None:
        """Lebenszeichen auf Abruf. Mit `job` (1.9-r0, `jobs[].id` im Manifest): dieser Job ist gelaufen – am Ende jedes erfolgreichen Laufs
        senden; everydeck meldet einen Job, der zwei Takte schweigt. Ohne `job`: diese Prozessinstanz läuft (wie `heartbeat_interval`)."""
        import re as _re
        if job is not None and not _re.fullmatch(r"[a-z][a-z0-9_.-]{0,63}", job):
            _log.warning("everydeck: heartbeat job id rejected: %r", job)
            return None
        fields: dict[str, Any] = {"instance_id": self.instance_id, "interval_seconds": float(interval_seconds)}
        if job is not None:
            fields["job"] = job
        return self._enq({"kind": "signal", "name": "everydeck.sdk.heartbeat", "operation_id": f"everydeck.job:{job}" if job else f"everydeck.sdk:{self.instance_id}", "fields": fields})

    def error(self, name: str, error_class: str, *, message: str | None = None, operation_id: str | None = None,
              attempt_id: str | None = None, subject_ref: str | None = None, account_ref: str | None = None,
              fields: dict[str, Any] | None = None, http: dict[str, Any] | None = None, request_id: str | None = None,
              frames: list[dict[str, Any]] | None = None, exc: BaseException | None = None, object_type: str | None = None,
              object_ref: str | None = None, response: dict[str, Any] | None = None) -> str | None:
        """B31: mit `exc` (die abgefangene Ausnahme) bildet das SDK die Stack-Frames selbst – innerste zuerst, höchstens 20,
        Datei als die letzten zwei Pfadteile wie im Browser-SDK; `frames` übergibt sie fertig ({function, file?, line?})."""
        err: dict[str, Any] = {"class": error_class}
        if message:
            err["message"] = str(message)[:1024]
        # 1.4-r0 (B33b, B34b): Fehlercode und Meldung aus der Antwort, die die App bekam – wie im TS-SDK (Code nur als Kennung, Meldung bereinigt, 300 Zeichen)
        if response:
            ans: dict[str, Any] = {}
            code = response.get("code"); msg = response.get("message")
            if isinstance(code, str) and _ANSWER_CODE.match(code):
                ans["code"] = code
            if isinstance(msg, str) and msg.strip():
                ans["message"] = scrub_text(msg)[:300]
            if ans:
                err["response"] = ans
        fr = frames if frames is not None else (_frames_of(exc) if exc is not None else None)
        if fr:
            keep_abs = frames is None and self.source_context   # der volle Pfad bleibt nur bis zum Sender-Thread (Code-Zeilen), er wird nie gesendet
            err["frames"] = [{"function": str(f.get("function") or "anonymous")[:128], **({"file": str(f["file"])[:240]} if f.get("file") else {}), **({"line": int(f["line"])} if f.get("line") else {}),
                              **({"in_app": bool(f["in_app"])} if isinstance(f.get("in_app"), bool) else {}), **({"_abs": f["_abs"]} if keep_abs and f.get("_abs") else {})} for f in fr[:20]]
            if not self.source_context:
                err["context_status"] = "disabled"
            elif frames is not None:
                err["context_status"] = "frames_without_source"
        ev: dict[str, Any] = {"kind": "error", "name": name, "error": err,
                              **_opt(operation_id=operation_id, attempt_id=attempt_id, subject_ref=subject_ref,
                                     account_ref=account_ref, fields=fields, request_id=request_id, object_type=object_type, object_ref=object_ref)}
        if http:
            ev["http"] = http
        return self._enq(ev)

    def identify(self, subject_ref: str, *, account_ref: str | None = None, display_name: str | None = None,
                 email: str | None = None, login_method: str | None = None, provider_user_id: str | None = None,
                 org_name: str | None = None) -> str | None:
        """Identitätsquelle (Manifest 1.1 `people`): freigegebene Stammdaten einer Person. everydeck speichert nur die im freigegebenen
        Manifest genannten Felder; alle anderen werden verworfen und gezählt. Kein Vorgang, keine Regel. Nur serverseitig sinnvoll."""
        fields: dict[str, Any] = {k: str(v)[:256] for k, v in {"display_name": display_name, "email": email, "login_method": login_method,
                                                              "provider_user_id": provider_user_id, "org_name": org_name}.items() if v is not None}
        self.stats["identities"] = self.stats.get("identities", 0) + 1
        return self._enq({"kind": "signal", "name": "everydeck.sdk.identity", "operation_id": f"everydeck.sdk:identity:{str(subject_ref)[:100]}",
                          "subject_ref": str(subject_ref), **_opt(account_ref=account_ref), "fields": fields})

    def log(self, template_id: str, name: str, *, fields: dict[str, Any] | None = None, operation_id: str | None = None,
            request_id: str | None = None, object_type: str | None = None, object_ref: str | None = None) -> str | None:
        return self._enq({"kind": "log", "template_id": template_id, "name": name,
                          **_opt(fields=fields, operation_id=operation_id, request_id=request_id, object_type=object_type, object_ref=object_ref)})

    def flush(self, timeout: float | None = None) -> bool:
        """Wartet, bis der Puffer geleert ist. False bei Ablauf des Budgets (z. B. everydeck nicht erreichbar)."""
        if not self.enabled:
            return True
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            with self._lock:
                empty = not self._q and not self._inflight and not self._unreported_loss
            if empty:
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
            self._paused_until = 0.0  # ein expliziter Flush hebt die Auth-Pause auf (ein Versuch)
            self._wake.set()
            time.sleep(0.02)

    def close(self, timeout: float | None = None) -> bool:
        if not self.enabled or self._stop.is_set():
            return True
        budget = self.shutdown_budget if timeout is None else timeout
        deadline = time.monotonic() + budget
        ok = self.flush(budget)
        self._stop.set()
        self._wake.set()
        self._spool_wake.set()
        st = getattr(self, "_st", None)
        if st is not None and st is not threading.current_thread():
            st.join(max(0.0, deadline - time.monotonic()))  # ausstehende Spool-Bestätigungen noch anwenden (begrenzt)
        return ok

    # ---------------- Enqueue ----------------
    def _enq(self, ev: dict[str, Any]) -> str | None:
        if not self.enabled:
            return None
        try:
            ev = {"event_id": str(uuid.uuid4()), "occurred_at": _now(), **ev}
            ev.setdefault("client", dict(CLIENT))
            if len(_dumps(ev)) > EVENT_MAX_BYTES:
                with self._lock:
                    self.stats["dropped_oversize"] += 1
                    self._unreported_loss += 1
                return None
            spool = bool(self.spool_path) and not self._spool_disabled
            spool_dropped = 0
            if spool:
                # Reihenfolge ist Absicht: erst Schreibauftrag, dann Sendepuffer. Der Sender kann ein Ereignis erst nach diesem
                # Schritt sehen; der Spool-Thread sieht deshalb eine Bestätigung nie ohne den zugehörigen Schreibauftrag.
                with self._spool_q_lock:
                    if len(self._spool_q) >= self.max_spool_queue:
                        self._spool_q.popleft()
                        spool_dropped = 1
                    self._spool_q.append(ev)
            with self._lock:
                self.stats["enqueued"] += 1
                self.stats["spool_queue_dropped"] += spool_dropped
                if len(self._q) >= self.max_buffer:
                    self._q.popleft()
                    self.stats["dropped_overflow"] += 1
                    self._unreported_loss += 1
                self._q.append(ev)
                wake = len(self._q) >= BATCH_MAX
            if spool:
                self._spool_wake.set()
            if wake:
                self._wake.set()
            return ev["event_id"]
        except Exception as e:  # Kundenrequest darf nie scheitern
            self._warn(f"everydeck: enqueue failed: {e!r}")
            return None

    # ---------------- Sender-Thread ----------------
    def _run(self) -> None:
        while True:
            try:
                self._wake.wait(self.flush_interval if not self.heartbeat_interval else min(self.flush_interval, self.heartbeat_interval))
                self._wake.clear()
                self._maybe_heartbeat()
                if time.monotonic() >= self._paused_until:
                    self._send_pending()
                if self._stop.is_set() and not self._q:
                    break
            except Exception as e:  # Thread endet nie unbemerkt
                self.stats["sender_errors"] += 1
                self._warn(f"everydeck: sender error (continuing): {e!r}")
                time.sleep(full_jitter(self._consecutive_failures, self.max_send_backoff))

    def _maybe_heartbeat(self) -> None:
        """Lebenszeichen im Sender-Thread; läuft über denselben Puffer wie alle Ereignisse (kein Sonderweg, keine Garantie)."""
        if not self.heartbeat_interval or self._stop.is_set():
            return
        now = time.monotonic()
        if now < self._next_heartbeat:
            return
        self._next_heartbeat = now + self.heartbeat_interval
        self.stats["heartbeats"] += 1
        self._enq({"kind": "signal", "name": "everydeck.sdk.heartbeat", "operation_id": f"everydeck.sdk:{self.instance_id}",
                   "fields": {"instance_id": self.instance_id, "interval_seconds": float(self.heartbeat_interval), "pid": float(os.getpid())}})

    def _take_batch(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        size = 2
        loss = self._unreported_loss
        self._unreported_loss = 0
        if loss:
            items.append({"event_id": str(uuid.uuid4()), "occurred_at": _now(), "kind": "gap", "name": "everydeck.sdk.loss",
                          "gap": {"cause": "buffer_overflow", "dropped": loss}})
        while self._q and len(items) < BATCH_MAX:
            n = len(_dumps(self._q[0])) + 1
            if size + n > BATCH_MAX_BYTES - 512 and items:
                break
            items.append(self._q.popleft())
            size += n
        return items

    def _source_lines(self, path: str) -> list[str] | None:
        if path not in self._source_cache:
            try:
                st = os.stat(path)
                if st.st_size > 2_000_000:
                    raise OSError("too large")
                with open(path, encoding="utf-8", errors="replace") as fh:
                    self._source_cache[path] = fh.read().splitlines()
            except OSError:
                self._source_cache[path] = None
            if len(self._source_cache) > 200:
                self._source_cache.pop(next(iter(self._source_cache)))
        return self._source_cache.get(path)

    def _with_source_context(self, ev: dict[str, Any]) -> dict[str, Any]:
        """B33: Code-Zeilen zu höchstens 5 Frames im Code der App; das Ereignis bleibt unter EVENT_MAX_BYTES (was nicht passt: partial).
        Der volle Pfad (`_abs`) verlässt das SDK nie. Kopie – das Original im Puffer und im Spool bleibt unverändert."""
        err = ev.get("error") if isinstance(ev.get("error"), dict) else None
        if not err or not err.get("frames"):
            return ev
        frames = [dict(f) for f in err["frames"]]
        out = {**ev, "error": {**err, "frames": frames}}
        if not err.get("context_status"):
            app = [f for f in frames if f.get("in_app") and f.get("_abs") and f.get("line")][:CONTEXT_FRAMES]
            read = cut = 0
            if not app:
                out["error"]["context_status"] = "library_only"
            else:
                for f in app:
                    lines = self._source_lines(f["_abs"])
                    ctx = _context_of(lines, int(f["line"])) if lines is not None else None
                    if ctx is None:
                        continue
                    read += 1
                    f["context"] = ctx
                    if len(_dumps({**out, "error": {**out["error"], "frames": [{k: v for k, v in x.items() if k != "_abs"} for x in frames]}})) > EVENT_MAX_BYTES - 256:
                        del f["context"]
                        cut += 1
                out["error"]["context_status"] = "unreadable" if read == 0 else "partial" if cut else "sent"
        for f in frames:
            f.pop("_abs", None)
        return out

    def _requeue(self, items: list[dict[str, Any]]) -> None:
        for it in reversed(items):
            if it.get("kind") == "gap" and it["name"] == "everydeck.sdk.loss":
                self._unreported_loss += int(it["gap"].get("dropped", 0))
                continue
            if len(self._q) >= self.max_buffer:
                self.stats["dropped_overflow"] += 1
                self._unreported_loss += 1
                continue
            self._q.appendleft(it)

    def _send_pending(self) -> None:
        while not self._stop.is_set() or self._q:
            with self._lock:
                if not self._q and not self._unreported_loss:
                    return
                items = self._take_batch()
                self._inflight = True
            items = [self._with_source_context(it) for it in items]   # B33: Datei-IO außerhalb der Sperre, auf Kopien (der Spool-Thread liest die Originale)
            try:
                outcome, detail = self._post(items)
            except Exception as e:
                outcome, detail = "retry", {"error": repr(e)[:200]}
                self.stats["sender_errors"] += 1
                self._warn(f"everydeck: sender error (continuing): {e!r}")
            ack: set[str] | None = None
            warn: str | None = None
            stop_after = False
            with self._lock:   # nur Zähler und Zustand; Datei-IO und Callbacks laufen außerhalb dieser Sperre
                if outcome == "accepted":
                    self.stats["accepted"] += len(items)
                    self.stats["batches_accepted"] += 1
                    self._consecutive_failures = 0
                    ack = {i["event_id"] for i in items}
                elif outcome == "rejected":
                    self.stats["batches_rejected"] += 1
                    self.stats["dropped_rejected"] += len(items)
                    self.stats["last_rejection"] = detail
                    ack = {i["event_id"] for i in items}  # kein erneuter Versuch, auch nicht nach Neustart
                    code = int(detail.get("status", 0)) if isinstance(detail, dict) else 0
                    if code in _AUTH:
                        self.stats["auth_failures"] += 1
                        self._paused_until = time.monotonic() + self.auth_pause_seconds
                        warn = f"everydeck: credential rejected ({code}); sender paused {self.auth_pause_seconds:.0f}s, batch dropped"
                        stop_after = True
                    else:
                        warn = f"everydeck: batch rejected by contract ({code}): {detail}"
                else:
                    self.stats["batches_retried"] += 1
                    self.stats["retries"] += 1
                    self._consecutive_failures += 1
                    self._requeue(items)
                    # B30 Schnitt D: Retry-After von everydeck (429 Budget/Kontingent, 503 Schutz) wird befolgt, sonst Backoff mit vollem Zufallsanteil
                    retry_after = detail.get("retry_after") if isinstance(detail, dict) else None
                    if retry_after is not None:
                        self.stats["retry_after_waits"] += 1
                        self._paused_until = max(self._paused_until, time.monotonic() + float(retry_after))
                    else:
                        self._paused_until = time.monotonic() + full_jitter(self._consecutive_failures, self.max_send_backoff)
                    stop_after = True
            if ack:
                self._spool_enqueue_ack(ack)   # vor dem Ende von inflight: flush() sieht erst danach „leer“, close() wartet auf den Spool
            with self._lock:
                self._inflight = False
            if warn:
                self._warn(warn)
            if stop_after:
                return

    def _post(self, items: list[dict[str, Any]]) -> tuple[Outcome, Any]:
        """Genau ein Zustellversuch. Wiederholungen steuert der Sender (Backoff bis max_send_backoff)."""
        body = _dumps({"schema_version": SCHEMA_VERSION, "batch_id": str(uuid.uuid4()), "release_key": self.release_key,
                       "manifest_digest": self.manifest_digest, **({"probe_id": self.probe_id} if self.probe_id else {}), "events": items}).encode()
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + self.credential}
        self.stats["bytes_raw"] += len(body)
        if self.compress:   # B30 Schnitt D
            body = gzip.compress(body, compresslevel=6, mtime=0)
            headers["Content-Encoding"] = "gzip"
            self.stats["batches_compressed"] += 1
        self.stats["bytes_sent"] += len(body)
        req = urllib.request.Request(self.endpoint + "/v1/events", data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.http_timeout) as r:
                if r.status in (200, 202):
                    return "accepted", r.status
                return "retry", {"status": r.status}
        except urllib.error.HTTPError as e:
            snippet = e.read(300).decode("utf-8", "replace") if e.fp else ""
            last: dict[str, Any] = {"status": e.code, "body": snippet}
            if e.code in (429, 503):
                ra = parse_retry_after(e.headers.get("Retry-After") if e.headers else None)
                if ra is not None:
                    last["retry_after"] = ra
            return ("rejected" if e.code in _REJECT else "retry"), last
        except Exception as e:
            return "retry", {"error": repr(e)[:200]}

    # ---------------- Spool-Thread (dauerhafter Hinweis) ----------------
    def _spool_open(self, mode: str):
        return open(self.spool_path, mode, encoding="utf-8")  # separat, damit Tests Fehler injizieren können

    def _spool_run(self) -> None:
        while True:
            try:
                self._spool_wake.wait(0.2)
                self._spool_wake.clear()
                self._spool_cycle()
                if self._stop.is_set():
                    with self._spool_q_lock:
                        empty = not self._spool_q and not self._spool_acks
                    sender = getattr(self, "_t", None)
                    if empty and (sender is None or not sender.is_alive()):
                        break
            except Exception as e:
                self._spool_fail(e)

    def _spool_enqueue_ack(self, ids: set[str]) -> None:
        """Vom Sender: Ereignisse sind endgültig erledigt (angenommen oder abgewiesen). Nur Warteschlange, kein Datei-IO."""
        if not self.spool_path or self._spool_disabled:
            return
        over = 0
        with self._spool_q_lock:
            for i in ids:
                self._spool_acks[i] = None
            over = len(self._spool_acks) - self.max_spool_queue
            if over > 0:
                for k in list(self._spool_acks)[:over]:   # älteste zuerst; die Schreibaufträge dazu sind ebenfalls die ältesten
                    del self._spool_acks[k]
                self.stats["spool_ack_dropped"] += over
        if over > 0 and not self._spool_ack_overflow_warned:
            self._spool_ack_overflow_warned = True
            self._warn(f"everydeck: spool ack queue overflow ({self.max_spool_queue}); already accepted events may be replayed after a restart")
        self._spool_wake.set()

    def _spool_cycle(self) -> None:
        """Ein Durchlauf: Schreibaufträge und Bestätigungen gemeinsam betrachten. Bestätigt und noch nicht geschrieben → gar nicht schreiben."""
        with self._spool_q_lock:
            writes = list(self._spool_q)
            self._spool_q.clear()
            acks = set(self._spool_acks)
            self._spool_acks.clear()
        if self._spool_disabled or not (writes or acks):
            return
        if writes and acks:
            skip = acks & {w["event_id"] for w in writes}
            if skip:
                writes = [w for w in writes if w["event_id"] not in skip]
                acks -= skip
        if writes:
            self._spool_write(writes)
        if acks:
            self._spool_ack(acks)   # Bestätigungen ohne Zeile (Nachlieferungs-/Lückenereignisse, verworfene Schreibaufträge) verfallen hier

    def _spool_write(self, batch: list[dict[str, Any]]) -> None:
        with self._spool_lock:
            # Bis zum Limit auffüllen (ganze Zeilen), den Rest verwerfen und den Spool schließen – unabhängig davon, wie viele
            # Ereignisse ein Zyklus zufällig einsammelt.
            lines: list[str] = []
            size = 0
            dropped = 0
            for ev in batch:
                line = _dumps(ev) + "\n"
                n = len(line.encode("utf-8"))
                if dropped or self._spool_bytes + size + n > self.max_spool_bytes:
                    dropped += 1
                    continue
                lines.append(line)
                size += n
            if lines:
                try:
                    with self._spool_open("a") as f:
                        f.writelines(lines)
                        f.flush()
                        os.fsync(f.fileno())
                    self._spool_bytes += size
                except Exception as e:
                    self._spool_fail(e)
                    return
            if dropped:
                self.stats["spool_dropped"] += dropped
                if not self._spool_disabled:
                    self._spool_disabled = True
                    self.stats["spool_disabled"] = True
                    self._warn(f"everydeck: spool full ({self.max_spool_bytes} bytes); spool disabled, delivery continues in memory only")

    def _spool_fail(self, e: Exception) -> None:
        self.stats["spool_errors"] += 1
        if not self._spool_disabled:
            self._spool_disabled = True
            self.stats["spool_disabled"] = True
            self._warn(f"everydeck: spool unavailable ({e!r}); spool disabled, delivery continues in memory only")

    def _spool_ack(self, ids: set[str]) -> None:
        """Nur Spool-Thread: bestätigte Zeilen entfernen (atomares Zurückschreiben)."""
        if not self.spool_path or self._spool_disabled:
            return
        try:
            with self._spool_lock:
                if not os.path.exists(self.spool_path):
                    return
                with self._spool_open("r") as f:
                    rows = [l for l in f if l.strip()]
                keep = [l for l in rows if _safe_id(l) not in ids]
                tmp = self.spool_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.writelines(keep)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.spool_path)  # atomar: kein halb geschriebener Spool
                self._spool_bytes = sum(len(l.encode("utf-8")) for l in keep)
        except Exception as e:
            self._spool_fail(e)

    def _spool_replay(self) -> None:
        try:
            if not self.spool_path or not os.path.exists(self.spool_path):
                return
            with self._spool_open("r") as f:
                raw = [l for l in f if l.strip()]
            rows: list[dict[str, Any]] = []
            corrupt = 0
            for l in raw:
                try:
                    ev = json.loads(l)
                    if not isinstance(ev, dict) or "event_id" not in ev or "kind" not in ev:
                        raise ValueError("shape")
                    rows.append(ev)
                except Exception:
                    corrupt += 1
            self.stats["spool_corrupt_lines"] = corrupt
            if not rows and not corrupt:
                return
            replay = rows[-self.max_buffer:]
            dropped = (len(rows) - len(replay)) + corrupt
            for ev in replay:
                self._q.append(ev)
                self.stats["replayed_from_spool"] += 1
            self._q.append({"event_id": str(uuid.uuid4()), "occurred_at": _now(), "kind": "gap", "name": "everydeck.sdk.recovered",
                            "gap": {"cause": "restart_recovered", "replayed": len(replay), "dropped": dropped}})
            with self._spool_lock:  # Spool auf die nachgelieferten, gültigen Zeilen zurückschreiben
                tmp = self.spool_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.writelines(_dumps(ev) + "\n" for ev in replay)
                os.replace(tmp, self.spool_path)
                self._spool_bytes = sum(len(_dumps(ev)) + 1 for ev in replay)
            if corrupt:
                self._warn(f"everydeck: {corrupt} corrupt spool line(s) discarded (interrupted write)")
        except Exception as e:
            self._spool_fail(e)

    def _warn(self, msg: str) -> None:
        try:
            self._warn_cb(msg)
        except Exception:
            pass


def _safe_id(line: str) -> str | None:
    try:
        return json.loads(line).get("event_id")
    except Exception:
        return None


class AfterCommit:
    """Ergebnisbeleg = Commit (P1-Befund): Signale erst nach erfolgreichem Commit senden."""

    def __init__(self) -> None:
        self._fns: list[Callable[[], Any]] = []

    def add(self, fn: Callable[[], Any]) -> None:
        self._fns.append(fn)

    def run(self) -> None:
        fns, self._fns = self._fns, []
        for fn in fns:
            try:
                fn()
            except Exception:
                pass

    def discard(self) -> None:
        self._fns = []


_ANSWER_CODE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def answer_of(exc: BaseException | None) -> dict[str, Any] | None:
    """B34b: Fehlercode und Meldung, die eine Ausnahme als eigene Attribute trägt (z. B. postgrest APIError: `code`, `message`) – für
    `error(..., response=answer_of(exc))`. Nur Attribute, kein Lesen im Text der Ausnahme; ohne beide Attribute None."""
    if exc is None:
        return None
    code = getattr(exc, "code", None); msg = getattr(exc, "message", None)
    out = {**({"code": code} if isinstance(code, str) else {}), **({"message": msg} if isinstance(msg, str) else {})}
    return out or None


def error_class_of(exc: BaseException | type | str) -> str:
    """B31: stabile Fehlerklasse aus dem Namen einer Ausnahme – Abkürzungen bleiben zusammen: APIError → api_error, HTTPException → http_exception, TypeError → type_error."""
    import re as _re
    name = exc if isinstance(exc, str) else (exc.__name__ if isinstance(exc, type) else type(exc).__name__)
    s = _re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name); s = _re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)
    s = _re.sub(r"[^a-z0-9_.-]+", "_", s.lower()).strip("_")
    s = _re.sub(r"^[^a-z]+", "", s)
    return s[:96] or "error"


def _library_roots() -> tuple[str, ...]:
    """Standardbibliothek und installierte Pakete – kein Code der App (B33)"""
    import sysconfig
    roots = {sysconfig.get_paths().get(k) for k in ("stdlib", "platstdlib", "purelib", "platlib")}
    return tuple(os.path.realpath(r) + os.sep for r in roots if r)


_LIB_ROOTS: tuple[str, ...] | None = None


def _in_app(path: str) -> bool:
    global _LIB_ROOTS
    if _LIB_ROOTS is None:
        _LIB_ROOTS = _library_roots()
    p = path.replace("\\", "/")
    if not os.path.isabs(path) or "/site-packages/" in p or "/dist-packages/" in p or path.startswith("<"):
        return False
    real = os.path.realpath(path)
    return not any(real.startswith(r) for r in _LIB_ROOTS)


def _frames_of(exc: BaseException) -> list[dict[str, Any]]:
    """Stack-Frames einer Ausnahme, innerste zuerst (wie ein JS-Stack), Datei = die letzten zwei Pfadteile; `in_app` und der volle Pfad
    (`_abs`, nur intern für die Code-Zeilen, B33)"""
    import traceback
    out: list[dict[str, Any]] = []
    for fs in reversed(traceback.extract_tb(exc.__traceback__)):
        app = _in_app(fs.filename)
        out.append({"function": fs.name or "anonymous", "file": "/".join(fs.filename.replace("\\", "/").split("/")[-2:]), **({"line": fs.lineno} if fs.lineno else {}),
                    "in_app": app, **({"_abs": fs.filename} if app else {})})
        if len(out) >= 20: break
    return out


# ── B33: Code-Zeilen und Bereinigung – dieselbe Regel wie @everydeck/sdk (TS) und everydeck (packages/contracts scrubText); die Paritätsprüfung vergleicht sie ──
CONTEXT_FRAMES = 5
CONTEXT_LINES = 5
CONTEXT_LINE_MAX = 200
_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bevd_[a-z]{3}_[0-9a-f]{40}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b"),
]
_SECRET_ASSIGN = re.compile(r"""((?:password|passwd|secret|token|api[_-]?key|service[_-]?role[_-]?key)\s*[:=]\s*["']?)(?!\[redacted\])[^\s"']{6,}""", re.I)
_BEARER = re.compile(r"\bbearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+", re.I)
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def scrub_text(text: str) -> str:
    """Geheimnisse, Bearer-Token und E-Mail-Adressen entfernen (Fehlermeldung oder Code-Zeile)"""
    out = _BEARER.sub("Bearer [redacted]", str(text))
    for rx in _SECRET_PATTERNS:
        out = rx.sub("[redacted]", out)
    out = _SECRET_ASSIGN.sub(lambda m: f"{m.group(1)}[redacted]", out)
    return _EMAIL.sub("[email]", out)


def _context_of(lines: list[str], line: int) -> dict[str, Any] | None:
    """Fundzeile und je CONTEXT_LINES davor und danach; None, wenn die Zeile nicht in der Datei liegt (nichts raten)"""
    if line < 1 or line > len(lines):
        return None
    cut = lambda x: scrub_text(x[:CONTEXT_LINE_MAX])[:CONTEXT_LINE_MAX]
    first = max(1, line - CONTEXT_LINES)
    return {"first_line": first, "pre": [cut(x) for x in lines[first - 1:line - 1]], "line": cut(lines[line - 1]), "post": [cut(x) for x in lines[line:line + CONTEXT_LINES]]}


def _opt(**kw: Any) -> dict[str, Any]:
    return {k: v for k, v in kw.items() if v is not None}
