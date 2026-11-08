# everydeck-check

The everydeck check for app repositories. It validates `everydeck/app-map.json` with everydeck's own rules, finds everydeck calls that went missing from the code, re-anchors places that moved and publishes the facts to everydeck. It never sends code.

```bash
pip install everydeck-check
everydeck-check validate everydeck/app-map.json --repo .
```

Commands:

- The app map is `everydeck/app-map.json`; without a path the commands read it there (an earlier setup's `everydeck/everydeck-befund.json` is still read).
- `validate <app_map> [--repo .]`: the check everydeck runs when an app map is submitted (shape, references, result signal, derived manifest), plus building blocks of the repository that must appear in `coverage[]`.
- `drift <app_map> --repo . [--freeze]`: is every everydeck call still in the code (against `everydeck-manifest.lock.json`); `--freeze` writes the lock file.
- `reanchor <app_map> --repo .`: moves every place of the app map from its commit to HEAD (git diff, text, symbol); nothing is guessed, unresolved places are listed.
- `reads <app_map>`: the cross-check of display locations.
- `footprint --base <commit before the setup> [--fix-lock]`: the files the setup added and changed, a lockfile rewritten beyond the new packages (`--fix-lock` restores it with only the new packages) leftovers such as `.playwright-mcp/` or screenshots, and every AI client of the app map (`ai_calls`) that is not wrapped with the everydeck SDK.
- `local-db --repo .`: the app's local database for `--db`, from `supabase/config.toml` or from a local Supabase stack or PostgreSQL the app's env files point to. It reads the env files itself (like Prisma reads `.env`) and prints no value of them, only the file, the variable name and the port; the url only with the fixed password of a local Supabase stack.
- `validate --db` takes a database url, or for a hosted database the structure address everydeck gives (or a JSON file with that catalog); every table of it must be in the app map.
- `runtime --repo .`: the Python and Node versions the app uses, against this session, and how to check with the app's.
- `publish <app_map> --url <everydeck> --project <id>` and `change`: send the facts to everydeck.

everydeck's rules ship inside the package (`everydeck_check/rules/everydeck-rules.mjs`) and run with `node` (18 or newer). Python 3.11 or newer. License: MIT.

## Changes

### 0.3.19

- `validate --repo` writes into the inventory where the app's own server reads its everydeck settings from `public.everydeck_server_config()` (`server_settings`: `everydeckFromSupabase`, `serverConfigFromSupabase`, `Everydeck.from_supabase`, `rpc('everydeck_server_config')`) and everydeck's own files in the repository (`everydeck_files`). Code that reads the settings while the repository has no `*_everydeck_server_config.sql` is an error: in a live app `everydeck_live_files` with `own_server: true` brings the function. everydeck compares both with the plan of `everydeck_live_files` when the app map is submitted (shared version with `@everydeck/check` 0.3.19).

### 0.3.18

- `validate` asks for `moderation.reports` wherever people can report content (a flag such as `reported` on a record, a report table), also when a flow with a result signal already reports it (`flow:moderation` stays open; shared rules with `@everydeck/check` 0.3.18). Until the app map names the place, everydeck shows the reports of such a flow under Moderation anyway.
- `reanchor` and `validate --repo` keep every fact the agent set in the app map, checked with the same rule as the scaffold's `--merge` and everydeck (`@everydeck/check` 0.3.18). Ships with the scaffold that no longer drops the first value, roles, moderation or the context of an AI call on a merge.

### 0.3.17

- `validate` runs every check in one run: shape, references, everydeck's rules, the database, every place in the repo, completeness and contact copies. The errors about the app map come first, a missing result signal (a change of the app's code) last, and `open[]` lists the open parts while errors remain. Before, the first stage with an error hid every later one. Tables are read like `@everydeck/check` 0.3.17 (MySQL backticks, reset scripts drop nothing, `DROP` and `CREATE` in file order, Prisma `@@map(name: …)` gives one name per model, SQLModel `table=True`, annotated `__tablename__`). `works_with` names its table by any name the code gives it (snake_case, camelCase, the model name, singular); a symbol alone no longer passes a place without the table. Module paths, i18n keys with three or more parts and CSS selectors are no mention of a table. New open parts `question:people` and `question:money:<table>` ask for who signs in and for tables with amounts or subscription columns, each with the place; an outcome closes them. Polar and Mercado Pago are known providers.

