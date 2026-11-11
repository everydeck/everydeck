# @everydeck/check

The everydeck skeleton. It reads the facts of an app repository, each with its place in the code (file and line), into `everydeck/app-map.json`. It judges nothing; what it cannot read, the coding agent adds with places.

```bash
npx @everydeck/check@<version> . --out everydeck/app-map.json
```

The program is `everydeck-scaffold`:

```
everydeck-scaffold <repo> [--db <database url, a read-only role is enough; or the structure address everydeck gives>] [--out everydeck/app-map.json] [--merge <existing app map>]
```

- Without `--out` the result goes to stdout; nothing is written into the repository.
- `--merge` keeps what was added to an existing app map and renews only the skeleton parts.
- `--db` (or `EVERYDECK_SCHEMA_DB_URL`) reads the schema from the database first (tables, columns, keys, CHECK lists, policies, triggers, SQL functions from `pg_catalog`); the migrations stay the places. Connection through the package `pg` or `postgres` of the app, otherwise `psql`.
- For a hosted database the owner connected to everydeck (Supabase), `--db` takes the structure address everydeck gives in its setup step (`https://…/api/live-structure/…`) or a JSON file with that catalog: the same query, read by everydeck from the connected project, structure only, never rows. Tables that exist only in the database keep the place `database`.
- Reads tables and columns from SQL migrations, Alembic and Firestore rules; provider packages from `package.json` and `requirements*.txt`; API routes (Express, Fastify, Hono, FastAPI, Next.js); pages (Next.js, Expo Router, React Router); platforms; and where the frontend shows data, through the syntax tree (TypeScript compiler API of the app, Python `ast`).
- TypeScript comes from the app's repository (or `NODE_PATH`); without it there is no analysis of the frontend, with a message.

The rules it applies are everydeck's own (`rules/everydeck-rules.mjs`, the same as everydeck uses when an app map is submitted). Node 18 or newer. License: MIT.

## Changes

### 0.3.23

- The rules inside this package (`rules/everydeck-rules.mjs`, shared with `everydeck-check` 0.3.23) write the `jobs[]` entry of a named pg_cron schedule from the inventory and give the outbox entries an app map proves; the scaffold itself does not change, and `--merge` keeps those entries like every other job.
- Same version as `everydeck-check` 0.3.23, whose app map schema takes `flows[].result.write.attribution` (why every such row is one run of exactly this flow, and who did it). `--merge` keeps it like every field the agent sets; nothing else changes in the scaffold.
- The app map schema of `everydeck-check` 0.3.23 also takes `needs_attention[]` (what the app shows its team as needing attention, with the conditions of its query) and `must_keep[]` (tables whose rows must stay, with the place that forbids deleting them). The scaffold never writes either itself; `--merge` keeps them with their places as long as their tables exist.

### 0.3.22

- Same version as `everydeck-check` 0.3.22. The scaffold never enters folders `.gitignore` leaves out, other worktrees in the folder (`.claude/worktrees`, `git worktree add`) or other repositories inside it; a repository with many worktrees no longer runs it out of memory. Tables come only from what the app runs: never from a test script, text in quotes, a comment or an SQL word without quotes (`CREATE TABLE IF …`). `--merge` drops what an older scaffold read from there, in `tables` and in `not_in_database`, so nothing has to be added back by hand.
- The app map schema of `everydeck-check` 0.3.22 takes new optional fields on `moderation.queues[]`: `open_when`, `reason_words`, `pair_column` and `screen`. `--merge` keeps them like every field the agent sets; nothing else changes in the scaffold.

### 0.3.21

- Same version as `everydeck-check` 0.3.21, whose app map can name the tables the app deletes rows from itself (`row_deletes[]`, `jobs[].deletes`). `--merge` keeps the agent's entries, except for a table the code no longer has. `validate` refuses an entry without a place, a place that names the table but deletes nothing, a place that deletes another table, a table that is not in the app map, another value for who deletes, a window that is no ISO 8601 duration, and a job that deletes a table without its entry by schedule.

### 0.3.20

- Same version as `everydeck-check` 0.3.20, whose app map can say how the app builds the address of a photo (`columns[].image_src`). `--merge` keeps the agent's `image_src` like `contact` and `not_contact`.
- Same version as `everydeck-check` 0.3.20: `false_positive` per place in `outcomes[]`, `places` and `form` on every open part, no open part for a money table only its name points to.
- Same version as `everydeck-check` 0.3.20, whose app map schema takes new optional fields: `moderation.reports[].closed` and `target`, `moderation.queues`, `money.tables[].closed` and `tables[].statuses[].waits`. `--merge` keeps them like every field the agent sets; nothing else changes in the scaffold.
- Same version as `everydeck-check` 0.3.20, whose app map schema takes more optional fields: `platforms[].server_url` (native shell loading the web app from a server), `identity.browser_consent` and `inventory.consent_banners` (consent banner), `identity.last_active` (where the app stores when a person was last active).
- Same version as `everydeck-check` 0.3.20, whose `drift` no longer counts a schedule in SQL without a heartbeat (everydeck reads pg_cron itself); any other job without one is a note.

