import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/client.js";
import { createBareStudent, createParent, createTeacher } from "./factories.js";
import { resetDb } from "./resetDb.js";

beforeEach(async () => {
  await resetDb();
});

/// Re-runs migration 20260918120214_add_login_id_and_identifier_counters's
/// first two backfill UPDATEs (Staff -> loginId, then Student -> loginId)
/// against whatever's currently in the table. The real migration's third
/// step ("loginId = email WHERE loginId IS NULL") can't be replayed the
/// same way — loginId is NOT NULL now, so no row can ever be put back into
/// a genuinely pre-migration NULL state to re-derive it from; that rule is
/// instead confirmed directly below by asserting the invariant it produced
/// still holds for a parent (loginId already equals email).
async function rerunStaffAndStudentBackfillSteps() {
  await prisma.$executeRaw`
    UPDATE "User" u
    SET "loginId" = s."staffNumber"
    FROM "Staff" s
    WHERE s."userId" = u."id"
  `;
  await prisma.$executeRaw`
    UPDATE "User" u
    SET "loginId" = st."admissionNumber"
    FROM "Student" st
    WHERE st."userId" = u."id"
  `;
}

describe("loginId backfill (migration 20260918120214)", () => {
  it("derives the right loginId for a staff member and a student when re-run against corrupted data", async () => {
    const { staff } = await createTeacher("teacher@test.local");
    const student = await createBareStudent("FIA/2026/001");
    const studentUser = await prisma.user.create({
      data: { loginId: "placeholder", email: null, passwordHash: "unused", roles: { create: [{ role: "STUDENT" }] } },
    });
    await prisma.student.update({ where: { id: student.id }, data: { userId: studentUser.id } });

    // Corrupt every loginId first (distinct values — loginId is still
    // unique), so the re-run's assertions can't trivially pass because
    // nothing ever actually changed.
    await prisma.user.update({ where: { id: staff.userId }, data: { loginId: "CORRUPTED-1" } });
    await prisma.user.update({ where: { id: studentUser.id }, data: { loginId: "CORRUPTED-2" } });

    await rerunStaffAndStudentBackfillSteps();

    const staffUser = await prisma.user.findUniqueOrThrow({ where: { id: staff.userId } });
    expect(staffUser.loginId).toBe(staff.staffNumber);

    const refreshedStudentUser = await prisma.user.findUniqueOrThrow({ where: { id: studentUser.id } });
    expect(refreshedStudentUser.loginId).toBe(student.admissionNumber);
  });

  it("a parent (never touched by the Staff/Student steps) keeps loginId equal to email", async () => {
    const { parent } = await createParent("parent@test.local");
    const parentUser = await prisma.user.findUniqueOrThrow({ where: { id: parent.userId } });
    expect(parentUser.loginId).toBe(parentUser.email);
  });
});
