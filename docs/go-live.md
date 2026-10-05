# Go-live runbook

The sequence for taking production from "freshly reset, bootstrap admin
only" to "the school is actually using it." Every command below runs
**against production** (`DATABASE_URL` pointed at Railway) unless noted
otherwise — run them yourself; nothing in this codebase, and no agent
session, should ever be given production credentials to run them for you.

`GET /api/admin/setup-status` (as an authenticated ADMIN) and `npm run
preflight` (the same checklist, from the command line, against whatever
`DATABASE_URL` you point it at) answer "what's left" at any point in this
sequence — run either one after any step below if you're not sure what's
still missing.

## ⚠️ `prisma migrate reset` is a one-way door

`npx prisma migrate reset --force` drops and rebuilds the entire schema.
It is **only safe before the first real record exists** — the moment a
real student, parent, payment, or result is in the database, this command
destroys it, irrecoverably. `npm run db:reset` chains a guard
(`db:assert-empty --allow-demo-only`) in front of the real reset
specifically so this isn't a one-line typo away from happening by
accident — but it's a habit-forming guard, not a lock: `prisma migrate
reset` still works directly, unguarded, if someone runs it that way. Once
step 1 below has happened for the last time, there should be no reason to
run either form again.

## Sequence

1. **Reset — pre-launch only.** If production still holds demo or ad-hoc
   test data (check `npm run preflight`'s "Demo data" row, or just look):
   `npm run db:wipe:demo` if it's demo-seed data from `npm run
   db:seed:demo` (see `docs/demo-credentials.md`), or `npm run db:reset`
   for anything else — it refuses unless the database is empty or every
   row traces back to the demo seed manifest. Either way, this step never
   runs again after this point.

2. **Change the bootstrap admin's password.** The bootstrap account
   (`admin@school.test` by default, or `SEED_ADMIN_EMAIL` if that was set
   when `npm run db:seed` ran) ships with a known default password
   (`ChangeMe123!` unless `SEED_ADMIN_PASSWORD` was set). Log in and
   `POST /api/auth/change-password` immediately — this account has full
   admin access until step 5 retires it.

3. **Create the academic session and terms.** `POST
   /api/academic-sessions`, then `PATCH
   /api/academic-sessions/:id/set-current`; `POST
   /api/academic-sessions/:id/terms` for each term, then `PATCH
   /api/terms/:id/set-current` for the one that's actually running.
   **Nothing else in this sequence works without a current session** —
   admission and staff numbers take their year from it (see
   `identifiers.service.ts`), and every check from here on that depends on
   "the current session" will FAIL until this step is done.

   **Run `npm run db:seed:traits` right after this step.** It seeds the
   default behaviour/skills trait lists for whichever session is current
   *at the time it runs* — it fails loudly (non-zero exit, clear message)
   if none is, rather than silently doing nothing. It's idempotent, safe
   to re-run any time a new session becomes current. Trait rows can also
   be managed individually from here on via `POST`/`PATCH .../traits/:id`
   and `POST .../traits/:id/deactivate` (see `ratings.routes.ts`) — this
   script is only for the default starting lists. Skipping this step
   leaves `GET /api/admin/setup-status`'s "Behaviour and skills traits"
   check FAILing with no obvious cause.

4. **Create the school record.** `POST /api/school` — `name`, `address`,
   `contactEmail`, `contactPhone`. **Get these from the school in
   writing, not from memory or a placeholder** — this is what's printed on
   every statement and report card the school hands out from this point
   on. A wrong address or phone number here isn't a bug to fix later,
   it's wrong paperwork already in a parent's hand.

5. **Create the real admin, retire the bootstrap one.** `POST
   /api/staff` with `role: ADMIN` and the real administrator's own email —
   this is what `GET /api/admin/setup-status`'s "Admin account" check
   looks for specifically (an ADMIN with a linked Staff record; the
   bootstrap account never has one). Once that account can log in,
   `POST /api/users/:id/deactivate` the bootstrap account. Don't delete
   it — deactivating keeps the audit trail intact and the account
   recoverable (`POST /api/users/:id/activate`) if something's wrong with
   the new one.

6. **Enter the rest of configuration.** Subjects (`POST /api/subjects`),
   classes (`POST /api/classes`), time slots (`POST /api/time-slots`),
   assessment components (`POST
   /api/academic-sessions/:id/assessment-components` — must sum to
   exactly 100), and a grading scale with bands covering 0–100 with no
   gaps or overlaps (`POST /api/academic-sessions/:id/grading-scale`,
   then `POST /api/grading-scales/:id/bands`). Then real staff, students,
   and parents.

7. **Run `npm run preflight`.** `ready: true`, no FAIL rows. Read the
   WARN rows too — they don't block, but each one is a real, specific
   thing (see the check's own `message`) worth deciding about on purpose
   rather than by accident.

8. **Rotate database credentials.** The database has been reachable via
   Railway's public proxy throughout this sequence (for `npm run
   db:seed`/`db:seed:demo`/`db:wipe:demo`/`preflight`/`db:reset`, all run
   from outside Railway). Rotate the Postgres password in Railway's
   dashboard now that setup is done, and update `DATABASE_URL` in the
   app service's own environment to match — the deployed app itself
   always uses the **internal** URL (see `README.md`'s "Database URL:
   internal, not public"), so this doesn't touch app traffic at all.

9. **Close the public proxy.** Once step 8 is done, nothing legitimate
   needs public access to the database anymore — the app uses the
   internal network, and setup is finished. Disable the Postgres
   service's public networking in Railway's dashboard. (If a future admin
   genuinely needs direct DB access again, re-enable it, do the thing,
   disable it again — not leave it open indefinitely "in case.")

## Onboarding pace, given the email cap

The notification provider (Resend, on its free tier) caps outbound email
at 100/day, and nothing in this codebase currently queues, retries, or
paces sends against that cap — see `GET /api/notifications/deliveries`
for whichever ones fail once the cap is hit on a given day, and `POST
/api/users/:id/reissue-credentials` (or the student-specific
`POST /api/students/:id/reissue-credentials`) to resend any of them
individually once the cap has reset.

For a batch larger than ~100 accounts (e.g. onboarding every parent at
once), **stagger account creation across days** rather than creating all
of them at once and discovering the back ~300 failed silently. There's no
built-in scheduler to do this automatically yet — see the engineering
report on cap-aware sending for what that would cost, and why staggering
by hand is very likely still the cheaper option for a single school's
onboarding.

After each day's batch, check `GET /api/users/pending-activation` — every
row still there with `latestCredentialDeliveryStatus: "FAILED"` is an
account nobody can get into yet; reissue those first before creating the
next batch. `latestCredentialDeliveryErrorCategory` tells you whether to
just wait (`QUOTA_EXCEEDED`/`RATE_LIMITED` — the cap will reset) or act
now (`INVALID_RECIPIENT` — the address itself is wrong; fix it with
`PATCH /api/users/:id/email`, which also reissues automatically). Rows
with `credentialExpired: true` need a fresh reissue regardless of
delivery status — their 7-day window ran out before anyone signed in.
