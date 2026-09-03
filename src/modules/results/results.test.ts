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
