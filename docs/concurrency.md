# Concurrency: the read-then-write-outside-transaction shape

This document exists so the next person who touches a service function
recognizes this bug shape on sight, knows what's already been fixed, what's
still open, and how to test a fix once they've made one.

## The shape

```ts
// BUGGY SHAPE
const thing = await prisma.thing.findUnique({ where: { id } });
if (thing.status === "LOCKED") {
  throw AppError.conflict("...");
}
// <-- a concurrent request can commit a status change here, and this
//     function has no way of knowing —
await prisma.thing.update({ where: { id }, data: { ...whatever } });
```

The read that decides whether a write is safe happens **outside** (or
before, in time, even if textually inside) the transaction that performs the
write, and the write's own `WHERE` clause doesn't re-check the condition. If
another request changes the row's state in the gap between the read and the
write, the write still goes through — the DB has no way to refuse it, because
nothing in the write says "only if this is still true."

Two distinct failure modes fall out of this, and they matter differently:

- **Silent corruption**: the write succeeds, but on data that's no longer
  valid to write to — e.g. overwriting a score after it's been submitted, or
  a result after it's been finalized. The caller gets a 200 and has no idea
  anything went wrong. This is the dangerous one.
- **Unhandled constraint violation**: the write collides with a unique
  constraint or targets an already-deleted row, and the resulting Postgres
  error (P2002/P2025) propagates as a raw 500 instead of the clean 409/404
  the same situation would get via the sequential path. Not corruption —
  just an ugly, avoidable error under load.

### The fix, in general

1. Move the read inside the same transaction as the write, so they're at
   least logically one operation.
