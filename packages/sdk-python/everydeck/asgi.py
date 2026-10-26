"""Server errors without a hand-written signal for ASGI apps (FastAPI, Starlette), like Sentry's FastApiIntegration/StarletteIntegration.

One line after creating the app:

    app.add_middleware(EverydeckMiddleware, everydeck=everydeck)

Captured: an unhandled exception while answering a request (with frames and code lines; the exception is re-raised, the app answers as before)
and every answer with status 500 to 599 (`http_<status>`, also from `HTTPException(status_code=5xx)`; Sentry's `failed_request_status_codes`
default is the same range). 4xx is the app's answer, not a server error. One event per request: `server.request_failed`.
Sent: method, the route as a pattern (`/orders/:order_id` from `/orders/{order_id}`, never the address with ids), status, duration, error class,
the message scrubbed with `scrub_text`, the frames, and the run ids of a browser action (`x-everydeck-operation-id`, `-attempt-id`, `-session-id`).
Never a body, a query, a cookie or any other header. Pure ASGI (no Starlette import), so it works with any ASGI framework.
"""
from __future__ import annotations

import re
import time
from typing import Any, Awaitable, Callable

from . import Everydeck, error_class_of, scrub_clip

__all__ = ["EverydeckMiddleware", "report_server_failure", "route_pattern"]

_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_ID_SEGMENT = re.compile(r"^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z0-9_-]{20,})$", re.I)


def route_pattern(route: str) -> str:
    """Route of the framework as a pattern: `{order_id}` / `{path:path}` → `:order_id` / `:path`; query dropped."""
    p = re.sub(r"[?#].*$", "", str(route))
    segs = [re.sub(r"^\{([^}:]+)(?::[^}]*)?\}$", r":\1", s) for s in p.split("/") if s]
    return ("/" + "/".join(segs))[:240]


def _path_route(path: str) -> str:
    """A concrete address without a pattern: only the first segment (`/orders/*`), an identifier as `:id`."""
    segs = [s for s in re.sub(r"[?#].*$", "", path).split("/") if s]
    if not segs:
        return "/"
    first = ":id" if _ID_SEGMENT.match(segs[0]) else segs[0][:80]
    return f"/{first}{'/*' if len(segs) > 1 else ''}"


def _route_of(scope: dict[str, Any]) -> tuple[str, bool]:
    """The route and whether it is the framework's pattern (`True`) or cut from the address (`False`)."""
    route = scope.get("route")
    path = getattr(route, "path", None) or getattr(route, "path_format", None)
    if isinstance(path, str) and path.startswith("/"):
        return route_pattern(path), True
    return _path_route(str(scope.get("path") or "/")), False


def _header(scope: dict[str, Any], name: str) -> str | None:
    want = name.encode()
    for k, v in scope.get("headers") or []:
        if k.lower() == want:
            s = v.decode("latin-1")
            return s if _ID.match(s) else None
    return None


def report_server_failure(everydeck: Everydeck, scope: dict[str, Any], status: int, duration_ms: float, exc: BaseException | None = None) -> None:
    """One failed request → one error event (never raises)."""
    try:
        method = str(scope.get("method") or "GET").upper()
        route, pattern = _route_of(scope)
        http = {"method": method, "route": route, "status": int(status), "duration_ms": max(0, min(86_400_000, round(duration_ms))), **({"pattern": True} if pattern else {})} if method in _METHODS else None
        message = scrub_clip(str(exc), 1024) if exc is not None else f"HTTP {status} at {method} {route}"
        everydeck.error("server.request_failed", error_class_of(exc) if exc is not None else f"http_{int(status)}", message=message or None, http=http, exc=exc,
                        operation_id=_header(scope, "x-everydeck-operation-id"), attempt_id=_header(scope, "x-everydeck-attempt-id"),
                        session_id=_header(scope, "x-everydeck-session-id"))
    except Exception:  # reporting never breaks the app
        pass


class EverydeckMiddleware:
    """ASGI middleware: `app.add_middleware(EverydeckMiddleware, everydeck=everydeck)`."""

    def __init__(self, app: Callable[..., Awaitable[None]], everydeck: Everydeck) -> None:
        self.app = app
        self.everydeck = everydeck

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Awaitable[Any]], send: Callable[..., Awaitable[None]]) -> None:
        if scope.get("type") != "http" or not self.everydeck.enabled:
            await self.app(scope, receive, send)
            return
        started = time.monotonic()
        status: list[int] = []

        async def send_and_note(message: dict[str, Any]) -> None:
            if message.get("type") == "http.response.start":
                status.append(int(message.get("status") or 0))
            await send(message)

        try:
            await self.app(scope, receive, send_and_note)
        except Exception as exc:
            code = getattr(exc, "status_code", None)
            final = code if isinstance(code, int) and 100 <= code <= 599 else 500
            if 500 <= final <= 599:
                report_server_failure(self.everydeck, scope, final, (time.monotonic() - started) * 1000, exc)
            raise
        if status and 500 <= status[0] <= 599:
            report_server_failure(self.everydeck, scope, status[0], (time.monotonic() - started) * 1000)
