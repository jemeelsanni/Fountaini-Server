import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
} from "../test/factories.js";
import { resetDb } from "../test/resetDb.js";
import { checkDbEmpty } from "./dbEmptyCheck.js";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

// Never actually read when allowDemoOnly is false, or when the DB is
// already empty — a path that plainly doesn't exist stands in for "no
// manifest given" without needing a real missing-file fixture.
const NO_MANIFEST_PATH = "/nonexistent/prisma/demo-seed-manifest.json";

let tmpDirs: string[] = [];
function writeManifest(ids: { studentIds?: string[]; parentIds?: string[]; staffIds?: string[] }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "db-empty-check-"));
  tmpDirs.push(dir);
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ studentIds: [], parentIds: [], staffIds: [], ...ids }),
  );
  return manifestPath;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("checkDbEmpty", () => {
  it("passes on a freshly reset (empty) database, regardless of allowDemoOnly", async () => {
    const result = await checkDbEmpty({ allowDemoOnly: false, manifestPath: NO_MANIFEST_PATH });
    expect(result.empty).toBe(true);
    expect(result.counts).toEqual({ students: 0, parents: 0, payments: 0, results: 0, scores: 0, staff: 0 });
  });

  it("fails when rows exist and allowDemoOnly is false", async () => {
    await createBareStudent("ADM-001");

    const result = await checkDbEmpty({ allowDemoOnly: false, manifestPath: NO_MANIFEST_PATH });
    expect(result.empty).toBe(false);
    expect(result.counts.students).toBe(1);
    expect(result.allowedByManifest).toBe(false);
    expect(result.manifestMissing).toBe(false);
  });

  it("--allow-demo-only refuses unconditionally when the manifest file is missing", async () => {
    await createBareStudent("ADM-001");

    const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath: NO_MANIFEST_PATH });
    expect(result.empty).toBe(false);
    expect(result.manifestMissing).toBe(true);
    expect(result.allowedByManifest).toBe(false);
  });

  it("--allow-demo-only fails when a row exists that isn't listed in the manifest", async () => {
    const accounted = await createBareStudent("ADM-001");
    await createBareStudent("ADM-002"); // not listed below
    const manifestPath = writeManifest({ studentIds: [accounted.id] });

    const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath });
    expect(result.empty).toBe(false);
    expect(result.manifestMissing).toBe(false);
    expect(result.allowedByManifest).toBe(false);
    expect(result.unaccounted?.students).toBe(1);
  });

  it("--allow-demo-only passes when every row present is listed in the manifest", async () => {
    const a = await createBareStudent("ADM-001");
    const b = await createBareStudent("ADM-002");
    const manifestPath = writeManifest({ studentIds: [a.id, b.id] });

    const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath });
    expect(result.empty).toBe(false);
    expect(result.allowedByManifest).toBe(true);
    expect(result.unaccounted).toEqual({ students: 0, parents: 0, payments: 0, results: 0, scores: 0, staff: 0 });
  });

  // Payment/Result/Score aren't tracked by their own id in the demo seed
  // manifest at all — only students, parents and staff are (see
  // checkDbEmpty's own comment on why: verified TRANSITIVELY via studentId
  // instead). That's the one part of this guard that was previously
  // unverified by a real test, just assumed correct because the query
  // shape matches the student/parent/staff checks that ARE tested above.
  // This guard stands directly in front of `prisma migrate reset --force`
  // — the most destructive command in this project — so each of the three
  // gets its own dedicated proof, not an assumption.
  describe("Payment/Result/Score are verified transitively via studentId, not just Student/Parent/Staff directly", () => {
    it("one Payment row, for a student NOT in the manifest, makes --allow-demo-only fail", async () => {
      const accountedStudent = await createBareStudent("ADM-ACC-001");
      const unaccountedStudent = await createBareStudent("ADM-UNACC-001");
      const session = await createCurrentAcademicSession("2026/2027");
      const klass = await createClass("JSS1", "A");
      const structure = await prisma.feeStructure.create({
        data: { name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 1_000_000 },
      });
      const obligation = await prisma.feeObligation.create({
        data: {
          studentId: unaccountedStudent.id,
          feeStructureId: structure.id,
          academicSessionId: session.id,
          amountDueKobo: 1_000_000,
          createdByUserId: "test-fixture",
        },
      });
      await prisma.payment.create({
        data: {
          feeObligationId: obligation.id,
          amountKobo: 1_000_000,
          paymentDate: new Date("2026-09-10"),
          recordedByUserId: "test-fixture",
        },
      });

      // Only the OTHER student (not the one the payment belongs to) is listed.
      const manifestPath = writeManifest({ studentIds: [accountedStudent.id] });
      const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath });

      expect(result.allowedByManifest).toBe(false);
      expect(result.unaccounted?.payments).toBe(1);
    });

    it("one Result row, for a student NOT in the manifest, makes --allow-demo-only fail", async () => {
      const accountedStudent = await createBareStudent("ADM-ACC-002");
      const unaccountedStudent = await createBareStudent("ADM-UNACC-002");
      const session = await createCurrentAcademicSession("2026/2027");
      const term = await createTermForSession(session.id, "First Term", 1);
      const klass = await createClass("JSS1", "A");
      const enrollment = await enrollStudent(unaccountedStudent.id, klass.id, session.id);
      await prisma.result.create({
        data: { studentId: unaccountedStudent.id, enrollmentId: enrollment.id, termId: term.id, status: "DRAFT" },
      });

      const manifestPath = writeManifest({ studentIds: [accountedStudent.id] });
      const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath });

      expect(result.allowedByManifest).toBe(false);
      expect(result.unaccounted?.results).toBe(1);
    });

    it("one Score row, for a student NOT in the manifest, makes --allow-demo-only fail", async () => {
      const accountedStudent = await createBareStudent("ADM-ACC-003");
      const unaccountedStudent = await createBareStudent("ADM-UNACC-003");
      const session = await createCurrentAcademicSession("2026/2027");
      const term = await createTermForSession(session.id, "First Term", 1);
      const klass = await createClass("JSS1", "A");
      const subject = await createSubject("Mathematics", "MTH");
      const { staff } = await createTeacher("teacher@test.local");
      const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
      const component = await createAssessmentComponent(session.id, "CA", "CA", 40, 1);
      await prisma.score.create({
        data: {
          studentId: unaccountedStudent.id,
          classSubjectAssignmentId: assignment.id,
          termId: term.id,
          assessmentComponentId: component.id,
          rawScore: 30,
          enteredByUserId: "test-fixture",
        },
      });

      const manifestPath = writeManifest({ studentIds: [accountedStudent.id] });
      const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath });

      expect(result.allowedByManifest).toBe(false);
      expect(result.unaccounted?.scores).toBe(1);
    });
  });
});