### 0.3.16

- The app map says what everydeck needs to show the AI calls, reports, blocks and status changes of an app (shared rules with `@everydeck/check` 0.3.16): `ai_calls[].context` (the place of `aiContext`, the flow it names and the references it passes: `subject_ref`, `account_ref`, `object_ref`; a reference the code cannot pass in `without` with one sentence why), `moderation.reports` (where people report content: a flag such as `reported` on a record, or a report table) and `moderation.blocks` (where the app blocks people or records). `everydeck-check validate` lists what is missing before you submit: every AI call without its context (`ai:context:<path>:<line>`), reports without `moderation.reports` or a report flow with a result signal (`flow:moderation`; a flow that sends a message is no longer a report), blocks without `identity.suspend` or `moderation.blocks` (`moderation:blocks`), and a table with a status column the browser changes without `status_column` and `statuses[]` or a flow with a result signal (`status:<table>`). Each closes with `not_applicable` and its place when the app has none. Optional fields; older app maps stay valid.

### 0.3.15

- Same version as the scaffold `@everydeck/check` 0.3.15 (the two are a pair) and the same schema and rules: `ai_calls[].flow` in the app map (optional, older app maps stay valid; `validate` checks that it names a flow of `flows[]`), and every flow people use that everydeck neither gets reported nor sees itself is an open part `signal:<flow id>`.
- `validate --repo` no longer asks for a table listed in `not_in_database` in `tables[]` (before, the same table got both "leave it out of tables" and "add it with its columns").

### 0.3.14

- Same version as the scaffold `@everydeck/check` 0.3.14 (the two are a pair) and the same schema and rules: `flows[].done`, `first_value`, `roles[]` and `screens[].label` in the app map (all optional, older app maps stay valid). `validate` checks the places of `first_value` and of each role and its first value in the repository, and lists every flow of a new app map without `done` as an open part.

### 0.3.13

- Same version as the scaffold `@everydeck/check` 0.3.13 (the two are a pair). `not_in_database`: tables the code creates that the database does not have (found by the scaffold with `--db`). `validate` refuses them in `tables` and answers anything that names them with the reason ("is in the code but not in the database"); the inventory leaves them out (no table, no candidate).
- `validate --db` accepts a trigger that the scaffold read from the database (`flow_candidates[]` with `source: trigger` and the place `database`): it checks the table, as for every trigger from the catalog. Before, it looked for the trigger's name among the tables and refused the scaffold's own entry.
- With the scaffold's `--merge`, flow candidates that everydeck-check found and the scaffold does not stay in the app map.

### 0.3.12

- Same version as the scaffold `@everydeck/check` 0.3.12 (the two are a pair) and the same rules: the open part `people:visits` asks for the organization as the second value of `everydeck.setSubject(<user id>, <organization id>)`, the same id the app's server sends as `account_ref`.
- `runtime --repo .`: the Python and Node versions the app really uses (the image of a Dockerfile, `.python-version`, `runtime.txt`, `requires-python` in pyproject.toml, `python_version` in Pipfile, `.nvmrc`, `.node-version`, `engines.node`), each with its place, against the versions of this session, and how to run a check with the app's version without changing the machine (`uv run --python <version> …`, the image with docker, `npx -y node@<version>`). Without any of these it says "not tested with Python <version>". A check that imports the server with the session's Python proves nothing for an app on python:3.11.

### 0.3.11

- The inventory no longer reads a schedule out of an SQL comment: `cron.schedule('<job>', '<rhythm>', …)` in the comment of everydeck's own outbox migration became an open part "Scheduled job <job>". Names that are a placeholder (`<…>`) are skipped as well.
- `validate` counts a flow whose result the browser writes straight into the database (a `browser_write` candidate with the same table and kind) as built in: the browser SDK records each such write as a run (`writes`), so it is never shown as only planned.
- Sign-out is `everydeck.reset()` (browser SDK 0.5.5, like PostHog): `drift` (`subject_not_in_code`) and the app map schema (`identity.browser_subject`) no longer say `setSubject(null)` on sign-out. `setSubject(null)` while the app loads its session made every reload count as a new sign-in.

### 0.3.10

