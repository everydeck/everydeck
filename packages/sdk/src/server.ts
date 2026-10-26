/**
 * Server errors without a hand-written signal, like Sentry's framework integrations. One line per framework:
 *
 *   Express (4 and 5), after all routes and before other error middleware:   everydeckExpress(app, everydeck)
 *   Next.js ≥ 15, instrumentation.ts (App and Pages Router, server actions):  export const onRequestError = everydeckOnRequestError(everydeck)
 *   Next.js route handler that answers 5xx itself (App Router):               export const POST = everydeckRoute(everydeck, handler)
 *   Next.js API route (Pages Router):                                         export default everydeckApiRoute(everydeck, handler)
 *   Supabase / Deno Edge Function:                                            Deno.serve(everydeckServe(everydeck, handler))
 *
 * Captured: an unhandled exception while answering a request (with frames and code lines) and every answer with status 500 to 599 (as `http_<status>`).
 * Status 4xx is the app's answer, not a server error (Sentry: `shouldHandleError` status >= 500). One event per request: `server.request_failed`.
 * Sent: method, the route as a pattern (`/orders/:id`, never the address with ids), status, duration, error class, the message scrubbed like
 * `scrubText` (secrets, bearer tokens, e-mail addresses), the frames, and the run ids of a browser action (`x-everydeck-operation-id`,
 * `-attempt-id`, `-session-id`). Never a body, a query, a cookie or any other header. The app's answer stays unchanged; exceptions are rethrown.
 * Short-lived runtimes (route handler, API route, Edge Function) wait for the send on the error path only (at most 2 s).
 * Depends on core.js only, so Deno can import it.
 */
import { scrubClip, type EverydeckClient, type HttpContext } from './core.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z0-9_-]{20,})$/i;
/** Wait for the send in short-lived runtimes (error path only) */
const FLUSH_MS = 2000;

export interface ServerErrorOptions { /** the route as a pattern, when the framework does not name it (`/api/orders/[id]` or `/api/orders/:id`) */ route?: string }

