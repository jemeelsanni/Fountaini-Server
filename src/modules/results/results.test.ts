import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { computeResultsForClass, finalizeResult } from "./results.service.js";
import {
  createAdmin,
  createAssessmentComponent,
  createAssignment,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
  createGradingScaleWithBands,
  createParent,
  createStudentWithLogin,
  createSubject,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForAuditLog } from "../../test/waitForAuditLog.js";

/// Polls pg_locks (via a separate connection from whatever transaction is
/// holding the lock being waited on) until at least `targetCount` backends
/// are blocked waiting on some lock. Used to deterministically confirm two
/// requests are actually queued behind a held row lock before releasing it,
/// rather than guessing at a wall-clock delay that happens to be long
/// enough — request-dispatch overhead (Express middleware, JWT
/// verification, however many reads a service does before its write) varies
/// enough that a fixed delay doesn't reliably preserve firing order by the
/// time each request's write actually reaches Postgres's lock queue. Not
/// filtered by relation: a session blocked on a row lock waits on the
/// blocking transaction's XID (locktype 'transactionid'), which carries no
/// relation at all — only 'relation'/'tuple' locktypes do. Safe to check
/// "any ungranted lock" unfiltered here because the test DB is exclusively
/// used by this single-process suite; nothing else is ever mid-transaction.
async function waitForLockWaiters(targetCount: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM pg_locks WHERE NOT granted
    `;
    if (Number(rows[0]?.count ?? 0) >= targetCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${targetCount} lock waiter(s) on "Result"`);
}

const app = createApp();

