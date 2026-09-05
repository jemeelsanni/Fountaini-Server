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
  createStaffParent,
  createStudentWithLogin,
  createSubject,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "../../test/factories.js";
import { awaitLockWaiter } from "../../test/awaitLockWaiter.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForAuditLog } from "../../test/waitForAuditLog.js";

const app = createApp();

/// createTermForSession (test/factories.ts) always sets isCurrent: true —
/// fine for the vast majority of tests, which only ever need one term per
/// session, but a second call for the SAME session collides with the
/// "at most one current term per session" partial unique index. The
/// three-term-session fixtures below don't rely on any term being current,
/// so this local, non-current variant sidesteps that instead of touching
/// the shared factory's behavior for every other caller.
function createTerm(academicSessionId: string, name: string, order: number) {
  return prisma.term.create({
    data: { academicSessionId, name, order, startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15") },
  });
}

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

describe("computeResultsForClass — first-ever compute", () => {
  it("creates a Result row when none exists yet (the createMany insert path, not just the updateMany path)", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const before = await prisma.result.count();
    expect(before, "fixture must start with a genuinely empty Result table").toBe(0);

    const results = await computeResultsForClass({ classId: klass.id, termId: term.id });

    expect(results).toHaveLength(1);
    const created = await prisma.result.findUnique({
      where: { studentId_termId: { studentId: student.id, termId: term.id } },
    });
    expect(created).not.toBeNull();
    expect(created?.status).toBe("DRAFT");
    // No submitted subject results for this student — totalScore/averageScore
    // should reflect that, not throw or silently skip the row.
    expect(Number(created?.totalScore)).toBe(0);
    expect(created?.averageScore).toBeNull();
  });
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

describe("class teacher / principal comments — normal (non-override) write path", () => {
  async function buildDraftResultWithFormTeacher() {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const { staff: formTeacherStaff, token: formTeacherToken } = await createTeacher("form-teacher@test.local");
    await prisma.classFormTeacher.create({
      data: { classId: klass.id, teacherId: formTeacherStaff.id, academicSessionId: session.id },
    });

    const [result] = await computeResultsForClass({ classId: klass.id, termId: term.id });
    return { result: result as { id: string; status: string }, formTeacherToken };
  }

  it("lets the form teacher write classTeacherComment on a DRAFT result without creating a ResultOverride row", async () => {
    const { result, formTeacherToken } = await buildDraftResultWithFormTeacher();
    expect(result.status).toBe("DRAFT");

    const res = await request(app)
      .patch(`/api/results/${result.id}/class-teacher-comment`)
      .set("Authorization", `Bearer ${formTeacherToken}`)
      .send({ comment: "A pleasure to teach this term." });

    expect(res.status).toBe(200);
    expect(res.body.classTeacherComment).toBe("A pleasure to teach this term.");
    const overrides = await prisma.resultOverride.findMany({ where: { resultId: result.id } });
    expect(overrides, "the routine write path must never write a ResultOverride row").toHaveLength(0);
  });

  it("lets an admin write principalComment on a DRAFT result without creating a ResultOverride row", async () => {
    const { result } = await buildDraftResultWithFormTeacher();
    const { token: adminToken } = await createAdmin("admin2@test.local");

    const res = await request(app)
      .patch(`/api/results/${result.id}/principal-comment`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ comment: "Keep up the good work." });

    expect(res.status).toBe(200);
    expect(res.body.principalComment).toBe("Keep up the good work.");
    const overrides = await prisma.resultOverride.findMany({ where: { resultId: result.id } });
    expect(overrides).toHaveLength(0);
  });

  it("rejects both direct comment writes once the result is FINALIZED, and leaves overrideResult as the only path", async () => {
    const { result, formTeacherToken } = await buildDraftResultWithFormTeacher();
    const { token: adminToken, user: adminUser } = await createAdmin("admin3@test.local");

    const finalizeRes = await request(app)
      .post(`/api/results/${result.id}/finalize`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(finalizeRes.status).toBe(200);

    const classTeacherAttempt = await request(app)
      .patch(`/api/results/${result.id}/class-teacher-comment`)
      .set("Authorization", `Bearer ${formTeacherToken}`)
      .send({ comment: "Too late now." });
    expect(classTeacherAttempt.status).toBe(400);

    const principalAttempt = await request(app)
      .patch(`/api/results/${result.id}/principal-comment`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ comment: "Too late now." });
    expect(principalAttempt.status).toBe(400);

    // overrideResult's own FINALIZED-only behavior is unchanged: it's still
    // the one way to change either comment field once finalized.
    const overrideRes = await request(app)
      .post(`/api/results/${result.id}/override`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        fieldName: "classTeacherComment",
        newValue: "Corrected comment after review.",
        reason: "Original comment had a factual error about attendance.",
      });
    expect(overrideRes.status).toBe(200);
    expect(overrideRes.body.classTeacherComment).toBe("Corrected comment after review.");

    const overrides = await prisma.resultOverride.findMany({ where: { resultId: result.id } });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.performedByUserId).toBe(adminUser.id);
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
      // predictable. Calling the service functions directly (skipping HTTP
      // entirely — there's nothing HTTP-specific about this race) plus
      // awaitLockWaiter gives definitive, pg_locks-confirmed ordering
      // instead: finalize is confirmed queued on the Result row's lock
      // before compute is even invoked, so it always applies and commits
      // first, then compute's queued write runs — which (on the fix)
      // re-checks status fresh at that moment and finds it's since become
      // FINALIZED.
      const [, computeResults2] = await awaitLockWaiter(
        "Result",
        resultId,
        () => finalizeResult(resultId, adminUser.id),
        () => computeResultsForClass({ classId: klass.id, termId: term.id }),
      );

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

describe("non-finalized results are invisible to PARENT/STUDENT", () => {
  async function buildDraftResultForLinkedParent() {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    const enrollment = await enrollStudent(student.id, klass.id, session.id);

    const { parent, token: parentToken } = await createParent("parent@test.local");
    await prisma.studentParent.create({
      data: { parentId: parent.id, studentId: student.id, relationship: "MOTHER" },
    });

    const result = await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollment.id, termId: term.id, status: "DRAFT" },
    });

    return { session, term, klass, student, parentToken, result };
  }

  // The security-critical pair: this is the actual leak from the audit —
  // demonstrated failing before the fix (see the report), passing after.
  it("returns 404 for a DRAFT result and 200 once FINALIZED, for a linked parent", async () => {
    const { term, student, parentToken, result } = await buildDraftResultForLinkedParent();

    const whileDraft = await request(app)
      .get(`/api/results/${student.id}/${term.id}`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(whileDraft.status).toBe(404);

    await prisma.result.update({ where: { id: result.id }, data: { status: "FINALIZED" } });

    const onceFinalized = await request(app)
      .get(`/api/results/${student.id}/${term.id}`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(onceFinalized.status).toBe(200);
    expect(onceFinalized.body.status).toBe("FINALIZED");
  });

  it("same pair for GET /api/students/:id/results — the DRAFT result is absent from the list, present once FINALIZED", async () => {
    const { student, parentToken, result } = await buildDraftResultForLinkedParent();

    const whileDraft = await request(app)
      .get(`/api/students/${student.id}/results`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(whileDraft.status).toBe(200);
    expect(whileDraft.body).toEqual([]);

    await prisma.result.update({ where: { id: result.id }, data: { status: "FINALIZED" } });

    const onceFinalized = await request(app)
      .get(`/api/students/${student.id}/results`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(onceFinalized.status).toBe(200);
    expect(onceFinalized.body).toHaveLength(1);
    expect(onceFinalized.body[0].id).toBe(result.id);
    expect(onceFinalized.body[0].status).toBe("FINALIZED");
  });

  it("the same DRAFT result is 404 for the student themself too, not just their parent", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const { student, token: studentToken } = await createStudentWithLogin("student@test.local", "ADM-002");
    const enrollment = await enrollStudent(student.id, klass.id, session.id);
    await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollment.id, termId: term.id, status: "DRAFT" },
    });

    const res = await request(app)
      .get(`/api/results/${student.id}/${term.id}`)
      .set("Authorization", `Bearer ${studentToken}`);
    expect(res.status).toBe(404);
  });

  it("does not over-restrict: ADMIN and an assigned TEACHER still see a DRAFT result on both routes", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Maths", "MTH");
    const { staff: teacherStaff, token: teacherToken } = await createTeacher("teacher@test.local");
    await createAssignment(klass.id, subject.id, teacherStaff.id, session.id);
    const student = await createBareStudent("ADM-003");
    const enrollment = await enrollStudent(student.id, klass.id, session.id);
    const result = await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollment.id, termId: term.id, status: "DRAFT" },
    });
    const { token: adminToken } = await createAdmin("admin@test.local");

    for (const token of [adminToken, teacherToken]) {
      const perTerm = await request(app)
        .get(`/api/results/${student.id}/${term.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(perTerm.status).toBe(200);
      expect(perTerm.body.status).toBe("DRAFT");

      const list = await request(app)
        .get(`/api/students/${student.id}/results`)
        .set("Authorization", `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.map((r: { id: string }) => r.id)).toContain(result.id);
    }
  });

  it("a staff-parent sees the full lifecycle for a student in their own assigned class, but only finalized results for their own child — derived per student, not per role held", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);

    const staffParent = await createStaffParent("staff-parent@test.local");

    // Their OWN teaching class — a student here proves the TEACHER path
    // grants full lifecycle visibility.
    const teachingClass = await createClass("JSS2", "A");
    const subject = await createSubject("English", "ENG");
    await createAssignment(teachingClass.id, subject.id, staffParent.staff.id, session.id);
    const classStudent = await createBareStudent("ADM-CLASS");
    const classEnrollment = await enrollStudent(classStudent.id, teachingClass.id, session.id);
    const classResult = await prisma.result.create({
      data: { studentId: classStudent.id, enrollmentId: classEnrollment.id, termId: term.id, status: "DRAFT" },
    });

    // Their own child — enrolled in a DIFFERENT class they don't teach, so
    // only the PARENT link (not any teaching relationship) explains access.
    const otherClass = await createClass("JSS2", "B");
    const childStudent = await createBareStudent("ADM-CHILD");
    const childEnrollment = await enrollStudent(childStudent.id, otherClass.id, session.id);
    await prisma.studentParent.create({
      data: { parentId: staffParent.parent.id, studentId: childStudent.id, relationship: "FATHER" },
    });
    const childResult = await prisma.result.create({
      data: { studentId: childStudent.id, enrollmentId: childEnrollment.id, termId: term.id, status: "DRAFT" },
    });

    // Fully disjoint — neither their child nor in any class they teach.
    const disjointStudent = await createBareStudent("ADM-DISJOINT");
    const disjointEnrollment = await enrollStudent(disjointStudent.id, otherClass.id, session.id);
    await prisma.result.create({
      data: {
        studentId: disjointStudent.id,
        enrollmentId: disjointEnrollment.id,
        termId: term.id,
        status: "DRAFT",
      },
    });

    // --- 1. A student in their assigned class, DRAFT: visible on both
    // routes — FULL access via the TEACHER path. This is what proves the
    // TEACHER branch's short-circuit-to-FULL isn't accidentally masked or
    // collapsed by the PARENT branch also being checked on this principal
    // (it's just irrelevant to this student, since staffParent isn't
    // classStudent's parent at all).
    const classDraftPerTerm = await request(app)
      .get(`/api/results/${classStudent.id}/${term.id}`)
      .set("Authorization", `Bearer ${staffParent.token}`);
    expect(classDraftPerTerm.status).toBe(200);
    expect(classDraftPerTerm.body.status).toBe("DRAFT");

    const classDraftList = await request(app)
      .get(`/api/students/${classStudent.id}/results`)
      .set("Authorization", `Bearer ${staffParent.token}`);
    expect(classDraftList.status).toBe(200);
    expect(classDraftList.body).toHaveLength(1);
    expect(classDraftList.body[0].id).toBe(classResult.id);
    expect(classDraftList.body[0].status).toBe("DRAFT");

    // --- 2. Their own child, NOT in their assigned class, DRAFT: hidden on
    // both routes — RESTRICTED via the PARENT path alone. The list route
    // must be checked here too, while still DRAFT, not just after
    // finalizing below — an empty array is the list's equivalent of the
    // per-term route's 404.
    const childDraftPerTerm = await request(app)
      .get(`/api/results/${childStudent.id}/${term.id}`)
      .set("Authorization", `Bearer ${staffParent.token}`);
    expect(childDraftPerTerm.status).toBe(404);

    const childDraftList = await request(app)
      .get(`/api/students/${childStudent.id}/results`)
      .set("Authorization", `Bearer ${staffParent.token}`);
    expect(childDraftList.status).toBe(200);
    expect(childDraftList.body).toEqual([]);

    await prisma.result.update({ where: { id: childResult.id }, data: { status: "FINALIZED" } });

    const childFinalizedPerTerm = await request(app)
      .get(`/api/results/${childStudent.id}/${term.id}`)
      .set("Authorization", `Bearer ${staffParent.token}`);
    expect(childFinalizedPerTerm.status).toBe(200);
    expect(childFinalizedPerTerm.body.status).toBe("FINALIZED");

    const childFinalizedList = await request(app)
      .get(`/api/students/${childStudent.id}/results`)
      .set("Authorization", `Bearer ${staffParent.token}`);
    expect(childFinalizedList.body).toHaveLength(1);
    expect(childFinalizedList.body[0].id).toBe(childResult.id);
    expect(childFinalizedList.body[0].status).toBe("FINALIZED");

    // --- 3. disjointStudent: neither their child nor in any class they
    // teach — an ownership denial (403), not a visibility filter, on both
    // routes. Unaffected by status (still DRAFT here).
    const disjointPerTerm = await request(app)
      .get(`/api/results/${disjointStudent.id}/${term.id}`)
      .set("Authorization", `Bearer ${staffParent.token}`);
    expect(disjointPerTerm.status).toBe(403);

    const disjointList = await request(app)
      .get(`/api/students/${disjointStudent.id}/results`)
      .set("Authorization", `Bearer ${staffParent.token}`);
    expect(disjointList.status).toBe(403);
  });
});

