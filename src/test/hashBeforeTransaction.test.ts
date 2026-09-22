import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../db/client.js";
import * as passwordModule from "../modules/auth/password.js";
import { createBareStudent, createCurrentAcademicSession, createParent } from "./factories.js";
import { resetDb } from "./resetDb.js";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/// Argon2 hashing is deliberately slow and has no database dependency —
/// holding an interactive transaction open while it runs extends that
/// transaction's real-world duration for nothing. Over a high-latency
/// connection (an admin-facing request is normally server-to-DB on
/// Railway's own internal network and fast regardless of the caller's own
/// connection, but a script run directly against the public proxy — e.g.
/// the demo seed — is not) that's exactly what can exceed Prisma's default
/// 5s interactive-transaction timeout (P2028). Every credential-issuing
/// atomic create already hashes before opening its transaction; this pins
/// that so it can't silently regress.
///
/// vi.spyOn is used here in pure pass-through mode — neither hashPassword
/// nor prisma.$transaction is replaced, both still run for real; the spies
/// only record invocation order. That's a deliberate, narrow exception to
/// this suite's usual no-mocking convention: there's no black-box way to
/// observe "did this async call settle before that one was even invoked"
/// without instrumenting the calls themselves, and pass-through spying
/// doesn't fake any behavior the test then relies on. Vitest's
/// invocationCallOrder is a single counter shared across every mock/spy in
/// the process, so comparing the two spies' first entries tells us which
/// one the runtime reached first — and because prisma.$transaction(fn)
/// invokes synchronously (fn only runs once Prisma has set the transaction
/// up), a hash performed *inside* the callback would necessarily be
/// invoked after $transaction itself, not before — the two orderings are
/// genuinely distinguishable this way, not just apparently so.
function expectHashSettledBeforeTransactionOpened(
  hashSpy: ReturnType<typeof vi.spyOn>,
  txSpy: ReturnType<typeof vi.spyOn>,
) {
  expect(hashSpy, "hashPassword was never called").toHaveBeenCalled();
  expect(txSpy, "$transaction was never called").toHaveBeenCalled();
  const hashOrder = hashSpy.mock.invocationCallOrder[0]!;
  const txOrder = txSpy.mock.invocationCallOrder[0]!;
  expect(hashOrder, "hashPassword must be invoked (and, being awaited, resolved) before $transaction opens").toBeLessThan(txOrder);
}

describe("credential-issuing atomic creates hash the password before opening their transaction", () => {
  it("staff.service.ts::createStaff", async () => {
    // createStaff generates a fresh staffNumber (no override passed below),
    // which needs a current academic session to derive the year from.
    await createCurrentAcademicSession("2026/2027");
    const { createStaff } = await import("../modules/staff/staff.service.js");
    const hashSpy = vi.spyOn(passwordModule, "hashPassword");
    const txSpy = vi.spyOn(prisma, "$transaction");

    await createStaff({ role: "TEACHER", email: "hash-order-staff@test.local", firstName: "A", lastName: "B" });

    expectHashSettledBeforeTransactionOpened(hashSpy, txSpy);
  });

  it("parents.service.ts::createParent", async () => {
    const { createParent: createParentAtomic } = await import("../modules/parents/parents.service.js");
    const hashSpy = vi.spyOn(passwordModule, "hashPassword");
    const txSpy = vi.spyOn(prisma, "$transaction");

    await createParentAtomic({ email: "hash-order-parent@test.local", firstName: "A", lastName: "B" });

    expectHashSettledBeforeTransactionOpened(hashSpy, txSpy);
  });

  it("students.service.ts::issueFirstLoginForStudent", async () => {
    const { issueFirstLoginForStudent } = await import("../modules/students/students.service.js");
    const student = await createBareStudent("FIA/2026/001");
    const { parent } = await createParent("hash-order-recipient@test.local");
    const hashSpy = vi.spyOn(passwordModule, "hashPassword");
    const txSpy = vi.spyOn(prisma, "$transaction");

    await issueFirstLoginForStudent(student.id, { userId: parent.userId, user: { email: "hash-order-recipient@test.local" } });

    expectHashSettledBeforeTransactionOpened(hashSpy, txSpy);
  });

  it("students.service.ts::reissueCredentialsForStudent", async () => {
    const { issueFirstLoginForStudent, reissueCredentialsForStudent } = await import(
      "../modules/students/students.service.js"
    );
    const student = await createBareStudent("FIA/2026/002");
    const { parent } = await createParent("hash-order-reissue@test.local");
    await issueFirstLoginForStudent(student.id, { userId: parent.userId, user: { email: "hash-order-reissue@test.local" } });

    const hashSpy = vi.spyOn(passwordModule, "hashPassword");
    const txSpy = vi.spyOn(prisma, "$transaction");

    await reissueCredentialsForStudent(student.id);

    expectHashSettledBeforeTransactionOpened(hashSpy, txSpy);
  });
});
