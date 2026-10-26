"""AI calls (server only), in their own module. A wrapper around the app's own AI client, like PostHog's `posthog.ai.openai` and Langfuse's `langfuse.openai`:
`everydeck.wrap_openai(client)` and `everydeck.wrap_anthropic(client)` return the same client (also async clients); each call of `chat.completions.create`,
`responses.create`, `embeddings.create`, `images.generate`, `images.edit`, `audio.transcriptions.create`, `audio.translations.create`, `audio.speech.create`
(OpenAI) or `messages.create` (Anthropic), with or without `stream`, sends one event `everydeck.ai.generation`
(PostHog `$ai_generation`) with field names after the OpenTelemetry GenAI conventions: provider, operation, model asked for and model that answered,
input tokens (counting cached ones), output tokens, cached tokens read and written, duration in seconds, the error type of a failed call, the flow of the
app. Never the prompt, the answer, a system text or a key: the wrapper does not read them. The person, the organization and the flow come from
`wrap_openai(client, flow=…, subject_ref=…, account_ref=…)` or from `with everydeck.ai_context(…):`; all calls inside one `ai_context` belong to one run.
`everydeck.ai_call(…)` sends a call the app measured itself. everydeck prices the tokens with its price list; the app never sends money. Same behaviour as
packages/sdk-ts/src/ai.ts."""
from __future__ import annotations

import contextlib
import contextvars
import inspect
import logging
import re
import time
import uuid
from typing import Any, Iterator

AI_EVENT = "everydeck.ai.generation"
_FLOW = re.compile(r"[a-z][a-z0-9_.-]{0,63}")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}")
_PROVIDER = re.compile(r"[a-z][a-z0-9_.-]{0,39}")
_ERROR = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
_OPERATIONS = {"chat", "text_completion", "embeddings", "generate_content", "image_generation", "audio_transcription", "audio_speech"}
_log = logging.getLogger("everydeck")
_ctx: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar("everydeck_ai_context", default=None)


