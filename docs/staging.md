# Staging environment

Staging is a second, fully separate copy of the deployed stack: its own
Railway environment, its own app service instance, and — the part that
matters most — its own Postgres. Nothing done in staging can read or write
production data, and production keeps deploying from `main` exactly as
before.

| | Production | Staging |
|---|---|---|
| Git branch Railway deploys from | `main` | `staging` |
| Railway environment | `production` | `staging` |
| Database | production Postgres | staging Postgres (separate instance) |
| Data | real school records | demo seed only (`docs/demo-credentials.md`) |
| `NODE_ENV` | `production` | `production` (same code path as prod — on purpose) |
| `/api/docs` | off | on (`DOCS_ENABLED=true`) |
| Frontend (Vercel) | Production deployment | `staging` branch preview |

## Workflow

```
feature branch ──PR──▶ staging ──(auto-deploy, test)──▶ PR staging → main ──▶ production
```

Every migration runs against staging's database first (Railway's
pre-deploy `npx prisma migrate deploy`), so a migration that fails on
existing rows — like the earlier duplicate-primary-contact one — fails in
staging, not in production.

## One-time setup

### 1. Create the `staging` branch

```sh
git checkout main && git pull
git checkout -b staging
git push -u origin staging
```

CI (`.github/workflows/ci.yml`) runs on pushes to both `main` and
`staging`.

### 2. Create the Railway environment

In the Railway project: **Environments → New Environment → `staging`**,
choosing **Duplicate `production`**. Duplicating creates new instances of
every service — including a new, empty Postgres — and copies the service
variables.

Then, in the **staging** environment:

1. **App service → Settings → Source → Branch:** `staging`. (Production's
   app service stays on `main` — check it didn't change.)
2. **App service → Settings → Networking → Generate Domain.** This is the
   staging API URL, e.g. `https://fountaini-server-staging.up.railway.app`.

### 3. Check `DATABASE_URL` points at the staging database

**Do this before the first staging deploy finishes.** Open the app
service's **Variables** tab in the staging environment and look at
`DATABASE_URL`:

- `${{Postgres.DATABASE_URL}}` (a reference) is correct — references
  resolve to the Postgres in the *same* environment.
- A literal `postgresql://...` string is **wrong**: it was copied from
  production and still points at the production database. Replace it with
  the reference above.

The resolved host should be the staging Postgres's internal hostname —
compare it against the staging Postgres service's own **Connect** tab, not
production's.

### 4. Set the staging-only variables

On the staging app service (staging environment only):

| Variable | Value |
|---|---|
| `JWT_ACCESS_SECRET` | A **new** secret — never production's. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `PUBLIC_BASE_URL` | The staging domain from step 2.2 |
| `CORS_ORIGINS` | The staging frontend origins from step 6 (comma-separated, exact match — no wildcards) |
| `DOCS_ENABLED` | `true` |
| `RESEND_API_KEY` | Preferably a separate Resend API key, so staging sends are distinguishable and revocable on their own |
| `EMAIL_FROM_ADDRESS` | `Fountaini Academy (Staging) <no-reply@fountaini.academy>` |

Leave `NODE_ENV=production` and `NOTIFICATION_PROVIDER=resend` as
duplicated: staging should run the same startup checks and code paths
production does. Resend's 100/day free-tier cap is shared across keys on
the same account — demo accounts use `@example.com` addresses, so normal
staging use barely touches it.

### 5. Seed the staging database

Staging never gets a copy of production data (it's student and parent
records). It gets the demo seed instead, run from your machine against the
staging database's **public** URL:

1. Enable public networking on the **staging** Postgres and copy its
   public URL from its **Connect** tab. Check the host is the staging
   Postgres's, not production's.
2. Run, with that URL set explicitly on every command (not via `railway
   run`, so the target database is always visible in the command itself):

   ```sh
   export STAGING_DB="postgresql://...staging public url..."
   export STAGING_JWT="<staging JWT_ACCESS_SECRET>"

   DATABASE_URL=$STAGING_DB JWT_ACCESS_SECRET=$STAGING_JWT npm run db:seed
   DATABASE_URL=$STAGING_DB JWT_ACCESS_SECRET=$STAGING_JWT npm run db:seed:traits
   DATABASE_URL=$STAGING_DB JWT_ACCESS_SECRET=$STAGING_JWT npm run db:seed:demo
   DATABASE_URL=$STAGING_DB JWT_ACCESS_SECRET=$STAGING_JWT npm run preflight
   ```

3. Disable the staging Postgres's public networking again — same practice
   as `docs/go-live.md` steps 10–11.

Demo logins are in `docs/demo-credentials.md`.

### 6. Point a frontend at staging (Vercel)

In the `fountain-i-frontend` repo, create a `staging` branch too. Then, for
both Vercel projects (`portal` and `admin`), **Settings → Environment
Variables**, add these scoped to **Preview → branch `staging`** only:

- `NEXT_PUBLIC_API_BASE_URL` = the staging API URL
- `NEXT_PUBLIC_OTHER_APP_URL` / `NEXT_PUBLIC_SITE_URL` = the staging
  branch URLs of the other/same app

Vercel gives each branch a stable URL
(`<project>-git-staging-<team>.vercel.app`) — put those two origins in the
staging API's `CORS_ORIGINS`. Production-scoped variables stay untouched.

## Things to never do

- Never run `db:reset`, `db:seed:demo`, or `db:wipe:demo` without an
  explicit staging `DATABASE_URL` on the command — a `.env` or linked
  Railway environment may point at production.
- Never copy production data into staging.
- Never reuse production's `JWT_ACCESS_SECRET` or database credentials in
  staging.
- Never merge to `main` directly from a feature branch that hasn't been
  through `staging` if it includes a migration.