describe("GET /api/students/:id/results", () => {
  it("sorts by session start date descending, then term order descending — not createdAt or insertion order", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");

    // Two sessions, deliberately created with the LATER-starting one first
    // and the earlier one second — if the sort were accidentally following
    // createdAt/insertion order instead of startDate, this would produce
    // the wrong result order.
    const laterSession = await prisma.academicSession.create({
      data: { name: "2027/2028", startDate: new Date("2027-09-01"), endDate: new Date("2028-07-31") },
    });
    const earlierSession = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    // Two terms within earlierSession, term 2 created before term 1 — same
    // reasoning: proves the sort uses `order`, not creation sequence.
    const earlierTerm2 = await prisma.term.create({
      data: {
        academicSessionId: earlierSession.id,
        name: "Second Term",
        order: 2,
        startDate: new Date("2027-01-01"),
        endDate: new Date("2027-04-01"),
      },
    });
    const earlierTerm1 = await prisma.term.create({
      data: {
        academicSessionId: earlierSession.id,
        name: "First Term",
        order: 1,
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-12-15"),
      },
    });
    const laterTerm1 = await prisma.term.create({
      data: {
        academicSessionId: laterSession.id,
        name: "First Term",
        order: 1,
        startDate: new Date("2027-09-01"),
        endDate: new Date("2027-12-15"),
      },
    });

    const enrollLater = await enrollStudent(student.id, klass.id, laterSession.id);
    const enrollEarlier = await enrollStudent(student.id, klass.id, earlierSession.id);

    const resultLaterTerm1 = await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollLater.id, termId: laterTerm1.id, status: "FINALIZED" },
    });
    const resultEarlierTerm1 = await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollEarlier.id, termId: earlierTerm1.id, status: "FINALIZED" },
    });
    const resultEarlierTerm2 = await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollEarlier.id, termId: earlierTerm2.id, status: "FINALIZED" },
    });

    const res = await request(app)
      .get(`/api/students/${student.id}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([
      resultLaterTerm1.id,
      resultEarlierTerm2.id,
      resultEarlierTerm1.id,
    ]);
    expect(res.body[0].session).toEqual({ id: laterSession.id, name: laterSession.name });
    expect(res.body[0].term).toEqual({ id: laterTerm1.id, name: laterTerm1.name, order: 1 });
  });

  it("filters by ?academicSessionId= when given", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");

    const sessionA = await createCurrentAcademicSession("2026/2027");
    const termA = await createTermForSession(sessionA.id, "First Term", 1);
    const enrollA = await enrollStudent(student.id, klass.id, sessionA.id);
    const resultA = await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollA.id, termId: termA.id, status: "FINALIZED" },
    });

    const sessionB = await prisma.academicSession.create({
      data: { name: "2025/2026", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31") },
    });
    const termB = await prisma.term.create({
      data: {
        academicSessionId: sessionB.id,
        name: "First Term",
        order: 1,
        startDate: new Date("2025-09-01"),
        endDate: new Date("2025-12-15"),
      },
    });
    const enrollB = await enrollStudent(student.id, klass.id, sessionB.id);
    await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollB.id, termId: termB.id, status: "FINALIZED" },
    });

    const res = await request(app)
      .get(`/api/students/${student.id}/results?academicSessionId=${sessionA.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(resultA.id);
  });
});

