# @everydeck/sdk: TypeScript adapters (server: Node ≥ 22 / Deno; browser)

```bash
npm install @everydeck/sdk
```

Transport contract 1.1-r0 (`event-batch.schema.json`). No dependencies; only `fetch`, `setTimeout`, `AbortController`, `crypto.randomUUID`.

- `@everydeck/sdk` (`src/index.ts`, built `dist/index.js`): `createEverydeck({ endpoint, credential, releaseKey, manifestDigest })` → `signal`, `error`, `log`, `identify`, `heartbeat`, `flush`, `close`, `stats`. Bounded buffer (500), batches ≤ 50 events / 64 KiB, retry only on 429/5xx/timeout/network (same batch id), final rejections dropped and counted, overflow reported as a `gap` event. No background thread: in an Edge Function `await everydeck.flush()` before returning the response.
- `@everydeck/sdk/browser` (`src/browser.ts`, built `dist/browser.js`): `initEverydeckBrowser({...})` → `action(name, fn, { objectType, objectRef })`, the explicit action callback `ctx.fetch` (pass it to an action-scoped request/client; preserve the app authentication session), `breadcrumb`, `setSubject`, `flush`. Captures unhandled errors/rejections and, on requests using `ctx.fetch`, non-2xx / network / timeout as `error` with `http { method, route (path only), status, duration_ms }`, plus `x-everydeck-operation-id` / `x-everydeck-attempt-id` headers for server-side correlation. Browser data is a claim; nothing here proves a business result. Statuses that are an expected answer (for example 404 = not created yet) are declared per request `ctx.fetch(url, init, { expect: [404] })` or per action `{ expectStatus: [404] }`; they are recorded as a step with `fields.expected = true`, never as an error. A thrown error is the same failure as a reported request only when it is that object or carries the failed `Response` as `cause`, `context` or `response`; it is then recorded as the step `<action>.failed` (`error_class`, `propagated_request_failure`, `request_error_class`). Every other thrown error stays an `error` with its sanitized message and frames; if a request of the same attempt failed before, it carries `fields.after_request_failure = true` as a hint, not as a cause.
- Deno / Supabase Edge Functions import the package as `npm:@everydeck/sdk@<version>` (see the examples below).


Version 0.1.1: browser actions no longer use ambient async context. Migrate `everydeck.action(name, async () => everydeck.fetch(...))` to `everydeck.action(name, async ctx => ctx.fetch(...))`; `everydeck.fetch` is unbound and `currentAction()` always returns null. Bind data-library requests explicitly; do not change a shared global client during concurrent actions. `ActionMeta` accepts `operationId` and `attemptId`; retry creates a new attempt and keeps the operation. User identity is captured at action creation.

Version 0.1.2: `ctx.fetch` takes an optional third argument `{ expect: number[] }`, `ActionMeta.expectStatus` declares expected statuses for a whole action, and an attempt reports at most one error (see above). Without a declaration every non-2xx inside an action is still a failed request.

Version 0.1.3: with everydeck disabled the SDK adds no headers to app requests. `correlate: (url) => boolean` in `initEverydeckBrowser` excludes targets whose CORS policy does not allow the `x-everydeck-*` headers (captured without correlation). `ctx.expecting([404])` returns a plain `fetch` with that expectation for data clients such as supabase-js.

Version 0.1.4: an attempt id alone no longer links a thrown error to an earlier failed request (0.1.2/0.1.3 downgraded any later throw to a step and lost its message and stack). Link by passing the failure on: rethrow it, or `throw new Error(message, { cause: response })`.

Outbox senders pass `eventId` (UUID) and `occurredAt` (ISO timestamp) in signal/error/log options. Preserve these across process restarts and lost acknowledgements. Invalid supplied IDs are dropped, never silently regenerated. `flush(timeout)` returns false for pending data or rejection during that call. Inspect acceptance/rejection counters before acknowledging a durable outbox; flushing is not a business-result proof. Timer, flush, close and keepalive share a sender. Buffer loss is reported even without a later app event. Hard process termination needs an external durable outbox.

## 0.1.5

- `releaseKey: 'auto'` (Node entry `@everydeck/sdk`) or `resolveReleaseKey()`: `EVERYDECK_RELEASE_KEY` (unless `auto`) → deployment commit from `GITHUB_SHA`/`VERCEL_GIT_COMMIT_SHA`/`RENDER_GIT_COMMIT`/`CF_PAGES_COMMIT_SHA`/`COMMIT_REF`/`SOURCE_VERSION`/`CI_COMMIT_SHA` as `git:<sha12>` → local git `git:<sha12>` or `git:<sha12>+dirty.<hash8>` (hash over `git diff HEAD` and non-ignored new files) → `unknown`. Same rule in the Python SDK (`release_key="auto"`, `resolve_release_key()`) and `everydeck-agent version`. Deno/Edge (`core.js`) has no git: pass the deployment commit explicitly.
- `probeId` (option of `createEverydeck`/`initEverydeckBrowser`): marks every batch of that client as part of a setup probe run. Only for verification scripts, never in the app's own client.

## 0.1.6

- Transport like Sentry/PostHog: batches are sent gzip-compressed wherever the runtime has `CompressionStream` (Node ≥ 18, Deno, modern browsers; `compress: false` turns it off), `Retry-After` on 429/503 is honoured (no attempt before it passes, not even from `flush()`), retries back off with full jitter (uniform in `[0, min(maxBackoffMs, 500 ms · 2^n)]`). `stats` gained `batches_compressed`, `bytes_raw`, `bytes_sent`, `retry_after_waits`. Helpers `fullJitterMs`, `parseRetryAfter`, `gzipText` are exported. The Python SDK (0.1.1) behaves the same.

