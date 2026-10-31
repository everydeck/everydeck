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