### 0.3.19

- Same version as `everydeck-check` 0.3.19, whose `validate --repo` now names in the inventory where the app's own server reads its everydeck settings. `--merge` keeps that inventory as before; nothing else changes in the scaffold.

### 0.3.18

- Reports need `moderation.reports` (shared rules with `everydeck-check` 0.3.18): a flow that reports (an update of the flagged table, an insert into the report table) no longer closes `flow:moderation`.
- `--merge` keeps every field the agent set that the scaffold does not find in the code itself: the first value, roles, moderation, what an AI call is for (`flow`, `context`), a page's label, the labels of a column's values, and any field a later app map adds. Only what the scaffold renews from the code on every run may change (tables, columns and their types, pages, routes, AI calls, packages, people, money, the checklist); a fact the agent gave for a table that is gone does not come back. Before, the GitHub check (`everydeck/check`) ran `--merge` on every push and dropped every field it did not name, and everydeck took the poorer app map. The same rule as everydeck uses when the check submits (shared with `everydeck-check` 0.3.18).

### 0.3.17

- Every app, not only apps on Supabase (shared rules with `everydeck-check` 0.3.17). The scaffold never stops: what it cannot read (a link to nothing, a file a part of the analysis cannot follow) is listed in `open[]` of its summary with the place. Tables: MySQL names in backticks, a reset or seed script outside the migrations drops nothing, `DROP` and `CREATE` run in the order of the file, `ALTER COLUMN` is no column, Python models through the syntax tree (`scaffold-models.py`: SQLModel `table=True`, SQLAlchemy with annotated `__tablename__` and `mapped_column` over several lines, columns of base classes) and Alembic in the order of its revisions (`add_column`, `drop_column`, renames). People: an own login (a password column, a session or account table), Auth.js, better-auth, Lucia, Django, Clerk. Money: Polar and Mercado Pago beside Stripe, Paddle and Lemon Squeezy; a provider only when the code uses its package; the ids of a provider on a table (`teams.stripe_customer_id`) make it money. Pages: Next.js in subfolders and the Pages Router, SvelteKit, Remix and React Router flat routes (also `+` folders), TanStack Router, React-admin, wouter `path={"/x"}`; route handlers per exported method. Display places: Prisma and Drizzle reads, React-admin's data hooks, helpers in `db/` or `supabase/` the frontend imports. The checklist marks login, payments, AI and organizations from what it found. Where it does not know, the summary asks with the place (`questions[]`, the same as `open[]` of `everydeck-check validate`).

### 0.3.16

- The app map says what everydeck needs to show the AI calls, reports, blocks and status changes of an app (shared rules with `everydeck-check` 0.3.16): `ai_calls[].context` (the place of `aiContext`, the flow it names and the references it passes: `subject_ref`, `account_ref`, `object_ref`; a reference the code cannot pass in `without` with one sentence why), `moderation.reports` (where people report content: a flag such as `reported` on a record, or a report table) and `moderation.blocks` (where the app blocks people or records). `everydeck-check validate` lists what is missing before you submit: every AI call without its context (`ai:context:<path>:<line>`), reports without `moderation.reports` or a report flow with a result signal (`flow:moderation`; a flow that sends a message is no longer a report), blocks without `identity.suspend` or `moderation.blocks` (`moderation:blocks`), and a table with a status column the browser changes without `status_column` and `statuses[]` or a flow with a result signal (`status:<table>`). Each closes with `not_applicable` and its place when the app has none. Optional fields; older app maps stay valid.

### 0.3.15

- Every flow people use is counted (shared rules with `everydeck-check` 0.3.15): `ai_calls[].flow` in the app map names the flow an AI call belongs to (the flow `aiContext({ flow })` names at that call; only ids from `flows[]`, only on `kind: call`). A flow people use that sends no signal, has no AI call naming it and creates no record with an owner and a creation time is an open part `signal:<flow id>` (`not_applicable` with its place when nobody really does it). Optional; older app maps stay valid.

### 0.3.14

- The app map knows what a person did and what they came for (shared rules with `everydeck-check` 0.3.14): `flows[].done` (what a person did in that flow, in the past tense, as the owner reads it in a timeline: Analyzed CV), `first_value` (the first result of a main flow that a new person came for, with its place), `roles[]` (the sides of an app that use it differently, each from a table of the app, with its own first value) and `screens[].label` (the name of the page as the app shows it). All four are optional; older app maps stay valid. `everydeck-check validate` lists every flow of a new app map without `done` as an open part.

### 0.3.13