## 0.1.7

- Signed bridge calls, like Stripe: everydeck signs every call to a read or app bridge (`X-Everydeck-Timestamp`, `X-Everydeck-Request-Id`, `X-Everydeck-Signature: v1=…[,v1=…]`; HMAC-SHA256 over method, path from `/everydeck/` with query, timestamp, request id and the SHA-256 of the body). `verifyEverydeckRequest({ method, url, headers, body }, { keys })` is the one line for the app's door (Web Crypto; Node, Deno, browsers): rejects calls older than 5 minutes and repeated request ids (`memorySeen` per process, `seen` for several instances). `createReadBridge` verifies by itself (`signatures: "required"` by default, `"optional"` only for everydeck instances that do not sign calls yet, `"off"`), reports `signed: true`. Key rotation: register the new key with everydeck, then switch the app; everydeck signs with both keys for 24 hours. `signEverydeckRequest` produces the same headers for the app's own tests. The Python SDK (0.1.2) behaves the same (`everydeck.verify`).

Version 0.1.8: every failed request to `captureHosts` (default: the page's own host) is reported without an action (network errors; 4xx, with 401 only while `setSubject` names a person; 5xx) as `page.request_failed` with the page (`trail`), the route pattern and the status, never with contents; the SDK wraps `globalThis.fetch` once for that (`captureBackground: false` switches it off, `uninstall()` removes the wrapper). `everydeck.fetch` captures the same way again; an update never switches capture off silently. Requests inside an action are reported by `ctx.fetch` exactly as before (no double report); everydeck's own sending is never captured. The generic read bridge serves `GET /everydeck/read/messages/{type}/{ref}` from `scope.conversations` when you pass `match: pgMatch(client, { schema })`.

## 0.3.0

- The read bridge is a ready-made route: `everydeckReadBridge({ endpoint, key, db })` from `@everydeck/sdk/read-bridge` (no `node:` module, runs in Deno / Supabase Edge Functions and Node). `db` is the connection the app already has (postgres.js, a pg `Pool`, or an object with `readOnly(fn)`); every query runs in its own read-only transaction, so the database refuses any write (SQLSTATE 25006). No read role, no views, no copied files.
- The read scope is no longer a file in the repository: the route fetches it from everydeck (`GET <endpoint>/v1/read-scope` with the bridge key) and uses it only when everydeck's signature (`EVERYDECK-SCOPE-V1`, HMAC-SHA256 with the bridge key) is valid; otherwise it reads nothing and answers 503.
- The rights it reports are checked: the role of the connection, `superuser`, `bypass_rls` (the role skips the app's row-level security and sees every row) and `read_only_transaction`.
- Supabase Edge Function (`supabase/functions/everydeck-read-bridge/index.ts`), environment `EVERYDECK_URL` and `EVERYDECK_READ_BRIDGE_TOKEN`; `SUPABASE_DB_URL` is provided by Supabase. The function keeps its JWT check: everydeck sends the app's public key (registered as `gateway_key`) as `apikey`:

```ts
import postgres from 'npm:postgres@3.4.5';
import { everydeckReadBridge } from 'npm:@everydeck/sdk@0.3.0/read-bridge';
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2, idle_timeout: 20 });
Deno.serve(everydeckReadBridge({ endpoint: Deno.env.get('EVERYDECK_URL') ?? '', key: Deno.env.get('EVERYDECK_READ_BRIDGE_TOKEN') ?? '', db: sql, prefix: '/everydeck-read-bridge' }).fetch);
```

## 0.4.1

- Texts and comments name the app map (`everydeck/app-map.json`), the file of facts everydeck reads about the app. No change in behaviour.

## 0.4.0

- **Outbox from the package** (`@everydeck/sdk/outbox`): `relayOnce`, `createRelayHandler` for the scheduled Supabase function, and `npx everydeck-outbox-relay` for plain PostgreSQL. Migration, trigger template, schedule and README ship under `node_modules/@everydeck/sdk/outbox/`; nothing is downloaded.
- **`supabaseDbUrl()`** (`/outbox` and `/read-bridge`): `SUPABASE_DB_URL`, and in the local stack (`supabase start`) the name `db.supabase.internal` instead of the container name `supabase_db_<project>`, which Deno's resolver refuses. Both Supabase functions use `postgres(supabaseDbUrl(), …)`, so the bridge and the relay run in the local stack itself, never as a process of an agent session.
- **Browser writes as runs** (`initEverydeckBrowser({ …, writes: [{ flow, table, kind }] })`, the flows of the app map whose `result.write` is a table): a request to Supabase's `/rest/v1/<table>` with that kind (POST = insert, POST with `Prefer: resolution=…` or PUT = upsert, PATCH = update, DELETE = delete) becomes one run of the flow without an action: `<flow>.started` when it is sent, `<flow>.finished` on 2xx, `<flow>.request_failed` with status, PostgREST code and message otherwise (never the request body). The request carries `x-everydeck-operation-id` and `x-everydeck-platform`; the outbox trigger takes both from PostgREST's request headers, so start, result and failure are one run with its platform. Initialize the SDK in its own module imported **first** in the app's entry: supabase-js and similar clients keep the `fetch` they find when they are created.
