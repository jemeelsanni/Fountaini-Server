# School Management Portal — Server

A Node.js/Express/TypeScript API backing a single-school management portal:
students, staff, parents, academic structure (sessions/terms/classes/
subjects), scores and report cards, attendance (QR-based), fees and
payments, admissions, notifications, timetabling, and a role-based
authorization layer on top of all of it.

This document assumes no prior familiarity with the codebase — it's
everything you need to get the server running locally, understand what each
piece of configuration does, and find your way to the API's own
documentation once it's up.

## Prerequisites

- **Node.js 20.19+ or 22.13+ or 24+.** `package.json` states `>=18.18` as
  its formal minimum, but the dev tooling (ESLint 10, Vitest 4) actually
  wants one of the versions above — anything older prints `EBADENGINE`
  warnings on install. They're warnings, not hard failures, but an LTS
  Node in that range avoids them entirely.
- **npm** (ships with Node).
- **Docker** and **Docker Compose**, to run Postgres locally without
  installing it natively. (If you already have Postgres 16 running some
  other way, you can skip Docker entirely — see [Database](#database).)
- **Prisma is pinned to the 6.x major, not 7.x.** This is deliberate, not
  an oversight: on Node versions in the 23.x (non-LTS) line, the Prisma 7
  CLI fails to run at all. Don't run `npm install prisma@latest` without
  checking this first.

## Quick start

```bash
git clone <this-repo-url>
cd "Fountaini Server"
npm install

cp .env.example .env
# open .env and set JWT_ACCESS_SECRET to a real random value — see
# Environment variables below for how

docker compose up -d          # starts Postgres on localhost:5432

npx prisma migrate dev        # creates the schema in the "school_portal" database
npm run db:seed               # creates an admin user + seeds reference data

npm run dev                   # starts the API on http://localhost:4000
```

Once it's running, open **http://localhost:4000/api/docs** — that's the
full, interactive API reference (see [API documentation](#api-documentation)
below).

The admin account the seed step creates:

- email: `admin@school.test` (or `SEED_ADMIN_EMAIL` if you set one)
- password: `ChangeMe123!` (or `SEED_ADMIN_PASSWORD` if you set one — the
  seed script prints the password it used either way, so you're never
  guessing)

## Database

### Starting Postgres via Docker Compose

`docker-compose.yml` at the repo root defines a single `postgres:16`
service, exposing port 5432 on your machine with user `postgres`, password
`postgres`, and a default database named `school_portal` — matching
`.env.example`'s `DATABASE_URL` exactly, so the quick-start steps above
work with zero further configuration.

```bash
docker compose up -d      # start it, in the background
docker compose ps         # confirm it's healthy
docker compose down       # stop it (add -v to also delete the data volume)
```

If your Docker CLI is older and only has the standalone `docker-compose`
(hyphenated) command rather than the `docker compose` plugin, every command
above works identically with a hyphen instead of a space.

### Migrations

This project uses Prisma Migrate. Applying the schema to a fresh database:

```bash
npx prisma migrate dev
```

This runs every migration under `prisma/migrations/` against whatever
database `DATABASE_URL` in your `.env` points at, and regenerates the
Prisma Client. You only need `prisma migrate dev` (not `deploy`) locally —
`dev` is also the one that would prompt you to name a new migration if you'd
edited `prisma/schema.prisma` yourself, which you won't be doing as a first
run.

A few migrations in this project's history are **hand-written** rather than
Prisma-generated — anything involving a partial unique index (Postgres
feature Prisma's schema language can't express) or a data-preserving column
migration (moving existing column data into a new table/shape rather than
just adding a column). This is normal for this codebase; you don't need to
do anything differently to apply them; `prisma migrate dev` runs them the
same as any other migration.

### Seeding

```bash
npm run db:seed
```

Idempotent — safe to run again later; it upserts rather than duplicating.
It does two things:

1. Creates one `ADMIN` user (email/password from `SEED_ADMIN_EMAIL` /
   `SEED_ADMIN_PASSWORD`, or the defaults shown in [Quick start](#quick-start)
   if you don't set them) — this is the account you log in with to start
   creating everything else (staff, classes, students) through the API.
2. Seeds the 114 Surahs (static Qur'an reference data used by the
   Madrassah-progress module) — this data never changes, so it's seeded
   unconditionally rather than being something you manage per-environment.

### The test database

Tests run against a **separate** Postgres database, `school_portal_test`
(see `.env.test`), so running the suite never touches the data you're
looking at in `school_portal`. Docker Compose only creates the one database
named in its `POSTGRES_DB` setting, so you need to create the test one and
migrate it once, yourself:

```bash
docker compose exec postgres psql -U postgres -c "CREATE DATABASE school_portal_test;"
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/school_portal_test?schema=public npx prisma migrate deploy
```

(`migrate deploy` rather than `migrate dev` here — it just applies existing
migrations non-interactively, which is all a test database ever needs; it
never generates new migrations.) You only need to do this once per machine;
after that, `npm test` reuses the same test database, truncating its tables
between test files as it goes.

If you ever need to point tests at a differently-configured local Postgres
(different port, a native install instead of Docker, different credentials)
without touching the committed `.env.test`, create `.env.test.local` —
it's gitignored, and any variable you set there overrides `.env.test` for
your machine only.

## Environment variables

All of these live in `.env` (gitignored — your own local values) and are
documented with their defaults in `.env.example` (committed, safe to read).
Every one of them is validated at startup (`src/config/env.ts`) — the
server refuses to start rather than run with a missing or malformed value.

| Variable | What it does |
|---|---|
| `NODE_ENV` | `development`, `test`, or `production`. Governs a few small behavioral differences elsewhere in the codebase (e.g. password-hashing cost is deliberately weakened only when this is `test`, to keep the test suite fast — see `src/modules/auth/password.ts`). |
| `PORT` | The port the HTTP server listens on. Defaults to `4000`. |
| `DATABASE_URL` | Postgres connection string, in the standard `postgresql://user:password@host:port/database?schema=public` form. Points at `school_portal` for normal dev use — see [Database](#database) above. |
| `JWT_ACCESS_SECRET` | The signing secret for access tokens. Must be at least 32 characters. **Generate a real one** — don't ship the placeholder in `.env.example`: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `JWT_ACCESS_TTL_SECONDS` | How long an issued access token stays valid, in seconds. Defaults to `900` (15 minutes). |
| `REFRESH_TOKEN_TTL_DAYS` | How long a refresh token stays valid before it must be used to rotate to a new one. Defaults to `30`. |
| `PUBLIC_BASE_URL` | The externally-reachable base URL for this API. Used for exactly one thing: the `servers` entry in the generated OpenAPI spec, so the "try it out" requests in `/api/docs` point at the right host. Defaults to `http://localhost:4000`, which is correct for local dev — **set this explicitly in every deployed environment** (e.g. `https://your-app.up.railway.app`), or the docs will show requests going to the wrong place. |

Two more, used only by the seed script (`prisma/seed.ts`) and **not**
present in `.env.example`, since they're optional and only relevant to that
one command:

| Variable | What it does |
|---|---|
| `SEED_ADMIN_EMAIL` | Overrides the seeded admin's email (default `admin@school.test`). |
| `SEED_ADMIN_PASSWORD` | Overrides the seeded admin's password (default `ChangeMe123!`). |

## Running the app

```bash
npm run dev      # tsx watch — restarts on file change, no build step
npm run build    # compiles src/ to dist/ via tsc
npm start        # runs the compiled dist/server.js (run `build` first)
```

## Testing

```bash
npm test         # runs the full suite once
npm run test:watch   # Vitest in watch mode
```

Requires the test database to exist and be migrated first — see
[The test database](#the-test-database) above. The suite runs against a
real Postgres instance (no mocked database layer), truncating tables
between test files rather than mocking anything, so this one-time setup
step is a hard prerequisite, not an optional nicety.

The suite is pinned to run fully sequentially, single-process (see
`vitest.config.ts`'s comment for why) — it's not slow enough for that to
matter day to day, but it does mean the tests never run faster by throwing
more CPU cores at them.

## Code quality

```bash
npm run typecheck   # tsc --noEmit — no build output, just type errors
npm run lint         # ESLint
npm run lint:fix     # ESLint, auto-fixing what it safely can
```

`typecheck` only checks `src/**/*.ts` (see `tsconfig.json`'s `include`) —
scripts under `prisma/` (like the seed script) run via `tsx` directly and
aren't covered by it.

## API documentation

Once the server is running, the full API reference is generated live from
the actual route definitions and Zod validation schemas in this codebase —
it can never silently drift out of sync with the real API, because it's
built from the same code that serves it, not maintained by hand alongside
it.

- **http://localhost:4000/api/docs** — an interactive Swagger UI page:
  every route, its request body, its response shape, and which roles are
  allowed to call it.
- **http://localhost:4000/api/openapi.json** — the raw OpenAPI 3.1
  document, if you want to feed it to a code generator, import it into
  another API client, or just read the JSON directly.

Both are public — no login needed to view the docs themselves (you'll still
need a real access token to actually call most of the routes they
describe, same as always).

Every route registered anywhere in `src/modules/` is required to appear in
this generated spec — `src/openapi/openapi.test.ts` asserts it as part of
the normal test suite, so a new route added without corresponding
documentation fails the build the same way an unguarded (no auth/role
check) route already does.