/** Route of the framework as a pattern: Next.js `[id]` → `:id`, `[...slug]`/`[[...slug]]` → `*`, FastAPI `{id}` → `:id`; query dropped */
export function routePattern(route: string): string {
  const p = String(route).replace(/[?#].*$/, '');
  const segs = p.split('/').filter(Boolean).map((s) => (/^\[\[?\.\.\.[^\]]+\]\]?$/.test(s) ? '*' : s.replace(/^\[([^\]]+)\]$/, ':$1').replace(/^\{([^}:]+)(?::[^}]*)?\}$/, ':$1')));
  return `/${segs.join('/')}`.slice(0, 240);
}
/** A concrete address without a pattern: Supabase paths as the browser SDK keeps them, otherwise only the first segment (`/send-mail/*`) */
export function pathRoute(address: string): string {
  const segs = String(address).replace(/[?#].*$/, '').split('/').filter(Boolean);
  if (!segs.length) return '/';
  const [a, v] = segs;
  if (v === 'v1' && (a === 'functions' || a === 'rest' || a === 'auth')) return `/${segs.slice(0, 3).join('/')}${segs.length > 3 ? '/*' : ''}`;
  const first = ID_SEGMENT.test(segs[0]!) ? ':id' : segs[0]!.slice(0, 80);
  return `/${first}${segs.length > 1 ? '/*' : ''}`;
}
/** Error class from the exception's name, acronyms kept together like the Python SDK: TypeError → type_error, HTTPError → http_error */
export function exceptionClass(e: unknown): string {
  const name = e instanceof Error ? (e.name && e.name !== 'Error' ? e.name : e.constructor?.name ?? 'Error') : 'Error';
  const s = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '');
  return /^[a-z][a-z0-9_.-]{0,95}$/.test(s) ? s : 'error';
}
type HeaderBag = Headers | Record<string, string | string[] | undefined> | undefined | null;
function header(h: HeaderBag, name: string): string | undefined {
  if (!h) return undefined;
  const v = typeof (h as Headers).get === 'function' ? (h as Headers).get(name) : (h as Record<string, string | string[] | undefined>)[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && ID.test(s) ? s : undefined;
}
/** Status of an exception as frameworks set it (`status`, `statusCode`); otherwise 500 */
function statusOf(e: unknown): number {
  const o = e && typeof e === 'object' ? (e as { status?: unknown; statusCode?: unknown }) : {};
  const n = Number(o.status ?? o.statusCode);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 500;
}

/** One failed request → one error event (never throws) */
export function reportServerFailure(ed: EverydeckClient, r: { method?: string | null | undefined; route: string; status: number; durationMs: number; exc?: unknown; headers?: HeaderBag; /** the route is the framework's pattern (not cut from an address) */ pattern?: boolean }): void {
  try {
    const method = String(r.method ?? 'GET').toUpperCase();
    const http: HttpContext | undefined = METHODS.has(method) ? { method: method as HttpContext['method'], route: r.route.startsWith('/') ? r.route : '/', status: r.status, durationMs: r.durationMs, ...(r.pattern ? { pattern: true } : {}) } : undefined;
    const raw = r.exc instanceof Error ? r.exc.message : r.exc !== undefined ? String(r.exc) : '';
    const message = r.exc !== undefined ? scrubClip(raw, 1024) : `HTTP ${r.status} at ${method} ${r.route}`;
    const operationId = header(r.headers, 'x-everydeck-operation-id'); const attemptId = header(r.headers, 'x-everydeck-attempt-id'); const sessionId = header(r.headers, 'x-everydeck-session-id');
    ed.error('server.request_failed', r.exc !== undefined ? exceptionClass(r.exc) : `http_${r.status}`, {
      ...(message ? { message } : {}), ...(http ? { http } : {}), ...(r.exc instanceof Error ? { exc: r.exc } : {}),
      ...(operationId ? { operationId } : {}), ...(attemptId ? { attemptId } : {}), ...(sessionId ? { sessionId } : {}),
    });
  } catch { /* reporting never breaks the app */ }
}
const serverError = (s: number) => s >= 500 && s <= 599;

// ── Express ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface ExpressReq { method?: string | undefined; url?: string | undefined; originalUrl?: string | undefined; baseUrl?: string | undefined; route?: { path?: unknown } | undefined; headers?: Record<string, string | string[] | undefined> | undefined }
interface ExpressRes { statusCode: number; headersSent?: boolean; once(event: 'finish', fn: () => void): unknown }
type Next = (err?: unknown) => void;
interface ExpressApp { use(fn: (...a: never[]) => void): unknown; _router?: { stack?: unknown[] }; router?: { stack?: unknown[] } }
const FAILED = Symbol.for('everydeck.server.failed');
const expressRoute = (req: ExpressReq): string => (typeof req.route?.path === 'string' ? routePattern(`${req.baseUrl ?? ''}${req.route.path}`) : pathRoute(req.originalUrl ?? req.url ?? '/'));
const expressPattern = (req: ExpressReq): boolean => typeof req.route?.path === 'string';

/**
 * Express 4 and 5 (like Sentry `setupExpressErrorHandler(app)`): call once after all routes and before the app's own error middleware.
 * Adds an error middleware (unhandled exceptions with status >= 500, then passed on unchanged) and moves a request layer in front of the
 * routes that reports every answer with status 500 to 599 when the response is finished. Without access to the router (unknown Express version)
 * only the error middleware works, with a warning.
 */
export function everydeckExpress(app: ExpressApp, ed: EverydeckClient): void {
  let early = false;
  const onError = (err: unknown, req: ExpressReq, res: ExpressRes, next: Next) => {
    if (ed.opts.enabled && serverError(statusOf(err))) {
      if (early) (res as unknown as Record<symbol, unknown>)[FAILED] = { exc: err, route: expressRoute(req), pattern: expressPattern(req) };
      else reportServerFailure(ed, { method: req.method, route: expressRoute(req), pattern: expressPattern(req), status: statusOf(err), durationMs: 0, exc: err, headers: req.headers });
    }
    next(err);
  };
  app.use(onError as never);
  const onRequest = (req: ExpressReq, res: ExpressRes, next: Next) => {
    if (ed.opts.enabled) {
      const started = Date.now();
      res.once('finish', () => {
        if (!serverError(res.statusCode)) return;
        const f = (res as unknown as Record<symbol, { exc: unknown; route: string; pattern: boolean } | undefined>)[FAILED];
        reportServerFailure(ed, { method: req.method, route: f?.route ?? expressRoute(req), pattern: f?.pattern ?? expressPattern(req), status: res.statusCode, durationMs: Date.now() - started, ...(f ? { exc: f.exc } : {}), headers: req.headers });
      });
    }
    next();
  };
  app.use(onRequest as never);
  let stack: unknown[] | undefined; try { stack = app._router?.stack ?? app.router?.stack; } catch { stack = undefined; }
  if (Array.isArray(stack) && stack.length) { stack.unshift(stack.pop()); early = true; }
  else ed.opts.onWarning('everydeckExpress: the router of this Express version is not reachable; only unhandled exceptions are reported, not 5xx answers');
}

// ── Next.js ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface NextRequestInfo { path: string; method: string; headers: Record<string, string | string[] | undefined> }
export interface NextErrorContext { routerKind: string; routePath: string; routeType: string; renderSource?: string; revalidateReason?: string }
/**
 * Next.js ≥ 15 `onRequestError` (instrumentation.ts), like Sentry `captureRequestError`: every unhandled error of a route handler, page,
 * server action or middleware, App and Pages Router. The route is Next's `routePath` as a pattern.
 */
export function everydeckOnRequestError(ed: EverydeckClient): (err: unknown, request: NextRequestInfo, context: NextErrorContext) => Promise<void> {
  return async (err, request, context) => {
    if (!ed.opts.enabled) return;
    reportServerFailure(ed, { method: request?.method, route: context?.routePath ? routePattern(context.routePath) : pathRoute(request?.path ?? '/'), pattern: !!context?.routePath, status: statusOf(err), durationMs: 0, exc: err, headers: request?.headers });
    try { await ed.flush(FLUSH_MS); } catch { /* never break the app */ }
  };
}
/** App Router route handler (`export const GET = everydeckRoute(everydeck, handler)`): a thrown exception (rethrown) and every 5xx answer */
export function everydeckRoute<A extends unknown[]>(ed: EverydeckClient, handler: (req: Request, ...rest: A) => Response | Promise<Response>, o: ServerErrorOptions = {}): (req: Request, ...rest: A) => Promise<Response> {
  return wrapFetchHandler(ed, handler, o);
}
/** Supabase / Deno Edge Function: `Deno.serve(everydeckServe(everydeck, handler))`; the same as a route handler */
export function everydeckServe<A extends unknown[]>(ed: EverydeckClient, handler: (req: Request, ...rest: A) => Response | Promise<Response>, o: ServerErrorOptions = {}): (req: Request, ...rest: A) => Promise<Response> {
  return wrapFetchHandler(ed, handler, o);
}
function wrapFetchHandler<A extends unknown[]>(ed: EverydeckClient, handler: (req: Request, ...rest: A) => Response | Promise<Response>, o: ServerErrorOptions): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    if (!ed.opts.enabled) return handler(req, ...rest);
    const started = Date.now();
    const route = () => (o.route ? routePattern(o.route) : (() => { try { return pathRoute(new URL(req.url).pathname); } catch { return '/'; } })());
    let res: Response;
    try { res = await handler(req, ...rest); } catch (e) {
      reportServerFailure(ed, { method: req.method, route: route(), pattern: !!o.route, status: statusOf(e), durationMs: Date.now() - started, exc: e, headers: req.headers });
      try { await ed.flush(FLUSH_MS); } catch { /* never break the app */ }
      throw e;
    }
    if (res && serverError(res.status)) {
      reportServerFailure(ed, { method: req.method, route: route(), pattern: !!o.route, status: res.status, durationMs: Date.now() - started, headers: req.headers });
      try { await ed.flush(FLUSH_MS); } catch { /* never break the app */ }
    }
    return res;
  };
}
interface NodeReq { method?: string | undefined; url?: string | undefined; headers?: Record<string, string | string[] | undefined> | undefined }
interface NodeRes { statusCode: number; once(event: 'finish', fn: () => void): unknown }
/** Pages Router API route (`export default everydeckApiRoute(everydeck, handler)`): a thrown exception (rethrown) and every 5xx answer */
export function everydeckApiRoute<Q extends NodeReq, S extends NodeRes>(ed: EverydeckClient, handler: (req: Q, res: S) => unknown, o: ServerErrorOptions = {}): (req: Q, res: S) => Promise<void> {
  return async (req, res) => {
    if (!ed.opts.enabled) { await handler(req, res); return; }
    const started = Date.now(); let thrown = false;
    const route = () => (o.route ? routePattern(o.route) : pathRoute(req.url ?? '/'));
    res.once('finish', () => { if (!thrown && serverError(res.statusCode)) reportServerFailure(ed, { method: req.method, route: route(), pattern: !!o.route, status: res.statusCode, durationMs: Date.now() - started, headers: req.headers }); });
    try { await handler(req, res); } catch (e) {
      thrown = true;
      reportServerFailure(ed, { method: req.method, route: route(), pattern: !!o.route, status: statusOf(e), durationMs: Date.now() - started, exc: e, headers: req.headers });
      try { await ed.flush(FLUSH_MS); } catch { /* never break the app */ }
      throw e;
    }
  };
}
