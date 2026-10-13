# everydeck outbox

For apps whose **browser writes straight into the database** (for example a Supabase client inserting or updating rows under RLS).
There is no server code that could send the result signal after the commit, and the browser cannot prove a commit. The outbox gives
these results a durable server-side source:

1. a trigger on the app's own table writes one row into `everydeck_outbox.event` in the **same transaction** as the business write
   (a rolled-back write leaves no row; only committed results reach everydeck);
2. a relay sends the rows to everydeck and deletes each row **only after everydeck accepted it** (202). everydeck de-duplicates by
   `event_id`, so a row sent twice counts once;
3. after each run that delivered everything, the relay sends the heartbeat of the job `everydeck_outbox_relay`. If the relay stops,
   everydeck opens a case after two missed periods.

Only references leave the database: signal name, run id, person, account and object reference. No column values, no texts.

Everything comes from the package `@everydeck/sdk` of the exact version you installed; nothing is downloaded or copied from elsewhere.

## Files

| File | What you do with it |
|---|---|
| `node_modules/@everydeck/sdk/outbox/everydeck_outbox.sql` | Copy unchanged as a new migration (schema `everydeck_outbox`, table, trigger function). Plain PostgreSQL 13+. |
| `node_modules/@everydeck/sdk/outbox/everydeck_outbox_triggers.example.sql` | The only part you write: one `CREATE TRIGGER … EXECUTE FUNCTION everydeck_outbox.capture(…)` per declared result. Save as its own migration. |
| `node_modules/@everydeck/sdk/outbox/everydeck_outbox_schedule.supabase.sql` | Supabase: copy as a migration. pg_cron calls the Edge Function every minute (with the job heartbeat) and every 5 seconds while rows wait (without it), so a result reaches everydeck within seconds; URL and token come from Vault. |
| `supabase/functions/everydeck-outbox-relay/index.ts` | Supabase: four lines that import the relay from `npm:@everydeck/sdk@<version>/outbox` (below). |
| `npx everydeck-outbox-relay` | Apps on plain PostgreSQL without pg_cron/Edge Functions: run as the app's own worker (needs `pg`); it delivers every 5 seconds and sends the heartbeat once a minute. |

The Supabase function:

```ts
import postgres from 'npm:postgres@3.4.5';
import { createRelayHandler } from 'npm:@everydeck/sdk@<version>/outbox';
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1, idle_timeout: 20 });
Deno.serve(createRelayHandler({ query: (text: string, params: unknown[]) => sql.unsafe(text, params as never[]), env: (n: string) => Deno.env.get(n) }));
```

## Steps

1. **Triggers.** For every result (or failure/alternative end) whose evidence is a committed write from the browser, add one trigger:
   `AFTER INSERT` or `AFTER UPDATE OF <column>`, `FOR EACH ROW`, with a `WHEN` clause that is exactly the state change the code
   proves (old state differs, new state is the result). Arguments of `everydeck_outbox.capture`: signal, run id prefix, run id column,
   person column, account column, object type, object ref column (`''` = none). The run id must be the value the rest of the flow
   uses (browser `operationId`, other signals). Name it `everydeck_outbox_<table>_<event>`.
2. **Manifest.** Declare each signal with `allowed_source: "server"` and `location { path: "<triggers migration>", symbol: "<trigger name>", commit }`.
   Declare the relay as a job (1.9-r0): `{ "id": "everydeck_outbox_relay", "label": "everydeck outbox relay", "every": "1m", "component": "<database component>", "evidence": [{ "path": "<schedule migration or worker>", "commit": "…" }] }`.
   Declare a step the browser sees when the write fails (for example "Submit failed") as a `failure` step with `browser_error` naming the browser action.
3. **Supabase.** Function env: `EVERYDECK_ENDPOINT`, `EVERYDECK_RELEASE_KEY`, `EVERYDECK_MANIFEST_DIGEST` (not secret). Deploy with
   `supabase functions deploy everydeck-outbox-relay --no-verify-jwt`; the function checks its own invoke token from Vault. The **owner**
   creates three Vault secrets in the SQL editor (never in a migration, never in the repository, never by you in production):
   `everydeck_outbox_relay_url`, `everydeck_outbox_invoke_token` (random, ≥ 32 characters), `everydeck_ingest_key` (the everydeck server key of that
   environment). Locally (`supabase start`) you create them yourself with the **development** key.
4. **Plain PostgreSQL.** Run `npx everydeck-outbox-relay` as a worker with `EVERYDECK_OUTBOX_DATABASE_URL`, `EVERYDECK_ENDPOINT`, `EVERYDECK_SERVER_KEY`,
   `EVERYDECK_RELEASE_KEY`, `EVERYDECK_MANIFEST_DIGEST` from the environment. The database role needs `USAGE` on schema `everydeck_outbox` and
   `SELECT, UPDATE, DELETE` on `everydeck_outbox.event`, nothing else.
5. **Verify locally (Step 4 of the guide, never against production):** a write from the browser produces exactly one row; a
   rolled-back write produces none; a run of the relay delivers it (the signal appears in everydeck) and deletes the row; the job
   heartbeat arrives; with the relay stopped for two periods everydeck opens a case "Job “everydeck outbox relay” has not reported".

## Rows that stay

`SELECT id, name, attempts, last_error, rejected_at FROM everydeck_outbox.event ORDER BY id;` shows them: rows with `attempts > 0` wait for the next
run (everydeck was not reachable); rows with `rejected_at` were refused by everydeck (for example a signal name that is not declared) and are
never sent again. Fix the cause, then delete them or reset `rejected_at` to resend.
