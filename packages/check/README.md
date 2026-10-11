# @everydeck/check

The everydeck skeleton. It reads the facts of an app repository, each with its place in the code (file and line), into `everydeck/everydeck-befund.json`. It judges nothing; what it cannot read, the coding agent adds with places.

```bash
npx @everydeck/check@<version> . --out everydeck/everydeck-befund.json
```

The program is `everydeck-scaffold`:

```
everydeck-scaffold <repo> [--db <database url, a read-only role is enough>] [--out everydeck/everydeck-befund.json] [--merge <existing Befund>]
```

- Without `--out` the result goes to stdout; nothing is written into the repository.
- `--merge` keeps what was added to an existing Befund and renews only the skeleton parts.
- `--db` (or `EVERYDECK_SCHEMA_DB_URL`) reads the schema from the database first (tables, columns, keys, CHECK lists, policies, triggers, SQL functions from `pg_catalog`); the migrations stay the places. Connection through the package `pg` or `postgres` of the app, otherwise `psql`.
- Reads tables and columns from SQL migrations, Alembic and Firestore rules; provider packages from `package.json` and `requirements*.txt`; API routes (Express, Fastify, Hono, FastAPI, Next.js); pages (Next.js, Expo Router, React Router); platforms; and where the frontend shows data, through the syntax tree (TypeScript compiler API of the app, Python `ast`).
- TypeScript comes from the app's repository (or `NODE_PATH`); without it there is no analysis of the frontend, with a message.

The rules it applies are everydeck's own (`rules/everydeck-rules.mjs`, the same as everydeck uses when a Befund is submitted). Node 18 or newer. License: MIT.
