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
| `fees.service.ts` `generateObligations()` | Concurrent (or double-clicked) obligation generation for the same fee structure — `createMany` aborting the whole batch on the first collision | `skipDuplicates: true`. **Known gap**: this relies on the unique constraint on `(studentId, feeStructureId, termId)`, and Postgres never treats `NULL == NULL` for uniqueness — a session-wide fee structure (`termId: null`, a real, documented case) is *not* protected by this fix. Confirmed empirically. Not fixed — see below. |
| `parents.service.ts` `unlinkChild()`, `academic-structure.service.ts` `deleteClassSubjectAssignment()` | Concurrent double-unlink/double-delete — `delete({ where: { id } })` throwing P2025 unhandled once the row's already gone | `deleteMany({ where })` + check `count`, instead of `findUnique` then `delete` |
| `academic-structure.service.ts` `setCurrentAcademicSession()` / `setCurrentTerm()` | 3-or-more concurrent switches to different targets could leave more than one row `isCurrent` | See below — this one had a real surprise. |

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