def _tokens(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _g(o: Any, k: str) -> Any:
    if o is None: return None
    return o.get(k) if isinstance(o, dict) else getattr(o, k, None)


def _flow_ok(flow: Any) -> bool:
    return isinstance(flow, str) and _FLOW.fullmatch(flow) is not None


def _warn_flow(flow: Any) -> None:
    _log.warning("everydeck: AI flow must be lowercase letters, digits and _ . - (at most 64): %r (left out)", str(flow)[:80])


def error_type(e: BaseException) -> str:
    """the error type for OpenTelemetry `error.type`: the class of the error (RateLimitError), else its HTTP status, never its message"""
    name = type(e).__name__
    if name not in ("Exception", "BaseException") and _ERROR.fullmatch(name): return name
    status = getattr(e, "status_code", None) or getattr(e, "status", None)
    return str(status) if isinstance(status, int) else "Error"


def ai_call(ed: Any, *, provider: str, request_model: str, operation: str = "chat", response_model: str | None = None, input_tokens: int | None = None,
            output_tokens: int | None = None, cache_read_tokens: int | None = None, cache_write_tokens: int | None = None, duration_seconds: float | None = None,
            error_type: str | None = None, flow: str | None = None, subject_ref: str | None = None, account_ref: str | None = None, run_id: str | None = None) -> None:
    try:
        ctx = _ctx.get() or {}
        if not isinstance(request_model, str) or not _MODEL.fullmatch(request_model):
            _log.warning("everydeck: AI call not sent: model %r is not a model name", str(request_model)[:80]); return
        if flow is not None and not _flow_ok(flow): _warn_flow(flow)
        f = flow if flow is not None else ctx.get("flow")
        fields: dict[str, Any] = {"gen_ai.operation.name": operation if operation in _OPERATIONS else "chat", "gen_ai.provider.name": provider if _PROVIDER.fullmatch(provider or "") else "openai",
                                  "gen_ai.request.model": request_model}
        if isinstance(response_model, str) and _MODEL.fullmatch(response_model): fields["gen_ai.response.model"] = response_model
        for k, v, skip_zero in (("gen_ai.usage.input_tokens", input_tokens, False), ("gen_ai.usage.output_tokens", output_tokens, False),
                                ("gen_ai.usage.cache_read.input_tokens", cache_read_tokens, True), ("gen_ai.usage.cache_write.input_tokens", cache_write_tokens, True)):
            t = _tokens(v)
            if t is not None and not (skip_zero and t == 0): fields[k] = t
        if isinstance(duration_seconds, (int, float)) and not isinstance(duration_seconds, bool) and duration_seconds >= 0:
            fields["gen_ai.client.inference.duration"] = round(float(duration_seconds), 3)
        if error_type: fields["error.type"] = error_type if _ERROR.fullmatch(error_type) else "Error"
        if _flow_ok(f): fields["everydeck.flow"] = f
        run = run_id or ctx.get("run_id") or str(uuid.uuid4())
        ed.signal(AI_EVENT, f"everydeck.sdk:ai:{run}", subject_ref=subject_ref or ctx.get("subject_ref"), account_ref=account_ref or ctx.get("account_ref"), fields=fields)
    except Exception:  # measuring never breaks the app
        pass


@contextlib.contextmanager
def ai_context(*, flow: str | None = None, subject_ref: str | None = None, account_ref: str | None = None, run_id: str | None = None) -> Iterator[str]:
    """All AI calls inside the block belong to one run of a flow, of a person and an organization. Yields the run id."""
    if flow is not None and not _flow_ok(flow): _warn_flow(flow)
    nxt = {**(_ctx.get() or {}), **({"flow": flow} if _flow_ok(flow) else {}), **({"subject_ref": subject_ref} if subject_ref else {}), **({"account_ref": account_ref} if account_ref else {}),
           "run_id": run_id or str(uuid.uuid4())}
    token = _ctx.set(nxt)
    try:
        yield nxt["run_id"]
    finally:
        _ctx.reset(token)


# ── the wrapper ──
_METHODS = {
    "openai": {"chat.completions.create": "chat", "chat.completions.parse": "chat", "beta.chat.completions.parse": "chat", "responses.create": "chat", "responses.parse": "chat",
               "embeddings.create": "embeddings", "completions.create": "text_completion",
               # the image and audio calls everydeck-check finds (scaffold); everydeck-check footprint keeps the same list (WRAPPED in footprint.py)
               "images.generate": "image_generation", "images.edit": "image_generation", "audio.transcriptions.create": "audio_transcription",
               "audio.translations.create": "audio_transcription", "audio.speech.create": "audio_speech"},
    "anthropic": {"messages.create": "chat", "messages.parse": "chat", "beta.messages.create": "chat", "beta.messages.parse": "chat"},
}
_PREFIXES = {k: {".".join(m.split(".")[:i]) for m in v for i in range(1, len(m.split(".")))} for k, v in _METHODS.items()}
_HOSTS = [(r"openrouter\.ai", "openrouter"), (r"groq\.com", "groq"), (r"together\.(ai|xyz)", "together"), (r"\.openai\.azure\.com|azure", "azure.ai.openai"), (r"deepseek\.com", "deepseek"),
          (r"mistral\.ai", "mistral_ai"), (r"x\.ai", "x_ai"), (r"generativelanguage\.googleapis", "gcp.gemini")]


def _provider_of(kind: str, client: Any) -> str:
    if kind == "anthropic": return "anthropic"
    base = str(getattr(client, "base_url", "") or "")
    for pat, p in _HOSTS:
        if re.search(pat, base): return p
    return "openai"


def _usage_of(kind: str, u: Any) -> dict[str, Any]:
    """tokens as OpenTelemetry counts them: input includes cached tokens (Anthropic reports them apart, OpenAI inside)"""
    if u is None: return {}
    if kind == "anthropic":
        inp = _tokens(_g(u, "input_tokens")); read = _tokens(_g(u, "cache_read_input_tokens")) or 0; write = _tokens(_g(u, "cache_creation_input_tokens")) or 0
        out: dict[str, Any] = {"cache_read_tokens": read, "cache_write_tokens": write}
        if inp is not None: out["input_tokens"] = inp + read + write
        if _tokens(_g(u, "output_tokens")) is not None: out["output_tokens"] = _tokens(_g(u, "output_tokens"))
        return out
    if _g(u, "prompt_tokens") is not None:
        out = {"input_tokens": _tokens(_g(u, "prompt_tokens")), "cache_read_tokens": _tokens(_g(_g(u, "prompt_tokens_details"), "cached_tokens")) or 0}
        if _g(u, "completion_tokens") is not None: out["output_tokens"] = _tokens(_g(u, "completion_tokens"))
        return out
    return {"input_tokens": _tokens(_g(u, "input_tokens")), "output_tokens": _tokens(_g(u, "output_tokens")), "cache_read_tokens": _tokens(_g(_g(u, "input_tokens_details"), "cached_tokens")) or 0}


def _from_result(kind: str, r: Any) -> dict[str, Any]:
    out = _usage_of(kind, _g(r, "usage"))
    if isinstance(_g(r, "model"), str): out["response_model"] = _g(r, "model")
    return out


def _from_event(kind: str, ev: Any, acc: dict[str, Any]) -> None:
    """what a stream event adds: OpenAI chat (the usage chunk), Responses (response.completed), Anthropic (message_start, message_delta)"""
    t = _g(ev, "type")
    if kind == "anthropic":
        if t == "message_start":
            m = _g(ev, "message")
            if isinstance(_g(m, "model"), str): acc["response_model"] = _g(m, "model")
            acc.update(_usage_of("anthropic", _g(m, "usage")))
        elif t == "message_delta":
            u = _g(ev, "usage"); out = _tokens(_g(u, "output_tokens"))
            if out is not None: acc["output_tokens"] = out
            if u is not None and _tokens(_g(u, "input_tokens")) is not None: acc.update({k: v for k, v in _usage_of("anthropic", u).items() if k != "output_tokens"})
        return
    if isinstance(t, str) and t.startswith("response."):
        r = _g(ev, "response")
        if r is not None:
            if isinstance(_g(r, "model"), str): acc["response_model"] = _g(r, "model")
            if _g(r, "usage") is not None: acc.update(_usage_of("openai", _g(r, "usage")))
        return
    if isinstance(_g(ev, "model"), str): acc["response_model"] = _g(ev, "model")
    if _g(ev, "usage") is not None: acc.update(_usage_of("openai", _g(ev, "usage")))


def _usage_only(ev: Any) -> bool:
    ch = _g(ev, "choices")
    return _g(ev, "usage") is not None and isinstance(ch, list) and not ch


class _Stream:
    """the provider's stream, passed through chunk by chunk; at its end (or when the app stops reading) one event with the tokens"""
    def __init__(self, s: Any, kind: str, done: Any, hide: bool):
        self._s = s; self._kind = kind; self._done = done; self._hide = hide; self._acc: dict[str, Any] = {}; self._it: Any = None; self._sent = False

    def _finish(self, err: BaseException | None) -> None:
        if not self._sent: self._sent = True; self._done(self._acc, err)

    def __iter__(self):
        try:
            for ev in self._s:
                _from_event(self._kind, ev, self._acc)
                if self._hide and _usage_only(ev): continue
                yield ev
        except GeneratorExit:
            raise
        except BaseException as e:
            self._finish(e); raise
        finally:
            self._finish(None)

    def __next__(self):
        if self._it is None: self._it = self.__iter__()
        return next(self._it)

    def __enter__(self):
        if hasattr(self._s, "__enter__"): self._s.__enter__()
        return self

    def __exit__(self, *a):
        self._finish(None)
        return self._s.__exit__(*a) if hasattr(self._s, "__exit__") else None

    def __getattr__(self, k: str) -> Any:
        return getattr(self._s, k)


class _AsyncStream(_Stream):
    async def _agen(self):
        try:
            async for ev in self._s:
                _from_event(self._kind, ev, self._acc)
                if self._hide and _usage_only(ev): continue
                yield ev
        except GeneratorExit:
            raise
        except BaseException as e:
            self._finish(e); raise
        finally:
            self._finish(None)

    def __aiter__(self):
        return self._agen()

    async def __anext__(self):
        if self._it is None: self._it = self._agen()
        return await self._it.__anext__()

    async def __aenter__(self):
        if hasattr(self._s, "__aenter__"): await self._s.__aenter__()
        return self

    async def __aexit__(self, *a):
        self._finish(None)
        return await self._s.__aexit__(*a) if hasattr(self._s, "__aexit__") else None


class _View:
    """the same client: attribute access goes to the client, the measured methods are wrapped; isinstance still sees the client's class"""
    __slots__ = ("_t", "_path", "_w")

    def __init__(self, target: Any, path: tuple[str, ...], w: "_Wrapper"):
        object.__setattr__(self, "_t", target); object.__setattr__(self, "_path", path); object.__setattr__(self, "_w", w)

    @property  # type: ignore[misc]
    def __class__(self):  # noqa: D401  (isinstance(wrapped, OpenAI) stays true, like wrapt.ObjectProxy)
        return type(object.__getattribute__(self, "_t"))

    def __getattr__(self, k: str) -> Any:
        t = object.__getattribute__(self, "_t"); path = object.__getattribute__(self, "_path"); w = object.__getattribute__(self, "_w")
        v = getattr(t, k); key = ".".join(path + (k,))
        if callable(v) and key in _METHODS[w.kind]: return w.measured(v, key)
        if key in _PREFIXES[w.kind] and not callable(v): return _View(v, path + (k,), w)
        return v

    def __setattr__(self, k: str, v: Any) -> None:
        setattr(object.__getattribute__(self, "_t"), k, v)

    def __repr__(self) -> str:
        return repr(object.__getattribute__(self, "_t"))


class _Wrapper:
    def __init__(self, ed: Any, kind: str, client: Any, defaults: dict[str, Any]):
        self.ed = ed; self.kind = kind; self.defaults = defaults; self.provider = _provider_of(kind, client)

    def send(self, op: str, model: Any, started: float, u: dict[str, Any], err: BaseException | None = None) -> None:
        if not isinstance(model, str): return
        extra = {k: u.get(k) for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")} if err is None else {"error_type": error_type(err)}
        ai_call(self.ed, provider=self.provider, operation=op, request_model=model, response_model=u.get("response_model"), duration_seconds=time.perf_counter() - started, **extra, **self.defaults)

    def _prepare(self, key: str, kwargs: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        # like PostHog: a chat stream reports its tokens only with stream_options.include_usage; the chunk it adds is not passed to the app
        so = kwargs.get("stream_options"); so = so if isinstance(so, dict) else {}
        if self.kind == "openai" and key == "chat.completions.create" and kwargs.get("stream") is True and so.get("include_usage") is not True:
            return {**kwargs, "stream_options": {**so, "include_usage": True}}, True
        return kwargs, False

    def measured(self, fn: Any, key: str) -> Any:
        op = _METHODS[self.kind][key]; w = self

        def smeasured(*args: Any, **kwargs: Any) -> Any:
            model = kwargs.get("model"); started = time.perf_counter(); call, hide = w._prepare(key, kwargs); stream = kwargs.get("stream") is True
            done = lambda acc, err: w.send(op, model, started, acc, err)  # noqa: E731
            try:
                res = fn(*args, **call)
            except BaseException as e:
                w.send(op, model, started, {}, e); raise
            if inspect.isawaitable(res):   # AsyncOpenAI, AsyncAnthropic: the call returns a coroutine
                async def awaited() -> Any:
                    try:
                        r = await res
                    except BaseException as e:
                        w.send(op, model, started, {}, e); raise
                    if stream: return _AsyncStream(r, w.kind, done, hide)
                    w.send(op, model, started, _from_result(w.kind, r)); return r
                return awaited()
            if stream: return _Stream(res, w.kind, done, hide)
            w.send(op, model, started, _from_result(w.kind, res)); return res
        return smeasured

def wrap(ed: Any, kind: str, client: Any, *, flow: str | None = None, subject_ref: str | None = None, account_ref: str | None = None) -> Any:
    try:
        ok = (callable(_g(_g(_g(client, "chat"), "completions"), "create")) or callable(_g(_g(client, "responses"), "create")) or callable(_g(_g(client, "embeddings"), "create"))) \
            if kind == "openai" else callable(_g(_g(client, "messages"), "create"))
    except Exception:
        ok = False
    if not ok or isinstance(client, dict):
        _log.warning("everydeck: %s: this is not an %s client; returned unchanged and not measured", "wrap_openai" if kind == "openai" else "wrap_anthropic", "OpenAI" if kind == "openai" else "Anthropic")
        return client
    if flow is not None and not _flow_ok(flow): _warn_flow(flow)
    defaults = {**({"flow": flow} if _flow_ok(flow) else {}), **({"subject_ref": subject_ref} if subject_ref else {}), **({"account_ref": account_ref} if account_ref else {})}
    return _View(client, (), _Wrapper(ed, kind, client, defaults))