async function enterAndSubmit(
  token: string,
  assignmentId: string,
  termId: string,
  entries: Array<{ studentId: string; assessmentComponentId: string; rawScore: number }>,
) {
  await request(app)
    .put(`/api/class-subject-assignments/${assignmentId}/scores`)
    .set("Authorization", `Bearer ${token}`)
    .send({ termId, entries });
  return request(app)
    .post(`/api/class-subject-assignments/${assignmentId}/scores/submit`)
    .set("Authorization", `Bearer ${token}`)
    .send({ termId });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("full report card lifecycle", () => {
  it("computes with partial subjects, finalizes, overrides audibly, and is viewable by the right people only", async () => {
    const { token: adminToken, user: adminUser } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");

    const maths = await createSubject("Mathematics", "MTH");
    const english = await createSubject("English", "ENG");
    const ca1 = await createAssessmentComponent(session.id, "CA1", "CA", 20, 1);
    const exam = await createAssessmentComponent(session.id, "EXAM", "EXAM", 80, 2);
    await createGradingScaleWithBands(session.id, [
      { grade: "A", min: 70, max: 100 },
      { grade: "B", min: 50, max: 69.99 },
      { grade: "F", min: 0, max: 49.99 },
    ]);

    const { staff: mathsTeacher, token: mathsToken } = await createTeacher("maths@test.local");
    const { staff: englishTeacher, token: englishToken } = await createTeacher("english@test.local");
    const mathsAssignment = await createAssignment(klass.id, maths.id, mathsTeacher.id, session.id);
    const englishAssignment = await createAssignment(klass.id, english.id, englishTeacher.id, session.id);

    const { student: student1, token: student1Token } = await createStudentWithLogin(
      "student1@test.local",
      "ADM-001",
    );
    const student2 = await createBareStudent("ADM-002");
    await enrollStudent(student1.id, klass.id, session.id);
    await enrollStudent(student2.id, klass.id, session.id);

    const { parent, token: parentToken } = await createParent("parent1@test.local");
    await prisma.studentParent.create({
      data: { parentId: parent.id, studentId: student1.id, relationship: "MOTHER" },
    });

    // Maths: both students submitted (student1 80, student2 50).
    await enterAndSubmit(mathsToken, mathsAssignment.id, term.id, [
      { studentId: student1.id, assessmentComponentId: ca1.id, rawScore: 20 },
      { studentId: student1.id, assessmentComponentId: exam.id, rawScore: 60 },
      { studentId: student2.id, assessmentComponentId: ca1.id, rawScore: 10 },
      { studentId: student2.id, assessmentComponentId: exam.id, rawScore: 40 },
    ]);

    // English: the teacher has only entered student1's scores so far. Submission
    // is all-or-nothing per assignment (the whole class roster must be complete),
    // so this is correctly rejected — student2 isn't done yet.
    const prematureEnglishSubmit = await enterAndSubmit(englishToken, englishAssignment.id, term.id, [
      { studentId: student1.id, assessmentComponentId: ca1.id, rawScore: 15 },
      { studentId: student1.id, assessmentComponentId: exam.id, rawScore: 55 },
    ]);
    expect(prematureEnglishSubmit.status).toBe(400);

    // English is therefore never submitted for anyone this term — this is what
    // "admin can finalize with partial subjects" actually means: not every
    // assigned subject has a submitted result yet, and that's fine.

    // --- Admin computes DRAFT results for the class/term, from Maths alone ---
    const computeRes = await request(app)
      .post("/api/results/compute")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ classId: klass.id, termId: term.id });
    expect(computeRes.status).toBe(200);

    type ResultRow = { id: string; studentId: string; totalScore: string; averageScore: string; status: string };
    const results = computeRes.body as ResultRow[];
    const result1 = results.find((r) => r.studentId === student1.id);
    const result2 = results.find((r) => r.studentId === student2.id);

    // Only Maths has been submitted for either student, so each result reflects
    // exactly one subject — proving results are computable from whatever's
    // actually been submitted, not blocked on every assigned subject.
    expect(Number(result1?.totalScore)).toBe(80);
    expect(Number(result1?.averageScore)).toBe(80);
    expect(Number(result2?.totalScore)).toBe(50);
    expect(Number(result2?.averageScore)).toBe(50);
    expect(result1?.status).toBe("DRAFT");

    // --- Finalize student1's result ---
    const finalizeRes = await request(app)
      .post(`/api/results/${(result1 as unknown as { id: string }).id}/finalize`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(finalizeRes.status).toBe(200);
    expect(finalizeRes.body.status).toBe("FINALIZED");
    expect(finalizeRes.body.finalizedByUserId).toBe(adminUser.id);

    const resultId = finalizeRes.body.id as string;

    // --- Recomputing the class must not touch the now-finalized result ---
    await request(app)
      .post("/api/results/compute")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ classId: klass.id, termId: term.id });
    const untouchedFinalized = await prisma.result.findUniqueOrThrow({ where: { id: resultId } });
    expect(untouchedFinalized.status).toBe("FINALIZED");

    // --- Cannot override a non-finalized result ---
    const nonFinalizedOverride = await request(app)
      .post(`/api/results/${(result2 as unknown as { id: string }).id}/override`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fieldName: "totalScore", newValue: "999", reason: "testing override on draft" });
    expect(nonFinalizedOverride.status).toBe(400);

    // --- Audited override on the finalized result ---
    const overrideRes = await request(app)
      .post(`/api/results/${resultId}/override`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        fieldName: "totalScore",
        newValue: "85",
        reason: "Manual re-mark after a transcription error was found in the Maths exam script",
      });
    expect(overrideRes.status).toBe(200);
    expect(Number(overrideRes.body.totalScore)).toBe(85);

    const overrideRow = await prisma.resultOverride.findFirst({ where: { resultId } });
    expect(overrideRow).not.toBeNull();
    expect(overrideRow?.fieldName).toBe("totalScore");
    expect(overrideRow?.performedByUserId).toBe(adminUser.id);
    expect(Number(overrideRow?.oldValue)).toBe(80);
    expect(overrideRow?.newValue).toBe("85");

    // The override route is itself audit-logged via the generic mechanism too.
    const auditEntry = await waitForAuditLog("Result", resultId, "RESULT_OVERRIDDEN");
    expect(auditEntry).not.toBeNull();

    // --- Viewable report card (who else can/can't see it is covered by the
    // auth matrix, src/authorization/authMatrix.data.ts) ---
    const asStudent = await request(app)
      .get(`/api/results/${student1.id}/${term.id}`)
      .set("Authorization", `Bearer ${student1Token}`);
    expect(asStudent.status).toBe(200);
    expect(Number(asStudent.body.totalScore)).toBe(85);

    const asParent = await request(app)
      .get(`/api/results/${student1.id}/${term.id}`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(asParent.status).toBe(200);
  });
});