describe("GET /api/classes/:id/results/:termId", () => {
  it("lets the form teacher read their own class's results, but denies a subject teacher assigned to the same class", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const { staff: formTeacherStaff, token: formTeacherToken } = await createTeacher("form-teacher@test.local");
    await prisma.classFormTeacher.create({
      data: { classId: klass.id, teacherId: formTeacherStaff.id, academicSessionId: session.id },
    });

    // A SUBJECT teacher assigned to this exact class — the negative case
    // that proves this route checks the form-teacher assignment
    // specifically, not "any teacher connected to this class somehow."
    const subject = await createSubject("Mathematics", "MTH");
    const { staff: subjectTeacherStaff, token: subjectTeacherToken } = await createTeacher(
      "subject-teacher@test.local",
    );
    await createAssignment(klass.id, subject.id, subjectTeacherStaff.id, session.id);

    await computeResultsForClass({ classId: klass.id, termId: term.id });

    const asFormTeacher = await request(app)
      .get(`/api/classes/${klass.id}/results/${term.id}`)
      .set("Authorization", `Bearer ${formTeacherToken}`);
    expect(asFormTeacher.status).toBe(200);
    expect(asFormTeacher.body).toHaveLength(1);
    expect(asFormTeacher.body[0].studentId).toBe(student.id);

    const asSubjectTeacher = await request(app)
      .get(`/api/classes/${klass.id}/results/${term.id}`)
      .set("Authorization", `Bearer ${subjectTeacherToken}`);
    expect(asSubjectTeacher.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Feature A — session result averaging
// ---------------------------------------------------------------------------

describe("Session results (Feature A)", () => {
  async function setupThreeTermSession() {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term1 = await createTerm(session.id, "First Term", 1);
    const term2 = await createTerm(session.id, "Second Term", 2);
    const term3 = await createTerm(session.id, "Third Term", 3);
    const klass = await createClass("JSS1", "A");

    const maths = await createSubject("Mathematics", "MTH");
    const english = await createSubject("English", "ENG");
    const component = await createAssessmentComponent(session.id, "TOTAL", "EXAM", 100, 1);

    const { staff: mathsTeacher, token: mathsToken } = await createTeacher("maths-teacher@test.local");
    const { staff: englishTeacher, token: englishToken } = await createTeacher("english-teacher@test.local");
    const mathsAssignment = await createAssignment(klass.id, maths.id, mathsTeacher.id, session.id);
    const englishAssignment = await createAssignment(klass.id, english.id, englishTeacher.id, session.id);

    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    return {
      adminToken,
      session,
      term1,
      term2,
      term3,
      klass,
      maths,
      english,
      component,
      mathsAssignment,
      englishAssignment,
      mathsToken,
      englishToken,
      student,
    };
  }

  /// Enters+submits a single-component score for both subjects, computes,
  /// and finalizes the term's Result for `student` — mirroring
  /// enterAndSubmit above but parameterized over which term/scores.
  async function finalizeTermWithScores(
    world: Awaited<ReturnType<typeof setupThreeTermSession>>,
    term: { id: string },
    mathsScore: number,
    englishScore: number,
  ) {
    await enterAndSubmit(world.mathsToken, world.mathsAssignment.id, term.id, [
      { studentId: world.student.id, assessmentComponentId: world.component.id, rawScore: mathsScore },
    ]);
    await enterAndSubmit(world.englishToken, world.englishAssignment.id, term.id, [
      { studentId: world.student.id, assessmentComponentId: world.component.id, rawScore: englishScore },
    ]);
    const computeRes = await request(app)
      .post("/api/results/compute")
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ classId: world.klass.id, termId: term.id });
    const result = (computeRes.body as Array<{ id: string; studentId: string }>).find(
      (r) => r.studentId === world.student.id,
    );
    await request(app)
      .post(`/api/results/${result?.id}/finalize`)
      .set("Authorization", `Bearer ${world.adminToken}`);
  }

  /// Computes (but never finalizes) a term's Result — for proving a
  /// SUBMITTED-but-not-FINALIZED term is excluded from the session average.
  async function computeWithoutFinalizing(
    world: Awaited<ReturnType<typeof setupThreeTermSession>>,
    term: { id: string },
    mathsScore: number,
  ) {
    await enterAndSubmit(world.mathsToken, world.mathsAssignment.id, term.id, [
      { studentId: world.student.id, assessmentComponentId: world.component.id, rawScore: mathsScore },
    ]);
    await request(app)
      .post("/api/results/compute")
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ classId: world.klass.id, termId: term.id });
  }

  it("averages three FINALIZED terms per subject, and derives the overall average from those subject averages", async () => {
    const world = await setupThreeTermSession();
    await finalizeTermWithScores(world, world.term1, 60, 50);
    await finalizeTermWithScores(world, world.term2, 80, 70);
    await finalizeTermWithScores(world, world.term3, 100, 90);

    const computeRes = await request(app)
      .post("/api/session-results/compute")
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ classId: world.klass.id, academicSessionId: world.session.id });
    expect(computeRes.status).toBe(200);

    const sessionResult = (
      computeRes.body as Array<{ studentId: string; averageScore: string; subjectAverages: unknown[] }>
    ).find((r) => r.studentId === world.student.id);
    expect(sessionResult).toBeDefined();
    expect(Number(sessionResult?.averageScore)).toBe(75); // mean(80, 70)

    type SubjectAvg = { subjectId: string; averageScore: string; termsCounted: number };
    const subjectAverages = sessionResult?.subjectAverages as SubjectAvg[];
    const mathsAvg = subjectAverages.find((s) => s.subjectId === world.maths.id);
    const englishAvg = subjectAverages.find((s) => s.subjectId === world.english.id);
    expect(Number(mathsAvg?.averageScore)).toBe(80); // mean(60, 80, 100)
    expect(mathsAvg?.termsCounted).toBe(3);
    expect(Number(englishAvg?.averageScore)).toBe(70); // mean(50, 70, 90)
    expect(englishAvg?.termsCounted).toBe(3);
  });

  it("averages only over the terms actually FINALIZED — a missing term isn't zero, and a DRAFT term (even with a submitted subject result) is excluded", async () => {
    const world = await setupThreeTermSession();
    await finalizeTermWithScores(world, world.term1, 60, 60);
    await finalizeTermWithScores(world, world.term2, 80, 80);
    // term3: submitted and computed, but deliberately never finalized — a
    // real SubjectResult/Result exist for it, proving the exclusion is
    // driven by Result.status, not by absence of data.
    await computeWithoutFinalizing(world, world.term3, 0);

    const computeRes = await request(app)
      .post("/api/session-results/compute")
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ classId: world.klass.id, academicSessionId: world.session.id });

    const sessionResult = (
      computeRes.body as Array<{ studentId: string; averageScore: string; subjectAverages: unknown[] }>
    ).find((r) => r.studentId === world.student.id);
    type SubjectAvg = { subjectId: string; averageScore: string; termsCounted: number };
    const subjectAverages = sessionResult?.subjectAverages as SubjectAvg[];
    const mathsAvg = subjectAverages.find((s) => s.subjectId === world.maths.id);

    // (60 + 80) / 2 = 70 — never (60 + 80 + 0) / 3 = 46.67.
    expect(Number(mathsAvg?.averageScore)).toBe(70);
    expect(mathsAvg?.termsCounted).toBe(2);
  });

  it("uses the latest FINALIZED term's value, not an average, when sessionAverageMethod is FINAL_TERM_CARRIES", async () => {
    const world = await setupThreeTermSession();
    await request(app)
      .post(`/api/academic-sessions/${world.session.id}/grading-scale`)
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ sessionAverageMethod: "FINAL_TERM_CARRIES" });

    await finalizeTermWithScores(world, world.term1, 60, 55);
    await finalizeTermWithScores(world, world.term2, 80, 65);
    await finalizeTermWithScores(world, world.term3, 100, 95);

    const computeRes = await request(app)
      .post("/api/session-results/compute")
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ classId: world.klass.id, academicSessionId: world.session.id });

    const sessionResult = (
      computeRes.body as Array<{ studentId: string; averageScore: string; subjectAverages: unknown[] }>
    ).find((r) => r.studentId === world.student.id);
    type SubjectAvg = { subjectId: string; averageScore: string; termsCounted: number };
    const subjectAverages = sessionResult?.subjectAverages as SubjectAvg[];
    const mathsAvg = subjectAverages.find((s) => s.subjectId === world.maths.id);
    const englishAvg = subjectAverages.find((s) => s.subjectId === world.english.id);

    // term3's values carried forward directly — not mean(60,80,100)=80.
    expect(Number(mathsAvg?.averageScore)).toBe(100);
    expect(mathsAvg?.termsCounted).toBe(1);
    expect(Number(englishAvg?.averageScore)).toBe(95);
    expect(Number(sessionResult?.averageScore)).toBe(97.5); // mean(100, 95)
  });
});

