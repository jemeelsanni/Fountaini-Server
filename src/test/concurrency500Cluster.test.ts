/// Six read-then-write-outside-transaction sites whose only failure mode
/// under a concurrent duplicate was an unhandled unique-constraint or
/// not-found error (500), not a clean 409/404 — a different, milder class
/// than the silent-corruption bugs fixed elsewhere (results, attendance,
/// fees confirm, scores, admissions). Grouped in one file because they're
/// all the same one-line fix (catch the constraint / use deleteMany) rather
/// than because they share a module. See docs/concurrency.md.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteClassSubjectAssignment } from "../modules/academic-structure/academic-structure.service.js";
import { generateObligations, rejectPayment } from "../modules/fees/fees.service.js";
import { createParent, unlinkChild } from "../modules/parents/parents.service.js";
import { createUser } from "../modules/users/users.service.js";
import { prisma } from "../db/client.js";
import {
  createAdmin,
  createAssignment,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
  createSubject,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "./factories.js";
import { resetDb } from "./resetDb.js";

type Outcome<T> = { ok: true; value: T } | { ok: false; err: { statusCode?: number } };

function settle<T>(p: Promise<T>): Promise<Outcome<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err: err as { statusCode?: number } }),
  );
}

/// Asserts exactly one of `outcomes` succeeded and the rest failed with
/// `status`, then returns the count that succeeded (for callers that also
/// want to assert on the winning value).
function expectOneSuccessRestFailedWith(outcomes: Outcome<unknown>[], status: number): void {
  const succeeded = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o): o is { ok: false; err: { statusCode?: number } } => !o.ok);
  expect(succeeded).toHaveLength(1);
  expect(failed).toHaveLength(outcomes.length - 1);
  for (const f of failed) {
    expect(f.err.statusCode).toBe(status);
  }
}

/// createParent()/unlinkChild() need a real PARENT-role User to link to, but
/// not the full Parent record itself — creating that is what's under test.
function createParentUserRecord(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: "unused", roles: { create: [{ role: "PARENT" }] } },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("500-instead-of-409/404 cluster: concurrent duplicate handling", () => {
  it("createUser: two concurrent signups with the same email resolve as one success and one 409, never a 500", async () => {
    const [a, b] = await Promise.all([
      settle(createUser({ email: "dupe@test.local", password: "a-secure-password", role: "TEACHER" })),
      settle(createUser({ email: "dupe@test.local", password: "another-secure-pw", role: "TEACHER" })),
    ]);
    expectOneSuccessRestFailedWith([a, b], 409);

    const users = await prisma.user.findMany({ where: { email: "dupe@test.local" } });
    expect(users).toHaveLength(1);
  });

  it("createParent: two concurrent creates linked to the same user resolve as one success and one 409, never a 500", async () => {
    const parentUser = await createParentUserRecord("parent-user@test.local");

    const [a, b] = await Promise.all([
      settle(createParent({ userId: parentUser.id, firstName: "Grace", lastName: "Hopper" })),
      settle(createParent({ userId: parentUser.id, firstName: "Grace", lastName: "Hopper" })),
    ]);
    expectOneSuccessRestFailedWith([a, b], 409);

    const parents = await prisma.parent.findMany({ where: { userId: parentUser.id } });
    expect(parents).toHaveLength(1);
  });

  it("generateObligations: two concurrent generates for the same fee structure both succeed, with no duplicate obligations", async () => {
    const { user: admin } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    // termId set (not the session-wide/null case) — skipDuplicates only
    // protects this via FeeObligation's unique constraint on (studentId,
    // feeStructureId, termId). See docs/concurrency.md: Postgres never
    // treats NULL as equal to NULL for uniqueness, so that same constraint
    // does NOT catch a concurrent double-generate for a session-wide
    // (termId: null) fee structure — a real, separate, documented gap.
    const structure = await prisma.feeStructure.create({
      data: {
        name: "Tuition",
        category: "TUITION",
        classId: klass.id,
        academicSessionId: session.id,
        termId: term.id,
        amountKobo: 5_000_00,
      },
    });

    const [a, b] = await Promise.all([
      settle(generateObligations(structure.id, admin.id)),
      settle(generateObligations(structure.id, admin.id)),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);

    const obligations = await prisma.feeObligation.findMany({
      where: { feeStructureId: structure.id, studentId: student.id },
    });
    expect(obligations).toHaveLength(1);
  });

  it("rejectPayment: reject racing confirm on the same payment resolves as one success and one 409, never a 500", async () => {
    const { user: admin } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const structure = await prisma.feeStructure.create({
      data: { name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_00 },
    });
    const obligation = await prisma.feeObligation.create({
      data: {
        studentId: student.id,
        feeStructureId: structure.id,
        academicSessionId: session.id,
        amountDueKobo: 5_000_00,
        createdByUserId: admin.id,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        feeObligationId: obligation.id,
        amountKobo: 5_000_00,
        paymentDate: new Date(),
        recordedByUserId: admin.id,
      },
    });

    const [a, b] = await Promise.all([
      settle(rejectPayment(payment.id, admin.id)),
      settle(rejectPayment(payment.id, admin.id)),
    ]);
    expectOneSuccessRestFailedWith([a, b], 409);

    const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(finalPayment.status).toBe("REJECTED");
  });

  it("unlinkChild: two concurrent unlinks of the same pair resolve as one success and one 404, never a 500", async () => {
    const parentUser = await createParentUserRecord("parent-user2@test.local");
    const parent = await prisma.parent.create({
      data: { userId: parentUser.id, firstName: "Grace", lastName: "Hopper" },
    });
    const student = await createBareStudent("ADM-002");
    await prisma.studentParent.create({
      data: { parentId: parent.id, studentId: student.id, relationship: "GUARDIAN" },
    });

    const [a, b] = await Promise.all([
      settle(unlinkChild(parent.id, student.id)),
      settle(unlinkChild(parent.id, student.id)),
    ]);
    expectOneSuccessRestFailedWith([a, b], 404);

    const links = await prisma.studentParent.findMany({ where: { parentId: parent.id, studentId: student.id } });
    expect(links).toHaveLength(0);
  });

  it("deleteClassSubjectAssignment: two concurrent deletes of the same assignment resolve as one success and one 404, never a 500", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const { staff: teacher } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, teacher.id, session.id);

    const [a, b] = await Promise.all([
      settle(deleteClassSubjectAssignment(assignment.id)),
      settle(deleteClassSubjectAssignment(assignment.id)),
    ]);
    expectOneSuccessRestFailedWith([a, b], 404);

    const remaining = await prisma.classSubjectAssignment.findUnique({ where: { id: assignment.id } });
    expect(remaining).toBeNull();
  });
});
