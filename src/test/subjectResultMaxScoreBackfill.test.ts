import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/client.js";
import {
  createAssessmentComponent,
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

beforeEach(async () => {
  await resetDb();
});

/// Migration 20260927120000_add_enrollment_closing_gradename_maxscore's own
/// backfill UPDATE, verbatim — re-run here against freshly-built fixtures
/// standing in for "a SubjectResult row that existed before this column
/// did" (built directly via prisma.subjectResult.create with maxScore left
/// unset, never through submitScores, which always writes it).
async function rerunMaxScoreBackfill(): Promise<void> {
  await prisma.$executeRaw`
    WITH component_totals AS (
      SELECT csa."id" AS "assignmentId", SUM(ac."maxScore") AS "total"
      FROM "ClassSubjectAssignment" csa
      JOIN "AssessmentComponent" ac ON ac."academicSessionId" = csa."academicSessionId"
      GROUP BY csa."id"
    )
    UPDATE "SubjectResult" sr
    SET "maxScore" = ct."total"
    FROM component_totals ct
    WHERE sr."classSubjectAssignmentId" = ct."assignmentId"
      AND sr."maxScore" IS NULL
  `;
}

describe("SubjectResult.maxScore backfill (migration 20260927120000)", () => {
  it("derives the correct sum from the row's own session's components", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    await createAssessmentComponent(session.id, "CA1", "CA", 20, 1);
    await createAssessmentComponent(session.id, "EXAM", "EXAM", 80, 2);
    const { staff } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const preMigrationRow = await prisma.subjectResult.create({
      data: {
        studentId: student.id,
        classSubjectAssignmentId: assignment.id,
        termId: term.id,
        totalScore: 78,
        status: "SUBMITTED",
      },
    });
    expect(preMigrationRow.maxScore).toBeNull();

    await rerunMaxScoreBackfill();

    const backfilled = await prisma.subjectResult.findUniqueOrThrow({ where: { id: preMigrationRow.id } });
    expect(backfilled.maxScore?.toNumber()).toBe(100);
  });

  it("leaves maxScore null for a row whose session has zero components configured", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    // Deliberately no createAssessmentComponent call for this session.
    const { staff } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const student = await createBareStudent("ADM-002");
    await enrollStudent(student.id, klass.id, session.id);

    const row = await prisma.subjectResult.create({
      data: {
        studentId: student.id,
        classSubjectAssignmentId: assignment.id,
        termId: term.id,
        totalScore: 0,
        status: "SUBMITTED",
      },
    });

    await rerunMaxScoreBackfill();

    const stillNull = await prisma.subjectResult.findUniqueOrThrow({ where: { id: row.id } });
    expect(stillNull.maxScore).toBeNull();
  });

  it("never overwrites a row that already has a maxScore, even if components have since changed", async () => {
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    await createAssessmentComponent(session.id, "CA1", "CA", 20, 1);
    await createAssessmentComponent(session.id, "EXAM", "EXAM", 80, 2);
    const { staff } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const student = await createBareStudent("ADM-003");
    await enrollStudent(student.id, klass.id, session.id);

    const alreadySnapshotted = await prisma.subjectResult.create({
      data: {
        studentId: student.id,
        classSubjectAssignmentId: assignment.id,
        termId: term.id,
        totalScore: 78,
        maxScore: 100,
        status: "SUBMITTED",
      },
    });

    await rerunMaxScoreBackfill();

    const untouched = await prisma.subjectResult.findUniqueOrThrow({ where: { id: alreadySnapshotted.id } });
    expect(untouched.maxScore?.toNumber()).toBe(100);
  });
});