- A table the migrations create that the database does not have is no part of the app: with `--db` the scaffold leaves it out of `tables` and lists it in the new `not_in_database` (table and place); a run without a database (the GitHub Action after the merge, `--merge`) keeps it out from there instead of bringing it back from the migrations. `validate` says why such a table may stand nowhere else (shared rules with `everydeck-check` 0.3.13).
- `--merge` pairs each AI call with its own entry of the last run (the calls of one file with the same symbol in their order) and moves a model only with its own call. Before, a call whose model the code does not name (`model=get_model()`) took the model of the nearest other call in the same file, and `everydeck-check validate` refused it.
- `--merge` keeps the coding agent's sentence for a mention in `not_shown` where this run finds the mention again (same file, within three lines); before, every rerun put the generic sentence back.
- `--merge` keeps a flow candidate of the merged app map that this scan does not find itself (everydeck-check found it, or the agent read it with `--db`), as long as its file is in the repository. Before, the GitHub Action dropped it after the merge, and everydeck counted a part it already knew as new and open.

### 0.3.12

- The app map in one form, as everydeck-check writes it: one line per entry of each list, one line per other field (a few hundred lines in a pull request instead of 20 000). The content is unchanged; a second run writes the same bytes. A file with another indentation is brought into this form once.
- `--merge` keeps what the coding agent described about a table that only the database knows (`defined: database`): its `works_with` entry, the entries that are part of it, and `core_object` stay as long as the table is in the merged app map. Without a database (the GitHub Action) the skeleton does not find such a table itself; before, it kept the table but dropped its description, and the object type left everydeck's sidebar.
- `--merge` keeps the agent's `identity.name_rule` when the skeleton finds no rule itself (and the table of people still has its columns); a rule the skeleton finds with its places replaces it. A column keeps the agent's `not_contact`, and, without a database, the foreign key, allowed values and default the agent read with `--db` when the migrations do not say them. With `--db` the database decides.
- The open part `people:visits` asks for the organization as the second value of `everydeck.setSubject(<user id>, <organization id>)`, the same id the app's server sends as `account_ref` (shared rules with `everydeck-check` 0.3.12).

### 0.3.11

- The bundled rules skip schedules whose name is a placeholder (`<job>`) or everydeck's own, and count a flow whose result the browser writes straight into the database as built in (the browser SDK records it through `writes`). The bundled rules ask for `everydeck.reset()` where the app signs the person out, never `setSubject(null)` (browser SDK 0.5.5).

### 0.3.10

- The bundled rules ask for the built-in flows: sign-in, sign-up and creating the core object (`core_object` in the app map) are never only planned; sign-in needs no signal of its own with `identity.browser_subject`, sign-up none with Supabase Auth (`auth.users`).

### 0.3.7

- The bundled rules no longer accept `unsupported` for a schedule everydeck-check finds (pg_cron in SQL, a GitHub Actions workflow, vercel.json, render.yaml): each of them can send a heartbeat (through the outbox, or with a check-in step at the end of the run), so the part stays open with the way to do it.

### 0.3.6

- The bundled rules no longer ask for a flow or left_out on smaller writes (update, delete, upsert, triggers) and know `outcomes[].also`.

### 0.3.5

- One candidate per way of a kind: several places of the same kind (sign-in with a password and with Google, a browser write of the same table from two files) each become a candidate `<id>@<way>` in `flow_candidates[]`, with the same rule as everydeck-check (`candidateWays` in the bundled rules). Only a flow on that way, `covered_by` with exactly that id or `not_applicable` closes it.
- `ai_calls` lists every call the SDK wrappers measure, also `images.edit`, `audio.translations.create`, `audio.speech.create`, `responses.parse` and Anthropic `messages.parse`.

### 0.3.4

- The bundled rules know `outcomes[]` and `inventory` of the app map (a part everydeck found is connected or stays open).

### 0.3.3

- Money without a payment provider: a table with a foreign key to a money table is written as `refers_to_money`; what the agent wrote about a money table (`holds`, `roles`, `statuses`, `currency`, `minor_unit`, `price`, `reason`) stays when the scaffold runs again with `--merge`, also on a table the scaffold finds itself.

### 0.3.2

- People come from the schema, not from what was written by hand: the table with one row per account (its key references `auth.users`; with several, the one whose name the app shows) is proposed as `identity`, with the name column the app shows, e-mail and phone (never read by everydeck) and memberships that carry a role. A table or `null` given in an existing app map no longer overrules the schema unless it is at least as well supported (a name the app shows).
- Keys added after the table are read: `ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY (…)` and `… FOREIGN KEY (…) REFERENCES …` (schema dumps in the style of `pg_dump`), and `PRIMARY KEY (a, b)` as a line of `CREATE TABLE`.
- The page an app sends people to after a password reset email (`redirectTo` of the reset call) is written to `flow_candidates[].redirect`.