describe("compute/finalize concurrency", () => {
  it("never lets a concurrent recompute silently change a result after it's finalized", async () => {
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      await resetDb();

      const { user: adminUser } = await createAdmin(`admin-${i}@test.local`);
      const session = await createCurrentAcademicSession(`2026/2027-${i}`);
      const term = await createTermForSession(session.id, "First Term", 1);
      const klass = await createClass("JSS1", "A");
      const subject = await createSubject(`Subject ${i}`, `SUBJ${i}`);
      const { staff: teacher } = await createTeacher(`teacher-${i}@test.local`);
      const assignment = await createAssignment(klass.id, subject.id, teacher.id, session.id);
      const student = await createBareStudent(`ADM-001-${i}`);
      await enrollStudent(student.id, klass.id, session.id);

      const subjectResult = await prisma.subjectResult.create({
        data: {
          studentId: student.id,
          classSubjectAssignmentId: assignment.id,
          termId: term.id,
          totalScore: 50,
          status: "SUBMITTED",
        },
      });

      // Sequential first compute creates the DRAFT result and locks in 50.
      const computeResults1 = await computeResultsForClass({ classId: klass.id, termId: term.id });
      const resultId = computeResults1.find((r) => r.studentId === student.id)?.id as string;

      // Give the racing recompute below a genuinely different value to
      // write, rather than redundantly recomputing the same 50 — so a
      // corrupting write would actually be observable in the final value.
      await prisma.subjectResult.update({ where: { id: subjectResult.id }, data: { totalScore: 90 } });

      // Deterministically force the exact interleaving this bug is about —
      // finalize's write landing fully before the racing recompute's write
      // for the same row. Wall-clock delays don't reliably produce this:
      // finalize is a single read+write and routinely finishes before
      // compute even reaches its own write phase regardless of which fired
      // first, and request-dispatch overhead through the full HTTP stack
      // (Express middleware, JWT verification) makes that timing even less
      // predictable. So instead: call the service functions directly
      // (skipping HTTP entirely — there's nothing HTTP-specific about this
      // race), hold a real row lock on the target Result row, fire both
      // calls without awaiting them, and use waitForLockWaiters to get
      // definitive confirmation (via pg_locks, not a guessed delay) that
      // each one has actually reached its own UPDATE and is blocked, queued
      // behind this lock, before moving on. Only then release the lock by
      // returning. Postgres grants it to whichever queued first — finalize,
      // confirmed queued before compute was even invoked — lets that UPDATE
      // apply and commit, then grants it to compute's queued write, which
      // (on the fix) re-checks status fresh at that moment and finds it's
      // since become FINALIZED.
      const [, computeResults2] = await prisma
        .$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "Result" WHERE "id" = ${resultId} FOR UPDATE`;

          const finalizePromise = finalizeResult(resultId, adminUser.id);
          await waitForLockWaiters(1);

          const computePromise = computeResultsForClass({ classId: klass.id, termId: term.id });
          await waitForLockWaiters(2);

          return [finalizePromise, computePromise] as const;
        })
        .then((promises) => Promise.all(promises));

      expect(computeResults2.find((r) => r.studentId === student.id)?.id, `iteration ${i}`).toBe(resultId);

      const finalResult = await prisma.result.findUniqueOrThrow({ where: { id: resultId } });
      const overrides = await prisma.resultOverride.findMany({ where: { resultId } });

      expect(finalResult.status, `iteration ${i}`).toBe("FINALIZED");
      expect(overrides, `iteration ${i}`).toHaveLength(0);
      expect(
        Number(finalResult.totalScore),
        `iteration ${i}: totalScore changed after finalize with no ResultOverride row — finalize's write ` +
          `is confirmed (via pg_locks) to have committed before this recompute's write was even queued, ` +
          `so this write should have been a no-op`,
      ).toBe(50);
      expect(Number(finalResult.averageScore), `iteration ${i}`).toBe(50);
    }
  }, 120_000);
});
