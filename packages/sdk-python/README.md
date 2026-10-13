# everydeck (Python SDK)

The Python server SDK of [everydeck](https://everydeck.ai): it reports the signals, errors and logs of your app's flows to everydeck.

```bash
pip install everydeck
```

```python
import os
from everydeck import Everydeck

everydeck = Everydeck(
    endpoint=os.environ["EVERYDECK_URL"],
    credential="<server key of the environment>",
    release_key="auto",
    manifest_digest="<digest of the approved manifest>",
    heartbeat_interval=60,
    instance_id="api",
)
everydeck.signal("job.created", operation_id)
```

- `signal()`, `error()` and `log()` never block and never raise: they enqueue into a bounded in-memory buffer; a background thread sends batches (at most 50 events, 64 KiB, gzip-compressed).
- Retries only on 429, 5xx, timeout and network errors; `Retry-After` is honoured; final rejections are dropped and counted, never reported as sent.
- A buffer overflow is reported as a `gap` event, so everydeck shows a known data gap instead of silence.
- `heartbeat_interval` sends `everydeck.sdk.heartbeat` from the sender thread. Give each component a stable `instance_id` (for example `"api"`, `"worker"`).
- `release_key="auto"` derives the version from the deployment commit (`EVERYDECK_RELEASE_KEY`, `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`, …) or local git.
- `everydeck.verify.verify_everydeck_request` checks everydeck's signature on bridge calls.
- Read bridge on FastAPI or Starlette: `from everydeck.read_route import mount_read_bridge, SupabaseReadOnly` and `mount_read_bridge(app, SupabaseReadOnly(supabase_admin))` in the module that creates `app` add the route `/everydeck/read/{rest:path}` (outside the API schema); it reads `EVERYDECK_URL` and `EVERYDECK_READ_BRIDGE_TOKEN` from the environment when the first call arrives.
- Read bridge (0.3.0): `everydeck.read_route.EverydeckReadBridge(endpoint, key, db)` is the ready-made route for other frameworks. It fetches its read scope from everydeck (`GET <endpoint>/v1/read-scope` with the bridge key) and uses it only with everydeck's signature; no read-scope file, no read role, no views. `db` is the connection the app already has: `PsycopgReadOnly(conninfo)` runs every query in `BEGIN READ ONLY`, `SupabaseReadOnly(client)` reads through the app's Supabase client with `select()` only (GET requests, which PostgREST runs read-only; only tables in schemas the Supabase API exposes).

No dependencies. Python 3.11 or newer. License: MIT.