// ---------------------------------------------------------------------------
// Feature B — report card snapshot fields + class-relative position
// ---------------------------------------------------------------------------

describe("Report card snapshots and class-relative position (Feature B)", () => {
  async function createClosedAttendanceSession(classId: string, academicSessionId: string, termId: string, date: Date, openedByUserId: string) {
    return prisma.attendanceSession.create({
      data: { classId, academicSessionId, termId, date, status: "CLOSED", openedByUserId },
    });
  }

  it("snapshots daysPresent/daysSchoolOpened at finalize time, and later attendance changes never touch the finalized result", async () => {
    const { token: adminToken, user: adminUser } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    const enrollment = await enrollStudent(student.id, klass.id, session.id);

    const day1 = await createClosedAttendanceSession(klass.id, session.id, term.id, new Date("2026-09-01"), adminUser.id);
    const day2 = await createClosedAttendanceSession(klass.id, session.id, term.id, new Date("2026-09-02"), adminUser.id);
    await prisma.attendanceRecord.create({
      data: { attendanceSessionId: day1.id, studentId: student.id, status: "PRESENT", recordedByUserId: adminUser.id },
    });
    await prisma.attendanceRecord.create({
      data: { attendanceSessionId: day2.id, studentId: student.id, status: "LATE", recordedByUserId: adminUser.id },
    });

    const result = await prisma.result.create({
      data: { studentId: student.id, enrollmentId: enrollment.id, termId: term.id, status: "DRAFT", averageScore: 80 },
    });

    const finalizeRes = await request(app)
      .post(`/api/results/${result.id}/finalize`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(finalizeRes.status).toBe(200);
    expect(finalizeRes.body.daysPresent).toBe(2); // PRESENT + LATE both count
    expect(finalizeRes.body.daysSchoolOpened).toBe(2);

    // A new CLOSED session, with the student PRESENT, added AFTER finalize —
    // if daysPresent/daysSchoolOpened were recomputed on read, this would
    // change them to 3.
    const day3 = await createClosedAttendanceSession(klass.id, session.id, term.id, new Date("2026-09-03"), adminUser.id);
    await prisma.attendanceRecord.create({
      data: { attendanceSessionId: day3.id, studentId: student.id, status: "PRESENT", recordedByUserId: adminUser.id },
    });

    const refreshed = await prisma.result.findUniqueOrThrow({ where: { id: result.id } });
    expect(refreshed.daysPresent).toBe(2);
    expect(refreshed.daysSchoolOpened).toBe(2);
  });

  it("ranks strictly among FINALIZED peers once the whole class is finalized — ties share a position, the next position skips", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");

    async function studentWithResult(admissionNumber: string, averageScore: number) {
      const student = await createBareStudent(admissionNumber);
      const enrollment = await enrollStudent(student.id, klass.id, session.id);
      const result = await prisma.result.create({
        data: { studentId: student.id, enrollmentId: enrollment.id, termId: term.id, status: "DRAFT", averageScore },
      });
      return { student, result };
    }

    const top = await studentWithResult("ADM-001", 90);
    const tiedA = await studentWithResult("ADM-002", 80);
    const tiedB = await studentWithResult("ADM-003", 80);
    const last = await studentWithResult("ADM-004", 70);

    // Finalize three of the four first — the class isn't complete yet, so
    // no position-fill should fire.
    for (const { result } of [top, tiedA, tiedB]) {
      await request(app).post(`/api/results/${result.id}/finalize`).set("Authorization", `Bearer ${adminToken}`);
    }
    const stillIncomplete = await prisma.result.findUniqueOrThrow({ where: { id: top.result.id } });
    expect(stillIncomplete.position).toBeNull();

    // The last student finalizes — this is the one that completes the class
    // and triggers the automatic class-wide ranking pass.
    const lastFinalizeRes = await request(app)
      .post(`/api/results/${last.result.id}/finalize`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(lastFinalizeRes.status).toBe(200);

    const [topResult, tiedAResult, tiedBResult, lastResult] = await Promise.all([
      prisma.result.findUniqueOrThrow({ where: { id: top.result.id } }),
      prisma.result.findUniqueOrThrow({ where: { id: tiedA.result.id } }),
      prisma.result.findUniqueOrThrow({ where: { id: tiedB.result.id } }),
      prisma.result.findUniqueOrThrow({ where: { id: last.result.id } }),
    ]);
    expect(topResult.position).toBe(1);
    expect(tiedAResult.position).toBe(2);
    expect(tiedBResult.position).toBe(2);
    expect(lastResult.position).toBe(4); // 3 skipped, not 3
    expect(topResult.outOf).toBe(4);
  });

  it("admin escape hatch (POST /classes/:id/results/:termId/rank) ranks whatever's FINALIZED even when the class never completes", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");

    const finalized = await createBareStudent("ADM-001");
    const finalizedEnrollment = await enrollStudent(finalized.id, klass.id, session.id);
    const finalizedResult = await prisma.result.create({
      data: {
        studentId: finalized.id,
        enrollmentId: finalizedEnrollment.id,
        termId: term.id,
        status: "DRAFT",
        averageScore: 65,
      },
    });

    // A second, permanently-incomplete student — e.g. withdrew mid-term.
    // Never finalized, so the class never reaches 100%.
    const incomplete = await createBareStudent("ADM-002");
    const incompleteEnrollment = await enrollStudent(incomplete.id, klass.id, session.id);
    await prisma.result.create({
      data: {
        studentId: incomplete.id,
        enrollmentId: incompleteEnrollment.id,
        termId: term.id,
        status: "DRAFT",
        averageScore: 50,
      },
    });

    await request(app)
      .post(`/api/results/${finalizedResult.id}/finalize`)
      .set("Authorization", `Bearer ${adminToken}`);
    const stillNull = await prisma.result.findUniqueOrThrow({ where: { id: finalizedResult.id } });
    expect(stillNull.position).toBeNull();

    const rankRes = await request(app)
      .post(`/api/classes/${klass.id}/results/${term.id}/rank`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(rankRes.status).toBe(200);

    const ranked = await prisma.result.findUniqueOrThrow({ where: { id: finalizedResult.id } });
    expect(ranked.position).toBe(1);
    expect(ranked.outOf).toBe(1); // only the FINALIZED one is ranked, not the incomplete one
  });
});

// ---------------------------------------------------------------------------
// Feature D — fee withholding
// ---------------------------------------------------------------------------

describe("Fee withholding (Feature D)", () => {
  async function setupWithholdingWorld() {
    const { token: adminToken, user: adminUser } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const { student, token: studentToken } = await createStudentWithLogin("student@test.local", "ADM-001");
    const enrollment = await enrollStudent(student.id, klass.id, session.id);
    const { parent, token: parentToken } = await createParent("parent@test.local");
    await prisma.studentParent.create({
      data: { studentId: student.id, parentId: parent.id, relationship: "MOTHER" },
    });

    const result = await prisma.result.create({
      data: {
        studentId: student.id,
        enrollmentId: enrollment.id,
        termId: term.id,
        status: "FINALIZED",
        averageScore: 75,
        finalizedByUserId: adminUser.id,
        finalizedAt: new Date(),
      },
    });

    const feeStructure = await prisma.feeStructure.create({
      data: { name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 100_000 },
    });
    const obligation = await prisma.feeObligation.create({
      data: {
        studentId: student.id,
        feeStructureId: feeStructure.id,
        academicSessionId: session.id,
        termId: term.id,
        amountDueKobo: 100_000,
        status: "PENDING",
        createdByUserId: adminUser.id,
      },
    });

    return { adminToken, parentToken, studentToken, session, term, klass, result, obligation };
  }

  async function confirmPayment(obligationId: string, amountKobo: number, adminToken: string) {
    const payment = await request(app)
      .post(`/api/fee-obligations/${obligationId}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo, paymentDate: "2026-09-10" });
    await request(app).post(`/api/payments/${payment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);
  }

  it("withholds a FINALIZED result from PARENT/STUDENT with a 402 while any balance is outstanding — even a partial payment", async () => {
    const world = await setupWithholdingWorld();

    const asParentUnpaid = await request(app)
      .get(`/api/results/${world.result.studentId}/${world.term.id}`)
      .set("Authorization", `Bearer ${world.parentToken}`);
    expect(asParentUnpaid.status).toBe(402);
    expect(asParentUnpaid.body.error.code).toBe("PAYMENT_REQUIRED");
    expect(asParentUnpaid.body.error.details.outstandingKobo).toBe(100_000);

    await confirmPayment(world.obligation.id, 40_000, world.adminToken);
    const asParentPartial = await request(app)
      .get(`/api/results/${world.result.studentId}/${world.term.id}`)
      .set("Authorization", `Bearer ${world.parentToken}`);
    expect(asParentPartial.status).toBe(402);
    expect(asParentPartial.body.error.details.outstandingKobo).toBe(60_000);

    const asStudentPartial = await request(app)
      .get(`/api/results/${world.result.studentId}/${world.term.id}`)
      .set("Authorization", `Bearer ${world.studentToken}`);
    expect(asStudentPartial.status).toBe(402);

    await confirmPayment(world.obligation.id, 60_000, world.adminToken);
    const asParentPaid = await request(app)
      .get(`/api/results/${world.result.studentId}/${world.term.id}`)
      .set("Authorization", `Bearer ${world.parentToken}`);
    expect(asParentPaid.status).toBe(200);
  });

  // ADMIN, per the batch spec's "ADMIN, BURSAR and TEACHER always see it
  // regardless of fee status." BURSAR is NOT asserted "allowed" here: this
  // route's authorization gate is canReadStudent (unchanged by this batch),
  // which has never had a BURSAR branch — a bursar has always gotten 403 on
  // GET /api/results/:studentId/:termId, before withholding logic is ever
  // reached, independent of any fee-related concern. The spec's "BURSAR
  // always sees it" describes withholding's own exemption list, not a claim
  // that BURSAR already holds read access to results at all — flagged in
  // the report rather than silently widening canReadStudent to add BURSAR,
  // which would be a real, undiscussed authorization-scope change.
  it("ADMIN always sees the result regardless of fee status — withholding is parent-facing, not an authorization rule", async () => {
    const world = await setupWithholdingWorld();

    const asAdmin = await request(app)
      .get(`/api/results/${world.result.studentId}/${world.term.id}`)
      .set("Authorization", `Bearer ${world.adminToken}`);
    expect(asAdmin.status).toBe(200);
  });

  it("ADMIN release makes it visible to the parent again, with the balance still outstanding — audited with a required reason, and idempotent on a second release", async () => {
    const world = await setupWithholdingWorld();

    const releaseRes = await request(app)
      .post(`/api/results/${world.result.id}/release-withholding`)
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ reason: "Bursar approved a payment plan for this family" });
    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body.feeWithholdingReleased).toBe(true);

    const asParent = await request(app)
      .get(`/api/results/${world.result.studentId}/${world.term.id}`)
      .set("Authorization", `Bearer ${world.parentToken}`);
    expect(asParent.status).toBe(200);

    const obligationAfter = await prisma.feeObligation.findUniqueOrThrow({ where: { id: world.obligation.id } });
    expect(obligationAfter.status).toBe("PENDING"); // release doesn't touch the debt itself

    const overrideRows = await prisma.resultOverride.findMany({ where: { resultId: world.result.id } });
    expect(overrideRows).toHaveLength(1);
    expect(overrideRows[0]?.fieldName).toBe("feeWithholdingReleased");
    expect(overrideRows[0]?.reason).toBe("Bursar approved a payment plan for this family");

    // Releasing an already-released result is idempotent — 200, not 409,
    // and no second audit row.
    const secondReleaseRes = await request(app)
      .post(`/api/results/${world.result.id}/release-withholding`)
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ reason: "Confirming the release again" });
    expect(secondReleaseRes.status).toBe(200);
    const overrideRowsAfterSecond = await prisma.resultOverride.findMany({ where: { resultId: world.result.id } });
    expect(overrideRowsAfterSecond).toHaveLength(1);
  });

  it("holds on all three withholding-checked read paths: the per-term read, the cross-term list, and the session-result read", async () => {
    const world = await setupWithholdingWorld();

    const perTerm = await request(app)
      .get(`/api/results/${world.result.studentId}/${world.term.id}`)
      .set("Authorization", `Bearer ${world.parentToken}`);
    expect(perTerm.status).toBe(402);

    const crossTermList = await request(app)
      .get(`/api/students/${world.result.studentId}/results`)
      .set("Authorization", `Bearer ${world.parentToken}`);
    expect(crossTermList.status).toBe(200);
    expect(crossTermList.body).toHaveLength(1);
    expect(crossTermList.body[0].status).toBe("WITHHELD");
    expect(crossTermList.body[0].outstandingKobo).toBe(100_000);
    expect(crossTermList.body[0].totalScore).toBeUndefined(); // reduced shape, not the full Result

    await request(app)
      .post("/api/session-results/compute")
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ classId: world.klass.id, academicSessionId: world.session.id });

    const sessionResultRead = await request(app)
      .get(`/api/session-results/${world.result.studentId}/${world.session.id}`)
      .set("Authorization", `Bearer ${world.parentToken}`);
    expect(sessionResultRead.status).toBe(402);
  });
});
