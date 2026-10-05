import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createBursar,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createStudentWithLogin,
  createSubject,
  createTeacher,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();
let server: Server;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

function checkByKey(body: { checks: { key: string; status: string; message: string }[] }, key: string) {
  const found = body.checks.find((c) => c.key === key);
  expect(found, `expected a check with key "${key}"`).toBeDefined();
  return found!;
}

describe("GET /api/admin/setup-status", () => {
  it("rejects TEACHER, BURSAR, PARENT and STUDENT with 403", async () => {
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { token: bursarToken } = await createBursar("bursar@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const { token: studentToken } = await createStudentWithLogin("student@test.local", "FIA/2026/001");

    for (const token of [teacherToken, bursarToken, parentToken, studentToken]) {
      const res = await request(server)
        .get("/api/admin/setup-status")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    }
  });

  // Approximates "a freshly seeded database" (prisma/seed.ts creates a
  // bootstrap admin with no Staff record, no session, no structure) via a
  // bare ADMIN actor with no linked Staff row — createAdmin() never
  // creates one, matching the bootstrap shape exactly — rather than
  // literally running the seed script inside a test.
  it("on a database with only a bootstrap-shaped admin, is not ready and FAILs every dependent check", async () => {
    const { token } = await createAdmin("admin@test.local");

    const res = await request(server).get("/api/admin/setup-status").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    for (const key of [
      "school",
      "currentSession",
      "currentTerm",
      "assessmentComponents",
      "gradingScale",
      "behaviourSkillsTraits",
      "structure",
      "adminAccount",
    ]) {
      expect(checkByKey(res.body, key).status, `expected ${key} to FAIL`).toBe("FAIL");
    }
  });

  it("performs no writes", async () => {
    const { token } = await createAdmin("admin@test.local");
    const countsBefore = await Promise.all([
      prisma.school.count(),
      prisma.academicSession.count(),
      prisma.term.count(),
      prisma.assessmentComponent.count(),
      prisma.gradingScale.count(),
      prisma.trait.count(),
      prisma.subject.count(),
      prisma.class.count(),
      prisma.timeSlot.count(),
      prisma.user.count(),
    ]);

    const res = await request(server).get("/api/admin/setup-status").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const countsAfter = await Promise.all([
      prisma.school.count(),
      prisma.academicSession.count(),
      prisma.term.count(),
      prisma.assessmentComponent.count(),
      prisma.gradingScale.count(),
      prisma.trait.count(),
      prisma.subject.count(),
      prisma.class.count(),
      prisma.timeSlot.count(),
      prisma.user.count(),
    ]);
    expect(countsAfter).toEqual(countsBefore);
  });

  it("school: FAILs with no School row, WARNs with one missing contact fields, PASSes when complete", async () => {
    const { token } = await createAdmin("admin@test.local");
    const headers = { Authorization: `Bearer ${token}` };

    const before = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(before.body, "school").status).toBe("FAIL");

    await prisma.school.create({ data: { name: "Test School" } });
    const warnRes = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(warnRes.body, "school").status).toBe("WARN");

    await prisma.school.updateMany({
      data: { address: "1 Test Rd", contactEmail: "info@test.local", contactPhone: "+2340000000" },
    });
    const passRes = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(passRes.body, "school").status).toBe("PASS");
  });

  it("current academic session: FAILs with none current, PASSes once one is marked current", async () => {
    const { token } = await createAdmin("admin@test.local");
    const headers = { Authorization: `Bearer ${token}` };

    const before = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(before.body, "currentSession").status).toBe("FAIL");

    await createCurrentAcademicSession("2026/2027");
    const after = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(after.body, "currentSession").status).toBe("PASS");
  });

  it("current term: FAILs with none current in the current session, PASSes once one is", async () => {
    const { token } = await createAdmin("admin@test.local");
    const headers = { Authorization: `Bearer ${token}` };
    const session = await createCurrentAcademicSession("2026/2027");

    const before = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(before.body, "currentTerm").status).toBe("FAIL");

    await prisma.term.create({
      data: {
        academicSessionId: session.id,
        name: "First Term",
        order: 1,
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-12-12"),
        isCurrent: true,
      },
    });
    const after = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(after.body, "currentTerm").status).toBe("PASS");
  });

  it("assessment components: 99 FAILs, 100 PASSes", async () => {
    const { token } = await createAdmin("admin@test.local");
    const headers = { Authorization: `Bearer ${token}` };
    const session = await createCurrentAcademicSession("2026/2027");

    await prisma.assessmentComponent.create({
      data: { academicSessionId: session.id, code: "CA", name: "CA", type: "CA", maxScore: 39, order: 1 },
    });
    await prisma.assessmentComponent.create({
      data: { academicSessionId: session.id, code: "EXAM", name: "Exam", type: "EXAM", maxScore: 60, order: 2 },
    });
    const ninetyNine = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(ninetyNine.body, "assessmentComponents").status).toBe("FAIL");

    await prisma.assessmentComponent.update({
      where: { academicSessionId_code: { academicSessionId: session.id, code: "CA" } },
      data: { maxScore: 40 },
    });
    const oneHundred = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(oneHundred.body, "assessmentComponents").status).toBe("PASS");
  });

  it("grading scale: a gap FAILs, full coverage PASSes, and overlapping bands FAIL", async () => {
    const { token } = await createAdmin("admin@test.local");
    const headers = { Authorization: `Bearer ${token}` };
    const session = await createCurrentAcademicSession("2026/2027");

    const noScale = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(noScale.body, "gradingScale").status).toBe("FAIL");

    const scale = await prisma.gradingScale.create({ data: { academicSessionId: session.id } });
    // Gap: nothing covers 50-69.
    await prisma.gradeBand.create({ data: { gradingScaleId: scale.id, grade: "F", minScore: 0, maxScore: 49.99 } });
    await prisma.gradeBand.create({ data: { gradingScaleId: scale.id, grade: "A", minScore: 70, maxScore: 100 } });
    const gapRes = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(gapRes.body, "gradingScale").status).toBe("FAIL");

    await prisma.gradeBand.create({ data: { gradingScaleId: scale.id, grade: "B", minScore: 50, maxScore: 69.99 } });
    const coveredRes = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(coveredRes.body, "gradingScale").status).toBe("PASS");

    // Overlap: B's range now swallows part of A's.
    await prisma.gradeBand.update({
      where: { gradingScaleId_grade: { gradingScaleId: scale.id, grade: "B" } },
      data: { maxScore: 75 },
    });
    const overlapRes = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(overlapRes.body, "gradingScale").status).toBe("FAIL");
  });

  it("behaviour and skills traits: FAILs with none seeded, PASSes with both categories present", async () => {
    const { token } = await createAdmin("admin@test.local");
    const headers = { Authorization: `Bearer ${token}` };
    const session = await createCurrentAcademicSession("2026/2027");

    const before = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(before.body, "behaviourSkillsTraits").status).toBe("FAIL");

    // RatingScaleLevel is static reference data resetDb() deliberately
    // never clears (same treatment as Surah) — upsert, not create, since a
    // prior test in this run may already have seeded value: 5.
    await prisma.ratingScaleLevel.upsert({
      where: { value: 5 },
      update: {},
      create: { value: 5, label: "Excellent" },
    });
    await prisma.trait.create({
      data: { academicSessionId: session.id, category: "AFFECTIVE", name: "Punctuality", order: 1 },
    });
    await prisma.trait.create({
      data: { academicSessionId: session.id, category: "PSYCHOMOTOR", name: "Handwriting", order: 1 },
    });
    const after = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(after.body, "behaviourSkillsTraits").status).toBe("PASS");
  });

  it("structure: FAILs with no subjects/classes/time slots, PASSes once all three exist", async () => {
    const { token } = await createAdmin("admin@test.local");
    const headers = { Authorization: `Bearer ${token}` };

    const before = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(before.body, "structure").status).toBe("FAIL");

    await createSubject("Mathematics", "MTH");
    await createClass("JSS1", "A");
    await prisma.timeSlot.create({ data: { name: "Period 1", startTime: "08:00", endTime: "08:40", order: 1 } });
    const after = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(after.body, "structure").status).toBe("PASS");
  });

  it("admin account: FAILs with only a bootstrap-shaped admin; a staff-linked admin PASSes and surfaces the bootstrap warning", async () => {
    // The literal bootstrap email the setup-status check looks for —
    // distinct from the token-bearing actor below, so this test proves the
    // WARN row independently of who happens to be calling the route.
    const { token } = await createAdmin("admin@school.test");
    const headers = { Authorization: `Bearer ${token}` };

    const before = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(before.body, "adminAccount").status).toBe("FAIL");
    expect(checkByKey(before.body, "bootstrapAdmin").status).toBe("WARN");

    const realAdminUser = await prisma.user.create({
      data: {
        loginId: "FIA/ST2026/001",
        email: "real.admin@test.local",
        passwordHash: "x",
        roles: { create: [{ role: "ADMIN" }] },
      },
    });
    await prisma.staff.create({
      data: {
        userId: realAdminUser.id,
        staffNumber: "FIA/ST2026/001",
        firstName: "Real",
        lastName: "Admin",
      },
    });
    const after = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(after.body, "adminAccount").status).toBe("PASS");
    expect(checkByKey(after.body, "bootstrapAdmin").status).toBe("WARN");
  });

  it("demo data: WARNs when an @example.com account exists", async () => {
    const { token } = await createAdmin("admin@test.local");
    const headers = { Authorization: `Bearer ${token}` };

    const clean = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(clean.body, "demoData").status).toBe("PASS");

    await prisma.user.create({
      data: { loginId: "demo@example.com", email: "demo@example.com", passwordHash: "x", roles: { create: [{ role: "PARENT" }] } },
    });
    const dirty = await request(server).get("/api/admin/setup-status").set(headers);
    expect(checkByKey(dirty.body, "demoData").status).toBe("WARN");
  });
});
