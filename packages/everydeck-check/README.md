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
- `publish <app_map> --url <everydeck> --project <id>` and `change`: send the facts to everydeck.

everydeck's rules ship inside the package (`everydeck_check/rules/everydeck-rules.mjs`) and run with `node` (18 or newer). Python 3.11 or newer. License: MIT.

## Changes

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
- `validate` lists `open[]`: every part that nothing connects yet (email or push without a channel, sign-up without a flow, chats or reports without a flow on their tables, money tables without a `money.tables` entry, candidates no flow explains), as everydeck returns them on submission. A reason in `left_out` keeps a part open; `outcomes[]` closes it with `covered_by` (a flow that does exactly this operation) or `not_applicable` with a place in the code, which `validate` checks like every other place; `deferred` and `unsupported` keep it open.

### 0.3.3

- Money without a payment provider: `money.tables[]` takes `because: "described_by_agent"` with a `reason`, and for every money table `holds` (`plans`, `purchases`, `requests`, `prices`), `roles` (columns for amount, currency, period, product, buyer, object, time, start, end), `statuses[]` (what a value means: paid, free, ended, requested, refunded, failed), `currency`, `minor_unit` and `price` (the app's own price list). `validate` checks that every column exists in its table and every place is in the code; a table described by the agent needs its reason.
- `refers_to_money`: a table with a foreign key to a money table.
- `footprint` names every AI client of `ai_calls` the setup did not wrap (OpenAI and providers through the OpenAI client: `wrap_openai`/`wrapOpenAI` in the client's file; Anthropic: `wrap_anthropic`/`wrapAnthropic`; other providers: `ai_call`/`aiCall` in the file of their calls) and exits 2 until each is measured.

### 0.3.2

- `validate` derives people from the schema with the same rule as everydeck: the profile table (one row per account), people without a login (records with a person's name and an e-mail or phone, not money), memberships with a role.
- A table without a known primary key is identified by its `id` column before any foreign key.
- `flow_candidates[].redirect` on `password_reset`: the page of the app a password reset email leads to.
- Amounts and limits are editable; locked for good are identifiers, references and owners (`LOCKED_ROLES = ("ref", "person")`).