- `validate` asks for the built-in flows: sign-in, sign-up and creating the core object are never only planned. A sign-in flow needs a result signal unless `identity.browser_subject` names the place of `everydeck.setSubject` (the browser SDK reports every sign-in); a sign-up flow needs one unless the app uses Supabase Auth with `identity.auth_table` `auth.users` (everydeck reads each new account from `created_at`). The new `core_object` (`{ table, evidence }`, a table of `works_with`) names what the people of the app create most; the flow that inserts it needs a result signal, and an app map whose people create records without it is refused. The place of `core_object` is checked like every place. Every other flow people use is counted as well: a result signal, its AI calls (`ai_calls[].flow`, the flow that `aiContext({ flow })` names at that call) or the new rows of its own table with an owner and a creation time; otherwise `validate` lists it under `open[]` as `signal:<flow id>`.
- `drift` reports `subject_not_in_code` when an app with people who sign in uses the browser SDK but never calls `everydeck.setSubject(<user id>)`: without it every visit and every sign-in stays anonymous.

### 0.3.9

- `local-db --repo .`: finds the app's local database without the agent reading an env file: `supabase/config.toml` of the repository (the port under `[db]`, 54322 when it names none), else a variable in the app's env files that points to the gateway of a running local Supabase stack (Docker label `com.supabase.cli.project`, the stack's database port), else a local PostgreSQL with the fixed local password. Exit 0 when found, 2 otherwise, with the next step.

### 0.3.8

- `drift` counts the two new ways of a job heartbeat: a schedule in SQL whose command runs in `everydeck_outbox.run_job('<job>', …)` or calls `everydeck_outbox.job_heartbeat('<job>')`, and a run outside the app (for example a GitHub Actions workflow) whose last step calls `…/v1/jobs/<job>/check-in`. A job without either stays `job_not_in_heartbeat`.
- `validate` no longer accepts `unsupported` for a schedule it finds (pg_cron, GitHub Actions, vercel.json, render.yaml): the part stays open with the way to send its heartbeat.

### 0.3.7

- The smaller writes (update, delete or upsert from the browser, triggers) need no flow and no left_out; they stay listed as smaller writes not followed. A new entry from the browser and sign-up, sign-in, password reset and payment still need a flow or an answer.
- `outcomes[].also`: one covered_by can name further open parts the same flow explains in exactly the same way (for example the same report from several pages); each listed id is checked like its own outcome, parts not listed stay open.

### 0.3.6

- One candidate per way of a kind: several places of the same kind (sign-in by password, one-time code, OAuth or SSO; a browser write or a checkout of the same table in another file) each become a candidate `<id>@<way>` in the inventory. A way is closed only by a flow on that way, `covered_by` with exactly that id, or `not_applicable`; a flow on another way never closes it.
- Schedules without a package: `cron.schedule` in SQL (pg_cron), `crons` in `vercel.json`, `type: cron` services in `render.yaml` and `schedule` in GitHub Actions workflows are listed in `inventory.schedules`; each one is an open part `jobs:schedule:<source>:<name>` until a `jobs[]` entry names its place. Files of other hosts that name a schedule everydeck-check does not read are listed as `jobs:not_checked:<file>`. At most 50 schedules are listed one by one; the rest is one open part.
- A money table needs a meaning: `holds` with columns that carry money (`roles`) or `price`, a price list another money table looks its amount up in (`price.table`), or `log` with the place for a table that only records events (such as stored webhooks). `because` and `evidence` alone leave it open.
- `footprint` counts a wrapped AI client only for the methods the SDK wrapper measures (0.5.1: chat, responses, completions, embeddings, `images.generate`, `images.edit`, `audio.transcriptions.create`, `audio.translations.create`, `audio.speech.create`); any other call found, such as Anthropic `messages.stream`, needs `aiCall`/`ai_call` at its place.
- `validate` refuses an app map that leaves out an AI call the SDK wrappers measure, also images (`images.generate`, `images.edit`), audio (`audio.transcriptions`, `audio.translations`, `audio.speech`), `responses.parse`, Anthropic `messages.parse` and `messages.stream`.

### 0.3.5

- `restart-stack --repo .` restarts the app's local Supabase stack during the setup: `supabase stop`, then `supabase start`, with the Supabase CLI installed for the app (`node_modules/.bin/supabase`, then `supabase` on PATH; never `npx`), for the stack of this repository only (`--workdir`), each command with a time limit (`--timeout`, default 300 seconds). A command that hangs is stopped with its own process group, nothing else; the CLI's output (it prints the stack's keys) is never shown. It answers `ok`, `timeout`, `failed` (with `docker_not_running`, `port_in_use` or `cli_error`), `no_cli` or `no_stack`, and says what to do next.
- Tables in everydeck's own schemas (`everydeck`, `everydeck_outbox`, `everydeck_bridge`, `everydeck_read`), such as the outbox copied unchanged from `@everydeck/sdk`, need no entry in `tables[]`; a table of the app with the same name still does.
- The inventory carries short `excerpts` of the code at the places it found (sign-in and payment, new rows from the browser, other writes, providers): at most 60, each 13 lines of at most 300 characters, 40,000 characters together. Keys and passwords are replaced by `[redacted] (kind)` with everydeck's own rules before they are written; without the rules (no `node`) no excerpt is written. Never from SQL, JSON, YAML, CSV or `.env` files: the schema goes as table and column names, rows never. everydeck may send them once per setup to its own AI model to check what the app map misses.
- Clearer refusals: a missing result signal says to write it now (the SDK switches itself off until the keys exist) and to choose the place from the app map; `result.provider` names the component of the login provider (`supabase_auth` → the component of `@supabase/supabase-js`); `everydeck_tables` says that everydeck's schemas count by themselves. Every refusal of `validate` carries `next`.

### 0.3.4

- `validate --repo` writes `inventory` into the app map (never edit it): what everydeck-check finds in the repo itself, with the version of the tool, the commit and a digest: building blocks, provider packages (also imported by URL, `https://esm.sh/…`, `npm:`, `jsr:`, and providers the code calls over HTTP such as `fcm.googleapis.com`), flow candidates, every table, and what it did not read (files over the size limits, package files deeper than three folders, code in Go, Ruby, PHP, Java, Kotlin, C#, Elixir, Rust or Scala).
- `validate` refuses `not_applicable` when everydeck-check itself finds the part used in the code, and names the place: a money table read or written (`.from('plans')`), an email, push or payment provider called or imported, a table of a group written, a sign-up call. Only its own find against the claim.
- A browser write that creates a row (insert) is a core part: only a flow for exactly that operation, `covered_by` with exactly that operation or `not_applicable` closes it, not another flow of the same group or table. Updates stay smaller writes.
- `validate` lists `open[]`: every part that nothing connects yet (email or push without a channel, sign-up without a flow, chats without a flow on their tables, reports without `moderation.reports`, money tables without a `money.tables` entry, candidates no flow explains), as everydeck returns them on submission. A reason in `left_out` keeps a part open; `outcomes[]` closes it with `covered_by` (a flow that does exactly this operation) or `not_applicable` with a place in the code, which `validate` checks like every other place; `deferred` and `unsupported` keep it open.

### 0.3.3

- Money without a payment provider: `money.tables[]` takes `because: "described_by_agent"` with a `reason`, and for every money table `holds` (`plans`, `purchases`, `requests`, `prices`), `roles` (columns for amount, currency, period, product, buyer, object, time, start, end), `statuses[]` (what a value means: paid, free, ended, requested, refunded, failed), `currency`, `minor_unit` and `price` (the app's own price list). `validate` checks that every column exists in its table and every place is in the code; a table described by the agent needs its reason.
- `refers_to_money`: a table with a foreign key to a money table.
- `footprint` names every AI client of `ai_calls` the setup did not wrap (OpenAI and providers through the OpenAI client: `wrap_openai`/`wrapOpenAI` in the client's file; Anthropic: `wrap_anthropic`/`wrapAnthropic`; other providers: `ai_call`/`aiCall` in the file of their calls) and exits 2 until each is measured.

### 0.3.2

- `validate` derives people from the schema with the same rule as everydeck: the profile table (one row per account), people without a login (records with a person's name and an e-mail or phone, not money), memberships with a role.
- A table without a known primary key is identified by its `id` column before any foreign key.
- `flow_candidates[].redirect` on `password_reset`: the page of the app a password reset email leads to.
- Amounts and limits are editable; locked for good are identifiers, references and owners (`LOCKED_ROLES = ("ref", "person")`).
