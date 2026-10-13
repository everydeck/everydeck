"""everydeck Python SDK (transport contract 1.0-r0).

Guarantees:
- `signal()/error()/log()` never block and never raise: O(1) enqueue into a bounded in-memory buffer. No file or network IO in the caller.
- A sender thread transmits batches (max. 50 events, 64 KiB). Three separate outcomes per batch:
  accepted (202) · retry (429, 5xx, timeout, network) · finally rejected (400/401/403/409/413/422).
  Rejected batches never count as sent; 401/403 pause the sender (auth_pause_seconds) and report a warning.
- Batches are sent gzip-compressed (`compress=False` turns it off), `Retry-After` on 429/503 is honored,
  retries use full jitter (`full_jitter`); `stats`: batches_compressed, bytes_raw, bytes_sent, retry_after_waits, as in the TypeScript SDK.
- `everydeck.verify.verify_everydeck_request` checks everydeck's signature at bridges (5-minute window, request_id used once); `ReadBridge` checks it itself (`signatures="required"`).
- `error(..., exc=e)` sends the code lines for up to 5 frames in the app's code (the error line and 5 before and after, at most 200 characters each, scrubbed like error messages); read in the sender thread, never in the call; `Everydeck(..., source_context=False)` turns it off. `error.context_status` says whether lines are included or why not.
- `error(..., response={code, message})` as in the TS SDK (code only as an identifier, message scrubbed, 300 characters); `answer_of(exc)` reads both from attributes of the exception (e.g. postgrest `APIError.code`/`.message`), never from its text.
- `signal`, `error` and `log` take `object_type`/`object_ref` like the TS SDK (`objectType`/`objectRef`).
- `Everydeck.error(..., exc=e)` sends the exception's stack frames (`error.frames`, innermost first), or ready-made `frames=[…]`; `ReadBridge(match=psycopg_match(conn))` delivers the messages of one conversation on demand (`GET /everydeck/read/messages/{type}/{ref}`).
- The sender thread never ends silently: every exception is counted, reported, and the loop continues.
- Buffer overflow is reported as a `gap` event (buffer_overflow): a *detectable* data gap.
- An optional spool (JSONL, bounded size) runs in its own thread, which is the only one touching the file: writes and
  acknowledgements (accepted/rejected events) arrive through two bounded in-memory queues (`max_spool_queue`) and are evaluated
  together in the spool thread; an acknowledgement that arrives before the write prevents the write instead of leaving an orphan
  behind. Neither caller nor sender holds a lock during file IO. Errors (full, not writable) are counted and
  reported but affect neither customer requests nor the sender. On start, intact spool lines are replayed (`gap`
  restart_recovered); corrupt lines (interrupted write) are counted and discarded. Without a spool a SIGKILL stays invisible.
  If the queues overflow (spool thread stuck on a slow disk), the oldest entries are discarded and counted
  (`spool_queue_dropped`, `spool_ack_dropped`); a discarded acknowledgement can at most cause already accepted events to be
  delivered again after a restart (everydeck deduplicates by event_id), never a loss.
- Heartbeats: with `heartbeat_interval` the sender thread sends a signal `everydeck.sdk.heartbeat` every n seconds
  (operation_id `everydeck.sdk:<instance_id>`, fields instance_id/interval_seconds/pid). Missing heartbeats are a
  monitoring gap for everydeck, not a proven outage of the app.
- The SDK knows no everydeck database and makes no engine verdicts.
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
# origin of every event: a server key always reports the platform `server`
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
    """Automatic release key: same rule as @everydeck/sdk resolveReleaseKey and everydeck-agent version.

    EVERYDECK_RELEASE_KEY (except "auto") > commit from CI/hosting (git:<sha12>) > local Git (git:<sha12>[+dirty.<hash8>]) > "unknown".
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
    """Backoff with full jitter: uniform in [0, min(cap, 0.5 s · 2^n)], as in the TypeScript SDK."""
    ceiling = min(cap, 0.5 * 2 ** max(0, min(6, failures)))
    return rnd() * ceiling


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """`Retry-After` as seconds or HTTP date → seconds, capped at one hour; None when missing or unreadable."""
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
        # setup check run (verification scripts only)
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
        # send batches gzip-compressed (on by default); everydeck accepts Content-Encoding: gzip
        self.compress = compress
        # code lines for frames in the app's code (on by default); the sender thread reads the files, cached per path
        self.source_context = source_context
        self._source_cache: dict[str, list[str] | None] = {}
        self._warn_cb = on_warning or (lambda m: _log.warning(m))
        self.enabled = enabled
        # if address or key is missing (e.g. after an update with new variable names), the SDK turns itself off, loudly, never silently
        if self.enabled and (not self.endpoint or not self.credential or not self.manifest_digest):
            self.enabled = False
            missing = "no endpoint" if not self.endpoint else "no key" if not self.credential else "no manifest digest"
            self._warn_cb(f"everydeck: disabled: {missing}; nothing is sent to everydeck until the app passes endpoint, key and manifest digest")
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
        self._spool_q: deque[dict[str, Any]] = deque()          # pending writes (bounded)
        self._spool_acks: dict[str, None] = {}                  # pending acknowledgements, ordered (bounded)
        self._spool_q_lock = threading.Lock()   # queues only (caller, sender, spool thread), never held during file IO
        self._spool_lock = threading.Lock()     # file; spool thread only (and recovery in the constructor)
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
            "batches_compressed": 0, "bytes_raw": 0, "bytes_sent": 0, "retry_after_waits": 0,
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

    # ---------------- API (never blocking, never raising) ----------------
    def signal(self, name: str, operation_id: str, *, attempt_id: str | None = None, subject_ref: str | None = None,
               account_ref: str | None = None, fields: dict[str, Any] | None = None, request_id: str | None = None,
               business_key: str | None = None, object_type: str | None = None, object_ref: str | None = None) -> str | None:
        """`object_type`/`object_ref` name the object of the outcome (like `objectType`/`objectRef` in the TS SDK)."""
        return self._enq({"kind": "signal", "name": name, "operation_id": str(operation_id),
                          **_opt(attempt_id=attempt_id, subject_ref=subject_ref, account_ref=account_ref, fields=fields,
                                 request_id=request_id, business_key=business_key, object_type=object_type, object_ref=object_ref)})

    def heartbeat(self, interval_seconds: float, *, job: str | None = None) -> str | None:
        """Heartbeat on demand. With `job` (1.9-r0, `jobs[].id` in the manifest): this job has run; send it at the end of every successful run;
        everydeck reports a job that stays silent for two intervals. Without `job`: this process instance is running (like `heartbeat_interval`)."""
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
        """With `exc` (the caught exception) the SDK builds the stack frames itself: innermost first, at most 20,
        file as the last two path parts as in the browser SDK; `frames` passes them ready-made ({function, file?, line?})."""
        err: dict[str, Any] = {"class": error_class}
        if message:
            err["message"] = str(message)[:1024]
        # 1.4-r0: error code and message from the response the app received, as in the TS SDK (code only as an identifier, message scrubbed, 300 characters)
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
            keep_abs = frames is None and self.source_context   # the full path only lives until the sender thread (code lines); it is never sent
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
        """Identity source (manifest 1.1 `people`): approved master data of a person. everydeck stores only the fields named in the approved
        manifest; all others are discarded and counted. No operation, no rule. Only meaningful on the server side."""
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
        """Waits until the buffer is empty. False when the budget runs out (e.g. everydeck not reachable)."""
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
            self._paused_until = 0.0  # an explicit flush lifts the auth pause (one attempt)
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
            st.join(max(0.0, deadline - time.monotonic()))  # still apply pending spool acknowledgements (bounded)
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
                # The order is intentional: write job first, then send buffer. The sender can only see an event after this
                # step; the spool thread therefore never sees an acknowledgement without its write job.
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
        except Exception as e:  # a customer request must never fail
            self._warn(f"everydeck: enqueue failed: {e!r}")
            return None

    # ---------------- Sender thread ----------------
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
            except Exception as e:  # the thread never ends silently
                self.stats["sender_errors"] += 1
                self._warn(f"everydeck: sender error (continuing): {e!r}")
                time.sleep(full_jitter(self._consecutive_failures, self.max_send_backoff))

    def _maybe_heartbeat(self) -> None:
        """Heartbeat in the sender thread; goes through the same buffer as all events (no special path, no guarantee)."""
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
        """Code lines for at most 5 frames in the app's code; the event stays below EVENT_MAX_BYTES (what does not fit: partial).
        The full path (`_abs`) never leaves the SDK. Works on a copy; the original in the buffer and in the spool stays unchanged."""
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
            items = [self._with_source_context(it) for it in items]   # file IO outside the lock, on copies (the spool thread reads the originals)
            try:
                outcome, detail = self._post(items)
            except Exception as e:
                outcome, detail = "retry", {"error": repr(e)[:200]}
                self.stats["sender_errors"] += 1
                self._warn(f"everydeck: sender error (continuing): {e!r}")
            ack: set[str] | None = None
            warn: str | None = None
            stop_after = False
            with self._lock:   # counters and state only; file IO and callbacks run outside this lock
                if outcome == "accepted":
                    self.stats["accepted"] += len(items)
                    self.stats["batches_accepted"] += 1
                    self._consecutive_failures = 0
                    ack = {i["event_id"] for i in items}
                elif outcome == "rejected":
                    self.stats["batches_rejected"] += 1
                    self.stats["dropped_rejected"] += len(items)
                    self.stats["last_rejection"] = detail
                    ack = {i["event_id"] for i in items}  # no retry, not even after a restart
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
                    # Retry-After from everydeck (429 budget/quota, 503 protection) is honored, otherwise backoff with full jitter
                    retry_after = detail.get("retry_after") if isinstance(detail, dict) else None
                    if retry_after is not None:
                        self.stats["retry_after_waits"] += 1
                        self._paused_until = max(self._paused_until, time.monotonic() + float(retry_after))
                    else:
                        self._paused_until = time.monotonic() + full_jitter(self._consecutive_failures, self.max_send_backoff)
                    stop_after = True
            if ack:
                self._spool_enqueue_ack(ack)   # before inflight ends: flush() only sees "empty" afterwards, close() waits for the spool
            with self._lock:
                self._inflight = False
            if warn:
                self._warn(warn)
            if stop_after:
                return

    def _post(self, items: list[dict[str, Any]]) -> tuple[Outcome, Any]:
        """Exactly one delivery attempt. The sender controls retries (backoff up to max_send_backoff)."""
        body = _dumps({"schema_version": SCHEMA_VERSION, "batch_id": str(uuid.uuid4()), "release_key": self.release_key,
                       "manifest_digest": self.manifest_digest, **({"probe_id": self.probe_id} if self.probe_id else {}), "events": items}).encode()
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + self.credential}
        self.stats["bytes_raw"] += len(body)
        if self.compress:
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

    # ---------------- Spool thread (durable record) ----------------
    def _spool_open(self, mode: str):
        return open(self.spool_path, mode, encoding="utf-8")  # separate so tests can inject errors

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
        """From the sender: events are finally done (accepted or rejected). Queue only, no file IO."""
        if not self.spool_path or self._spool_disabled:
            return
        over = 0
        with self._spool_q_lock:
            for i in ids:
                self._spool_acks[i] = None
            over = len(self._spool_acks) - self.max_spool_queue
            if over > 0:
                for k in list(self._spool_acks)[:over]:   # oldest first; their write jobs are the oldest as well
                    del self._spool_acks[k]
                self.stats["spool_ack_dropped"] += over
        if over > 0 and not self._spool_ack_overflow_warned:
            self._spool_ack_overflow_warned = True
            self._warn(f"everydeck: spool ack queue overflow ({self.max_spool_queue}); already accepted events may be replayed after a restart")
        self._spool_wake.set()

    def _spool_cycle(self) -> None:
        """One pass: look at write jobs and acknowledgements together. Acknowledged and not yet written → do not write at all."""
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
            self._spool_ack(acks)   # acknowledgements without a line (replay/gap events, discarded write jobs) expire here

    def _spool_write(self, batch: list[dict[str, Any]]) -> None:
        with self._spool_lock:
            # Fill up to the limit (whole lines), discard the rest and close the spool, regardless of how many
            # events a cycle happens to collect.
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
        """Spool thread only: remove acknowledged lines (atomic rewrite)."""
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
                os.replace(tmp, self.spool_path)  # atomic: no half-written spool
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
            with self._spool_lock:  # rewrite the spool to the replayed, valid lines
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
    """Outcome evidence = commit: send signals only after a successful commit."""

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
    """Error code and message an exception carries as its own attributes (e.g. postgrest APIError: `code`, `message`), for
    `error(..., response=answer_of(exc))`. Attributes only, no parsing of the exception text; None without both attributes."""
    if exc is None:
        return None
    code = getattr(exc, "code", None); msg = getattr(exc, "message", None)
    out = {**({"code": code} if isinstance(code, str) else {}), **({"message": msg} if isinstance(msg, str) else {})}
    return out or None


