/// Every background write in this codebase (credential-issuance
/// notifications, payment-confirmation notifications, audit log entries)
/// is intentionally detached from its caller's response — a slow or
/// failing side effect must never delay or fail an otherwise-successful
/// request. Before this module existed, each call site hand-rolled that as
/// `somePromise.catch((err) => logger.error(...))` or `void someAsyncFn()`,
/// with nothing tracking the in-flight promise anywhere. That's exactly
/// what let five call sites independently develop the same latent race
/// with resetDb() (see docs/concurrency.md's 2026-09-19 entries): a test
/// triggers one of these without waiting for it, and the write can land
/// after the *next* test has already started truncating tables, tripping
/// an FK the two were never supposed to be able to race.
///
/// fireAndForget() is a drop-in replacement for that pattern — same
/// runtime behavior (start the promise, don't block, hand errors to the
/// caller's own handler) — that additionally registers the promise here so
/// drainFireAndForget() can wait for every currently in-flight one. Nothing
/// about a production call site's behavior changes; what changes is that
/// the "did I remember to await this in my test" question is no longer up
/// to each test author to get right one call site at a time — resetDb()
/// calls drainFireAndForget() itself, once, structurally.
const pending = new Set<Promise<void>>();

export function fireAndForget<T>(promise: Promise<T>, onError: (err: unknown) => void): void {
  const tracked: Promise<void> = promise.then(
    () => undefined,
    (err: unknown) => onError(err),
  );
  const settled = tracked.finally(() => {
    pending.delete(settled);
  });
  pending.add(settled);
}

/// Waits for every currently in-flight fireAndForget() call to settle.
/// Test-only (called from resetDb(), never from production request
/// handling) — looped rather than a single Promise.all in case draining one
/// somehow starts another (none of today's call sites do, but a single
/// snapshot would silently stop being a real drain the day one does).
export async function drainFireAndForget(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all(pending);
  }
}
