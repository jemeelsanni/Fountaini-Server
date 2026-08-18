import { prisma } from "../db/client.js";

const SAFE_TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/// Polls pg_locks (via the module-level `prisma` client — a separate
/// connection from whatever transaction is holding the lock being waited
/// on) until at least `count` backends are blocked waiting on some lock.
/// Not filtered by relation/table: a session blocked on a row lock waits on
/// the blocking transaction's XID (locktype 'transactionid'), which
/// carries no relation at all — only 'relation'/'tuple' locktypes do. Safe
/// to check "any ungranted lock" unfiltered because every test DB in this
/// suite is exclusively used by one single-process test run; nothing else
/// is ever mid-transaction.
async function pollForLockWaiters(count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM pg_locks WHERE NOT granted
    `;
    if (Number(rows[0]?.count ?? 0) >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} lock waiter(s)`);
}

/// Deterministically forces a specific interleaving between two operations
/// racing to write the same row, instead of guessing at wall-clock timing —
/// a fixed delay doesn't reliably preserve firing order, since
/// request-dispatch overhead (however many reads a service does before its
/// write) varies between the two operations and even between runs of the
/// same operation under load.
///
/// Holds a real `SELECT ... FOR UPDATE` lock on `table`'s row `id`, invokes
/// `first`, confirms (via pg_locks polling, not a delay) that it's actually
/// blocked and queued waiting for the lock, invokes `second`, confirms it's
/// ALSO queued (behind `first`), then releases the lock. Postgres grants
/// the lock to whichever queued first — `first`, confirmed queued before
/// `second` was even invoked — lets it run to completion and commit, then
/// grants it to `second`.
///
/// Usage:
/// ```ts
/// const [finalizeResult, computeResults] = await awaitLockWaiter(
///   "Result", resultId,
///   () => finalizeResult(resultId, actorUserId),
///   () => computeResultsForClass({ classId, termId }),
/// );
/// ```
///
/// `table` must be a plain identifier (letters/digits/underscore, starting
/// with a letter) — it's interpolated into the lock query directly since
/// Postgres doesn't allow parameterizing identifiers, so this guards against
/// misuse even though callers are always test code, never external input.
export async function awaitLockWaiter<T1, T2>(
  table: string,
  id: string,
  first: () => Promise<T1>,
  second: () => Promise<T2>,
  timeoutMs = 2000,
): Promise<[T1, T2]> {
  if (!SAFE_TABLE_NAME.test(table)) {
    throw new Error(`awaitLockWaiter: "${table}" is not a valid table identifier`);
  }

  return prisma
    .$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);

      const firstPromise = first();
      await pollForLockWaiters(1, timeoutMs);

      const secondPromise = second();
      await pollForLockWaiters(2, timeoutMs);

      return [firstPromise, secondPromise] as const;
    })
    .then((promises) => Promise.all(promises));
}
