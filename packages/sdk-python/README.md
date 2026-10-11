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
- `heartbeat_interval` sends `everydeck.sdk.heartbeat` from the sender thread. Give each component a stable `instance_id` (for example `"api"`, `"cv-worker"`).
- `release_key="auto"` derives the version from the deployment commit (`EVERYDECK_RELEASE_KEY`, `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`, …) or local git.
- `everydeck.verify.verify_everydeck_request` checks everydeck's signature on bridge calls; `everydeck.read_bridge.ReadBridge` serves the read bridge.

No dependencies. Python 3.11 or newer. License: MIT.