2. **This alone is usually not enough.** Under Postgres's default READ
   COMMITTED isolation (confirmed live on this project's DB — see below),
   each statement in a transaction gets its own fresh snapshot. Make the
   write's own `WHERE` clause re-check the condition
   (`status: { not: "SUBMITTED" }`, etc.) so the database refuses the write
   outright if the condition's no longer true — not just app logic hoping
   the read was recent enough.
3. For a plain existence/uniqueness pre-check followed by `.create()`: either
   wrap the `.create()` in `try/catch` for `P2002` and translate it to the
   same conflict the pre-check throws, or use `createMany({ skipDuplicates:
   true })` if you're creating a batch.
4. For a plain existence pre-check followed by `.delete()`: use
   `deleteMany({ where })` and check the returned `count`, instead of
   `findUnique` then `delete({ where: { id } })` — `deleteMany` never throws
   on zero matches, `delete` does (P2025).
5. If a status-conditional `updateMany` can be used to "claim" a row
   (`updateMany({ where: { id, status: "PENDING" }, data: {...} })`, check
   `count === 0` to detect a lost race), that's usually the cleanest —
   see `auth.service.ts`'s `refresh()`, the original example of this pattern
   in the codebase, predating any of the fixes below.

Confirmed live on this project's Postgres instance: `SHOW
default_transaction_isolation` → `read committed`. No `$transaction` call
anywhere in this codebase overrides it. That's not a gap to fix — it's the
reason step 2 above is load-bearing, not optional.

### A trap specific to this codebase: interactive transactions poison on error

Moving a `create()` + `catch(P2002)` recovery pattern inside a
`prisma.$transaction(async (tx) => {...})` breaks it. A failed statement
inside a Postgres transaction poisons the *whole* transaction (`25P02
current transaction is aborted`) until it rolls back — so the "recovery"
read right after the caught error fails too. Discovered while fixing
`scan()`; the fix is `createMany({ skipDuplicates: true })` followed by an
*unconditional* read, never `create()` + `catch`, for anything running
inside an interactive transaction.

## Fixes applied

| Where | What raced | Fix |
|---|---|---|
| `attendance.service.ts` `scan()` / `closeSession()` | A scan and a close on the same session — close's unprotected reads let it write an ABSENT record after a scan had already gone in, or vice versa | `SELECT ... FOR UPDATE` on the `AttendanceSession` row, taken first thing in both functions' transactions; `createMany({ skipDuplicates: true })` instead of `create()` + catch (the poisoning trap above) |
| `attendance.service.ts` `rotateQrCode()` | Two concurrent rotations both seeing "no active code" and both creating one | Partial unique index `StudentQrCode_one_active_per_student` on `("studentId") WHERE "isActive"`; read moved inside the transaction (necessary for correctness, not sufficient alone — the index is what actually stops it) |
| `results.service.ts` `computeResultsForClass()` / `finalizeResult()` | A recompute and a finalize on the same result — recompute's stale read of "not finalized yet" let it silently overwrite a just-finalized result's scores while leaving status FINALIZED | Existing-results read moved inside the transaction; each write is `updateMany({ status: { not: "FINALIZED" } })`, not a plain `upsert()` |
| `fees.service.ts` `confirmPayment()` / `rejectPayment()` | Two concurrent confirms (or a confirm racing a reject) on the same payment — the loser hit Receipt's unique constraint on `paymentId` as an unhandled 500 | Conditional-claim `updateMany({ where: { id, status: "PENDING" } })`, `count === 0` → clean 409; `rejectPayment` mirrors `confirmPayment` exactly |
| `scores.service.ts` `bulkUpsertScores()` | A bulk score edit racing `submitScores()` — the edit's stale "not submitted yet" read let it silently overwrite a Score row after submission, leaving the already-computed `SubjectResult.totalScore` stale relative to the Score sheet | `alreadySubmitted` check and the per-cell writes moved inside one transaction; each cell's write is `updateMany({ status: { not: "SUBMITTED" } })`; a lost race throws the same conflict the whole batch already used, rather than silently applying every other entry |
| `admissions.service.ts` `convertEnquiry()` | Two concurrent converts of the same enquiry — both passing the "not converted yet" read and both creating a Student | Conditional-claim `updateMany({ where: { id, status: { not: "CONVERTED" } } })` inside the same transaction as the `Student` creation — a lost race rolls back the whole transaction, so the loser's Student row never persists |
| `users.service.ts` `createUser()`, `parents.service.ts` `createParent()` | Concurrent duplicate signups/links — the pre-check passing for both, second `.create()` hitting the unique constraint unhandled | `try/catch` around `.create()`, `P2002` → the same conflict the pre-check throws |
| `identifiers.service.ts` `generateAdmissionNumber()` / `generateStaffNumber()` | Two admins creating a student/staff member at the same instant — reading the current max sequence and adding one is exactly this doc's title | Not a conditional claim on the target row (there's no pre-existing row to claim) — see below, this one's a genuinely different shape. |
| `students.service.ts` `issueLoginForStudent()` | Two concurrent `issueLogin` calls for the same never-logged-in-yet student — both can pass the "userId is still null" pre-check and both attempt to create a `User` with the same `loginId` (the student's `admissionNumber` hasn't changed between them) | Conditional-claim `updateMany({ where: { id, userId: null } })` for the common case, **plus** a `try/catch` on `User.loginId`'s own unique constraint for the case where both racers get past the pre-check and collide on the `User.create()` itself, before either ever reaches the `updateMany` |
| `fees.service.ts` `generateObligations()` | Concurrent (or double-clicked) obligation generation for the same fee structure — `createMany` aborting the whole batch on the first collision | `skipDuplicates: true`. **Known gap**: this relies on the unique constraint on `(studentId, feeStructureId, termId)`, and Postgres never treats `NULL == NULL` for uniqueness — a session-wide fee structure (`termId: null`, a real, documented case) is *not* protected by this fix. Confirmed empirically. Not fixed — see below. |
| `parents.service.ts` `unlinkChild()`, `academic-structure.service.ts` `deleteClassSubjectAssignment()` | Concurrent double-unlink/double-delete — `delete({ where: { id } })` throwing P2025 unhandled once the row's already gone | `deleteMany({ where })` + check `count`, instead of `findUnique` then `delete` |
| `academic-structure.service.ts` `setCurrentAcademicSession()` / `setCurrentTerm()` | 3-or-more concurrent switches to different targets could leave more than one row `isCurrent` | See below — this one had a real surprise. |

### A different shape: race-safe sequence generation

Every other fix in the table above is a variant of "claim a row that
already exists, conditionally." Admission/staff number generation has no
row to claim — there's nothing to check "is this still true" against
before the write, because the number doesn't exist until this call creates
it. Reading `MAX(sequence)` and adding one is the read-then-write shape
this whole document exists to warn about, just without an existing target
row to make the write conditional on.

The fix (`identifiers.service.ts`): one atomic upsert-increment per
prefix-and-year, inside the same transaction as the `Student`/`Staff`
insert:

```sql
INSERT INTO "IdentifierCounter" ("prefix", "lastValue")
VALUES ($1, 1)
ON CONFLICT ("prefix") DO UPDATE SET "lastValue" = "IdentifierCounter"."lastValue" + 1
RETURNING "lastValue"
```

`INSERT ... ON CONFLICT ... DO UPDATE` handles "this prefix has never been
used" and "this prefix already has a counter" in the same statement, so
there's no separate existence check to race on — and the row this touches
(existing or newly inserted) is locked for the rest of the transaction,
which is what actually serializes two concurrent callers for the *same*
prefix into two different numbers rather than a shared one.

**The test that matters here is a 2-racer trap in the other direction.**
Every other fix in this document is tested with a *forced* interleaving
(`awaitLockWaiter`, below) — proving one specific bad ordering is now
impossible. That's the wrong shape for this fix: there's no "bad ordering"
to force, since every ordering should produce distinct numbers. A 2-racer
`Promise.all` test can pass by luck even against a broken read-then-write
implementation (only one of the two ever actually contends for the same
value in a 2-way race often enough to go undetected), which is exactly what
happened once already in this codebase (see the `isCurrent` lesson below —
the same "too few racers, passed by luck" shape). The batch that introduced
this fix used a 4-concurrent-creations test instead
(`students.test.ts`) — plain, unforced `Promise.all`, asserting all four
resulting numbers are distinct. More racers, not a forced order, is the
right shape when you're proving "no collision under contention," as
opposed to "no corruption under one specific bad interleaving."

### The `isCurrent` fix is not what it looks like at first

`setCurrentAcademicSession`/`setCurrentTerm` already wrapped "clear every
other row, then set mine" in one transaction, before any of this round's
work. That looked safe, and a 2-concurrent-caller test passed reliably
against the unmodified code. **It wasn't safe** — it just took more than two
concurrent callers to expose it reliably, which is exactly the kind of gap
that survives in production for a long time before anyone notices.

The actual bug: `updateMany`'s candidate rows are fixed by the snapshot it
takes *before* it blocks on a row lock. If it blocks waiting for the
previously-current row and only unblocks after a *different* concurrent
switch has already committed a new current row, it never re-scans to catch
that new row — it only re-checks the specific row it was already waiting on.
With 4 concurrent switches to 4 different targets (starting from one
current row), this reliably left 3 rows marked current. With 2, it usually
didn't reproduce, purely by luck of scheduling.

The fix layers two things:
- A transaction-scoped advisory lock (`pg_advisory_xact_lock`, keyed by
  session id for terms so different sessions don't serialize against each
  other) fully serializes the "clear then set" sequence, closing the actual
  race.
- Partial unique indexes — `AcademicSession_one_current` on `("isCurrent")
  WHERE "isCurrent"`, `Term_one_current_per_session` on
  `("academicSessionId") WHERE "isCurrent"` — are the DB-level backstop
  against any future code path that bypasses these two functions entirely.

Migration: `add_current_session_term_partial_indexes`.

**Lesson for next time**: a concurrency test with only 2 racers proved
nothing here. If you're testing a "clear siblings, then set self" pattern,
use at least 3–4 concurrent callers, or you may just be testing scheduler
luck.

## The `awaitLockWaiter` test helper

`src/test/awaitLockWaiter.ts`. Use it whenever a concurrency test needs a
*specific* interleaving between two operations racing to write the same
row, rather than "fire both and see what happens."

Why it exists: firing two operations via plain `Promise.all` does not
reliably preserve which one's write reaches Postgres first. Request-dispatch
overhead (how many reads a service does before its write, Express
middleware, JWT verification) varies enough between two different
operations — and even between two runs of the *same* operation under load —
that a naive race often always resolves the same (uninteresting) way, or
resolves differently between the "buggy" and "fixed" code paths for reasons
that have nothing to do with the fix. Wall-clock `setTimeout` staggering
doesn't reliably fix this either — the *amount* of stagger needed to land
inside the vulnerable window shifts depending on how fast the code path
under test happens to run.

What it actually does: holds a real `SELECT ... FOR UPDATE` lock on a named
row, invokes your first operation (without awaiting it) and confirms — via
polling `pg_locks`, not a guessed delay — that it's genuinely blocked and
queued waiting for that lock, invokes your second operation and confirms
*it's* also queued, then releases the lock. Postgres's lock queue grants it
to whichever queued first, so your first operation is guaranteed to run to
completion and commit before your second operation's write proceeds.

```ts
const [finalizeOutcome, computeOutcome] = await awaitLockWaiter(
  "Result",
  resultId,
  () => finalizeResult(resultId, actorUserId),
  () => computeResultsForClass({ classId, termId }),
);
```

Call the service functions directly rather than through HTTP when using
this helper — going through Express/supertest adds enough dispatch overhead
and variance that even the `pg_locks`-confirmed approach becomes harder to
reason about. There's nothing HTTP-specific about the race itself.

Not every concurrency test needs this. If the two racing calls are
structurally symmetric (same shape, same cost — e.g. two identical
`convertEnquiry` calls, or two identical signups) and you don't care which
one wins, plain `Promise.all` is simpler and was empirically reliable (5/5)
for those cases. Reach for `awaitLockWaiter` when the two operations are
asymmetric in cost (a 2-query operation racing a 6-query one) or when you
specifically need operation A's write to have committed before operation
B's write is attempted.

## Known, consciously unfixed

- **`staff.service.ts` `createStaff()`, `students.service.ts`
  `createStudent()`**: both do an existence/role pre-check, then
  `.create()` wrapped in a `try/catch` that already catches `P2002` — so a
  concurrent race *is* caught, not left as an unhandled 500. The gap is
  cosmetic: the catch block always attributes the conflict to the
  staff-number/admission-number uniqueness, even on the rare race where it
  was actually the `userId`-already-linked constraint that fired. Wrong
  error message, not wrong behavior.
- **`fees.service.ts` `generateObligations()` + session-wide fee
  structures**: `skipDuplicates: true` (this round's fix) relies on the
  unique constraint on `(studentId, feeStructureId, termId)`. Postgres
  never treats `NULL` as equal to `NULL` for uniqueness, so a fee structure
  with `termId: null` (a real, documented "session-wide" case — see the
  model comment) is not protected by this constraint at all: two concurrent
  generates can create two obligations for the same student. Confirmed
  empirically while writing this round's test — the test now deliberately
  uses a term-scoped fee structure to exercise what the fix does cover, and
  this gap is intentionally left open rather than expanding scope into an
  expression-based partial unique index (`COALESCE(termId, '')`), which
  would need its own migration and design decision.
- **`notifications.service.ts` `triggerFeeReminders()`**: reads obligations,
  then sends reminders in a loop with no transaction at all. A double-fire
  (e.g. two admins triggering it around the same time) could send a
  duplicate reminder to the same parent. Not corruption — no data is wrong
  afterward — just a possible duplicate notification. Not fixed; lower
  priority than everything above.

If you find another instance of the shape, add it to this list rather than
fixing it inline unless you've been explicitly asked to fix it — the
pattern above should make it easy to recognize, but recognizing it and
deciding it's worth fixing right now are different calls, and the second
one belongs to whoever's prioritizing the work.

## Known intermittent test failure

**Symptom**: occasional `Test timed out in 5000ms` (Vitest's default
`testTimeout`) on a handful of tests — seen on
`academic-structure.test.ts`'s form-teacher-list test,
`authMatrix.test.ts`'s `PATCH /api/terms/:id/set-current` and
`GET /api/admission-enquiries` rows, and `admissions.test.ts`'s own
convert-enquiry concurrency test — plus, separately, occasional malformed
HTTP responses: a raw `Parse Error: Expected HTTP/` from supertest, and
responses whose JSON body is shaped like a foreign API's error envelope
(`{"type":"error","error":{"type":"authentication_error","message":"Invalid
authentication"},"request_id":null}` — a string that appears nowhere in
this codebase or its dependencies). None of this is deterministic; it did
not reproduce on every run.

**2026-08-27 addition**: the same class reproduced repeatedly during a
session of local runs against a Docker-containerized Postgres (see the
version-mismatch entry below for why local Postgres was containerized at
all) — on `authMatrix.test.ts`'s `GET /api/class-form-teachers` and
`DELETE /api/class-form-teachers/:id` rows (the exact
`{"type":"error","error":{"type":"authentication_error",...}}` envelope
again), and on `attendance.test.ts`'s "scan/close concurrency" test, which
hit three different outcomes across three consecutive local attempts on an
otherwise-unchanged setup: a `Test timed out in 120000ms` (its own longer
configured timeout, not the 5000ms default) inside a full-suite run, a fast
`Parse Error: Expected HTTP/` on an immediate isolated re-run, and a clean
pass on a second isolated re-run. That same test also timed out at 120s
identically against a Postgres 17 container before the version was
corrected to 16 — i.e. it failed on both major versions, in different ways,
and also passed on 16 — which argues against Postgres major version being
the explanation for this specific test's instability. Raw counts for
anyone extending this tally later: 2 full local-suite runs on
`postgres:16` this session, 1/2 clean; 1 full run on a `postgres:17`
container beforehand, also 1 failure. Small sample, not a rate — noted here
because it's a real local observation, not because it's conclusive.

**Ruled out**: cross-file lock contention. `vitest.config.ts` pins
`fileParallelism: false` + `maxWorkers: 1` + `pool: "forks"`, and this was
confirmed live, not just read off the config — sampling the process tree
with `ps` during a run showed exactly one `forks.js` worker process alive
at any instant, with a new PID replacing the old one between files. Each
file runs in its own OS process; a process exit closes every Postgres
connection it held, which releases every lock and transaction that
connection held, before the next file's process even starts. Two test
files cannot contend for the same lock under this configuration — not
"rarely," structurally cannot.

**Explicitly NOT the cause**: real Postgres lock waits — genuine
`transactionid`/`ShareLock` entries in `pg_locks` — were captured live via a
poller running throughout a ~15-minute back-to-back stress run. Every one
of them traced to `results.test.ts`'s own "compute/finalize concurrency"
test, which deliberately holds a `SELECT ... FOR UPDATE` lock via
`awaitLockWaiter` and confirms `finalizeResult()`/`computeResultsForClass()`
queue behind it on purpose (see "The `awaitLockWaiter` test helper" above).
That test calls the service functions directly, not through HTTP, and
never touches another file. Given the no-parallelism finding above, those
lock waits **cannot** have blocked a test in a different file — they were
coincident in time during a long stress run, not causal. Stating this
plainly so nobody re-derives "it must be the lock waits" from the raw
`pg_locks` capture later: the capture is real, the causal link to the
timeouts is not.

**Cause**: unknown. Measured at ~20% of full-suite runs failing (9/40),
under a back-to-back 40-run stress loop (two batches of 20) with an
additional `psql` poller querying `pg_stat_activity`/`pg_locks` every
250ms throughout the second batch. That methodology — continuous
back-to-back runs for ~30 minutes total, plus extra polling load competing
for the same CPU and Postgres connections — likely inflates the failure
rate well above what a normal single `npm test` invocation would show; the
second, more heavily-loaded batch did fail more often (5/20 vs 4/20) than
the first. A single normal-usage run can still hit it — one did, on an
unrelated file, while verifying the argon2 change below — so it's not
purely an artifact of the stress methodology, just likely overstated by it.

**First CI measurement**: run
[32315338456](https://github.com/jemeelsanni/Fountaini-Server/actions/runs/32315338456)
(commit `5f4f429`, 2026-08-19) — both the "Run tests (1st pass)" and "Run
tests (2nd pass)" steps passed cleanly, 0/2 hit the timeout. This is one
data point, not a rate: two suite executions on GitHub's neutral hardware
isn't enough to distinguish "the flake is rare" from "the flake didn't fire
this time," especially against a ~20%-under-stress estimate that was itself
called out as likely inflated by that stress methodology. Treat this as the
first entry in an ongoing tally, not a resolution — update this line with
each subsequent CI run's outcome (pass/fail on each of the two steps) until
enough runs have accumulated to state a real rate. Do not re-measure locally
by running the suite in a loop — that reproduces the same confound this
entry exists to flag, not a cleaner number.

**2026-09-18 addition**: while adding requireAuth's new mustChangePassword
check (one extra DB round-trip on every authenticated request — see
"Fixes applied" is not the right section for this, it's not a race fix,
just noted here because of what it looked like at first), a 3-run
before/after comparison on `authMatrix.test.ts` alone (3/3 clean without
the check, 1/3 timing out with it) briefly looked like a new, attributable
regression. It wasn't distinguishable from this entry's own already-
documented ~20%-of-runs rate at that sample size — a later 5-run batch
with the check in place produced a `Parse Error: Expected HTTP/` on a
completely different row (`POST /api/admission-enquiries/:id/convert`),
the exact symptom already on file above, not a timeout at all. Recorded
here rather than claimed as a fix: `testTimeout` was still raised to
10,000ms (vitest.config.ts) on the grounds that the added per-request cost
is real regardless of this specific flake's cause, but that change should
not be read as resolving — or even being confirmed to affect — this entry.

**2026-09-19 measurement**: the 2026-09-18 entry above left two things open
— an actual number for the added per-request cost, and whether the 10s
`testTimeout` raise is still doing anything. Both resolved this session.

Cost: a throwaway benchmark script ran the exact isolated query
(`prisma.user.findUnique({where:{id}, select:{mustChangePassword:true}})`)
300 times (30-iteration warmup first), twice independently. Run 1: avg
0.296ms, p50 0.254ms, p95 0.460ms, p99 1.088ms, max 4.411ms. Run 2: avg
0.324ms, p50 0.274ms, p95 0.534ms, p99 2.282ms, max 4.013ms. Consistent
~0.3ms avg, sub-millisecond at p95 both times — confirms this was never a
plausible cause of a 5000ms→10000ms-shaped problem; the 2026-09-18 entry's
"real regardless" framing was correct that the cost is real, but it's real
and negligible, not real and load-bearing.

`testTimeout`: briefly reverted to Vitest's 5000ms default to test whether
10s was still buying anything, then ran the full suite 3x at the default.
Two of three runs hit the already-documented flake in its non-timeout forms
(a `socket hang up` on `timetable.test.ts`'s double-booking test in one
standalone run; a `Parse Error`-adjacent failure on
`authMatrix.test.ts`'s `POST /api/students/:id/qr-code/rotate` row in
another) — consistent with everything already on file above. The third
produced a genuine `Test timed out in 5000ms` on
`fees.test.ts`'s "a rejected payment does not count toward the balance"
test — notable specifically because that's neither `authMatrix.test.ts`
nor auth-heavy, i.e. this is the same general, unexplained, cross-file flake
as everything else in this section, not something specific to the routes
the 2026-09-18 entry happened to be watching. Restored `testTimeout: 10_000`
on this direct evidence, not the mustChangePassword cost: a 3-run sample is
still small (same caveat as every other tally in this section), but it's a
real, fresh before/after showing the default is reachable by this flake and
10s gives it more room. Not claimed as a fix for the flake's cause — same
posture as 2026-09-18 — just a measured, now better-justified reason to
keep the higher number than "the cost is real" was.

Separately, unrelated to `testTimeout` entirely: `notifications.test.ts`'s
fee-reminder-trigger test failed on every one of these local runs with a
live Resend API `429 daily_quota_exceeded` — this test's local/CI
environment is apparently sending real email through a rate-limited
provider rather than a mock, and today's quota was already spent before
these runs started. Noted here only so it isn't mistaken for a new instance
of the flake above (it is not — the failure mode, `error.name`, and status
code are all specific to Resend, not to anything in this document) or
attributed to anything changed this session.

**2026-09-19 fix — the Resend quota hit above was a real leak, not a test
config choice**: investigated further rather than left as a "different
question." Root cause: `src/config/env.ts`'s own `import "dotenv/config"`
loads `.env` (this developer's real local file, with `NOTIFICATION_PROVIDER
=resend` and a real `RESEND_API_KEY`) from cwd as a side effect of
`env.ts` itself being imported — which happens *after* `vitest.setup.ts`'s
explicit `.env.test.local`/`.env.test` loads, but dotenv never overwrites an
already-set var, and neither test env file defined `NOTIFICATION_PROVIDER`
or `RESEND_API_KEY` before this fix. So every test run was silently sending
real email through a real, rate-limited vendor — not a mocking question,
an environment leak with a specific, findable cause. Fixed by adding
`NOTIFICATION_PROVIDER=console` explicitly to `.env.test` (committed,
portable) — dotenv's already-set-wins behavior then makes that value win
outright over whatever `.env` says, closing the leak for that one variable.
`RESEND_API_KEY` is left leaking harmlessly (unused once the provider is
console) rather than also scrubbed — not worth a second variable's worth of
defense-in-depth for a value that's already inert.

**2026-09-19 fix — that leak was also masking a second, real, fixable bug**:
switching test runs to the console provider (near-instant, always succeeds)
immediately surfaced a `Foreign key constraint violated on the constraint:
NotificationDelivery_notificationEventId_fkey` on `parents.test.ts`'s new
(this-session) "rejects a duplicate email with 409" test. Same family as
concurrency500Cluster.test.ts's documented races and this file's own
"interactive transactions poison on error" trap: `notifications.service.ts`
's `createNotification()` does `notificationEvent.create()` then, per
channel, a separate `notificationDelivery.create()` — two round-trips, not
one transaction. A test that triggers a fire-and-forget `createNotification`
call (parent/staff/user credential issuance, payment confirmation) and
doesn't wait for it before finishing can let the `NotificationDelivery`
insert land *after* the next test's `resetDb()` has already deleted the
`NotificationEvent` row it points at — an INSERT racing a DELETE, the mirror
image of the User/NotificationEvent race fixed earlier in the
`id-based-login-and-credentials` branch's own parents.test.ts work. Slower,
more variable real-Resend latency had apparently been landing outside this
window often enough not to be caught; the console provider's speed and
consistency made it reproducible almost immediately. Found and fixed four
more unawaited sites the same way (added a `waitForNotification(...)` drain
right after the triggering call): `parents.test.ts`'s two new atomic-create
tests, `users.test.ts`'s two successful `POST /api/users` creates,
`staff.test.ts`'s two successful `POST /api/staff` creates, and
`results.test.ts`'s shared `confirmPayment` withholding-test helper (the
only `fees.test.ts`-style payment-confirm call site in the whole suite
whose student actually has a linked parent — `fees.test.ts`'s own confirm
tests all use bare students with no linked parent, so `notifyPaymentConfirmed`
loops zero times there and never creates a notification to race in the
first place; checked directly rather than assumed, since it's exactly the
kind of thing worth getting wrong). 5 consecutive full-suite runs after
these fixes produced zero further `NotificationDelivery`/`NotificationEvent`
FK errors — the remaining failures across those runs were the ordinary,
already-documented flake above (socket hang up, `Parse Error: Expected
HTTP/`, one occasional hard timeout), on a different file each time, never
the FK signature. Not claimed as new instances of this fixed race; recorded
as more of the same pre-existing unknown-cause flake this section already
tracks.

**2026-09-19 fix — closed structurally, not just at the five known sites**:
the "no structural guard" gap this entry originally ended on is now closed
two ways.

Production correctness fix: `createNotification()`'s `notificationEvent.
create()` and every channel's `notificationDelivery.create()` (the PENDING
placeholder rows) now run in one `$transaction` — either the event and all
its delivery rows exist, or none do. This was a real gap independent of any
test: a crash between the two writes left an event the system believed was
delivered, with no delivery record for it at all. The actual send (network
I/O, per channel) deliberately stays outside that transaction — holding a
DB transaction open for the duration of an external HTTP call is its own
anti-pattern, and a crash mid-send now just leaves an existing row at
PENDING rather than erasing it. As a side effect, this also shrinks the test
race's window to just the send/update phase, which is now near-instant
against the console provider.

Structural test-infra fix, for that remaining window and for every *future*
call site: every fire-and-forget write in this codebase (the five sites
above, plus `auditMutation.ts`'s own fire-and-forget `writeAuditLog`, which
has the identical shape and was never audited for this specific race before
now) goes through a new `fireAndForget()` wrapper
(`src/lib/fireAndForget.ts`) instead of a hand-rolled `.catch(logger.error)`
or bare `void`. Same runtime behavior in production — it doesn't await
anything, doesn't change latency or error handling — but it now also tracks
the in-flight promise, and `resetDb()` calls the paired `drainFireAndForget
()` before touching any table. A leftover write from the *previous* test
can no longer land mid-truncate, structurally, without any test author
needing to remember a per-call-site `waitForNotification()` drain — that
helper still exists and is still used where a test wants to assert on a
notification's actual *content*, which is a different job. The five
`waitForNotification()` drains added earlier this session are now
redundant for race-prevention specifically (`resetDb()` covers that
generally) but were left in place rather than stripped back out — several
double as the content assertions just described, and removing the rest
would have been churn for no correctness gain.

## attendance.test.ts scan/close: folded into the known flake above, not separate

An earlier version of this entry treated the "scan/close concurrency"
timeout as a second, distinct, unexplained failure and speculated it might
be caused by Docker/virtualization overhead. That was premature — retracted
here rather than left to mislead the next reader. Once the local Postgres
version was corrected from 17 to 16 (see below) and the test was re-run
several more times, it produced a *different* failure mode each time (a
120s timeout, a fast `Parse Error: Expected HTTP/`, and a clean pass, across
three consecutive local attempts — see the 2026-08-27 addition to the
"Known intermittent test failure" section above), and separate,
unrelated `authMatrix.test.ts` rows failed with the exact JSON envelope
that section already documents. That's the signature of the *same*
pre-existing, unexplained, load-sensitive flake landing on a different
sampling of tests this session — not a new, deterministic, Docker- or
version-specific bug. Do not record "virtualization I/O overhead" or any
other specific cause here without direct evidence for it; there isn't any
yet.

## Local Postgres major-version mismatch (2026-08-27, corrected same day)

`docker-compose.yml` and `.github/workflows/ci.yml` both pin `postgres:16`.
A local container stood up this session to work around the port-5432
conflict above was launched intending `postgres:16` but was actually
running **17.11** (`SELECT version()` confirmed it directly) — the image
tag wasn't verified before use. Corrected the same session: the container
was rebuilt on `postgres:16` (confirmed via `SELECT version()` →
`PostgreSQL 16.15`), migrations re-applied, and the full suite re-run
against it.

This matters specifically because this codebase leans on Postgres advisory
locks (`pg_advisory_xact_lock`/`hashtext`, e.g.
`setCurrentAcademicSession`, `createSchool`) and partial unique indexes
(`add_qr_code_one_active_partial_index`,
`add_current_session_term_partial_indexes`) — exactly the kind of surface
where a major-version difference could plausibly matter without showing up
as an obvious test failure, even though nothing this session's testing
surfaced pointed at that specific mechanism (see the flake entry above).

**Production's version was not confirmed as part of this fix.** Local now
matches CI at 16, but Railway's Postgres plugin version is unknown — if it
differs, the mismatch has moved rather than closed, and production is the
instance that actually matters for real users hitting these code paths.
Concretely, until confirmed: don't treat a local or CI pass on
`setCurrentAcademicSession`, `createSchool`, or anything exercising the two
partial unique indexes above as proof the same behavior holds in
production. The specific risk isn't a known correctness bug (nothing
currently documents 16-vs-17 changing advisory-lock or partial-index
semantics) — it's that this is exactly the kind of low-level locking/index
surface where an undocumented or edge-case behavioral difference between
major versions could exist and wouldn't necessarily announce itself as a
loud failure. Check Railway's dashboard (Postgres plugin → version) or
`SELECT version()` via `railway connect postgres`, and update this entry
with the result.