def error_class_of(exc: BaseException | type | str) -> str:
    """Stable error class from an exception name; acronyms stay together: APIError → api_error, HTTPException → http_exception, TypeError → type_error."""
    import re as _re
    name = exc if isinstance(exc, str) else (exc.__name__ if isinstance(exc, type) else type(exc).__name__)
    s = _re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name); s = _re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)
    s = _re.sub(r"[^a-z0-9_.-]+", "_", s.lower()).strip("_")
    s = _re.sub(r"^[^a-z]+", "", s)
    return s[:96] or "error"


def _library_roots() -> tuple[str, ...]:
    """Standard library and installed packages: not the app's code"""
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
    """Stack frames of an exception, innermost first (like a JS stack), file = the last two path parts; `in_app` and the full path
    (`_abs`, internal only, for the code lines)"""
    import traceback
    out: list[dict[str, Any]] = []
    for fs in reversed(traceback.extract_tb(exc.__traceback__)):
        app = _in_app(fs.filename)
        out.append({"function": fs.name or "anonymous", "file": "/".join(fs.filename.replace("\\", "/").split("/")[-2:]), **({"line": fs.lineno} if fs.lineno else {}),
                    "in_app": app, **({"_abs": fs.filename} if app else {})})
        if len(out) >= 20: break
    return out


# ── Code lines and scrubbing: the same rule as @everydeck/sdk (TS) and everydeck's scrubText; a parity check compares them ──
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
    """Remove secrets, bearer tokens and e-mail addresses (error message or code line)"""
    out = _BEARER.sub("Bearer [redacted]", str(text))
    for rx in _SECRET_PATTERNS:
        out = rx.sub("[redacted]", out)
    out = _SECRET_ASSIGN.sub(lambda m: f"{m.group(1)}[redacted]", out)
    return _EMAIL.sub("[email]", out)


def _context_of(lines: list[str], line: int) -> dict[str, Any] | None:
    """The error line and CONTEXT_LINES before and after; None when the line is not in the file (no guessing)"""
    if line < 1 or line > len(lines):
        return None
    cut = lambda x: scrub_text(x[:CONTEXT_LINE_MAX])[:CONTEXT_LINE_MAX]
    first = max(1, line - CONTEXT_LINES)
    return {"first_line": first, "pre": [cut(x) for x in lines[first - 1:line - 1]], "line": cut(lines[line - 1]), "post": [cut(x) for x in lines[line:line + CONTEXT_LINES]]}


def _opt(**kw: Any) -> dict[str, Any]:
    return {k: v for k, v in kw.items() if v is not None}
