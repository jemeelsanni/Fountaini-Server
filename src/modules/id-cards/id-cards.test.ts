import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
  createTeacher,
  enrollStudent,
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

describe("GET /api/id-cards/students/:id", () => {
  it("returns name, admission number, registration date, current class, active QR code and school header", async () => {
    const { token } = await createAdmin("admin@test.local");
    await prisma.school.create({ data: { name: "Fountain-i Academy", address: "1 School Road" } });
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("FIA/2026/001", { firstName: "Aisha" });
    await enrollStudent(student.id, klass.id, session.id);
    await prisma.studentQrCode.create({ data: { studentId: student.id, code: "old", isActive: false } });
    await prisma.studentQrCode.create({ data: { studentId: student.id, code: "current", version: 2 } });

    const res = await request(server).get(`/api/id-cards/students/${student.id}`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      admissionNumber: "FIA/2026/001",
      firstName: "Aisha",
      registeredAt: student.admissionDate.toISOString(),
      class: { id: klass.id, name: "JSS1 A" },
      academicSession: { id: session.id, name: "2026/2027" },
      qrCode: { code: "current", version: 2 },
      school: { name: "Fountain-i Academy", address: "1 School Road" },
    });
  });

  it("returns qrCode, class and school as null rather than failing when none exist", async () => {
    const { token } = await createAdmin("admin@test.local");
    const student = await createBareStudent("FIA/2026/002");

    const res = await request(server).get(`/api/id-cards/students/${student.id}`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.qrCode).toBeNull();
    expect(res.body.class).toBeNull();
    expect(res.body.school).toBeNull();
    expect(await prisma.studentQrCode.count({ where: { studentId: student.id } })).toBe(0);
  });

  it("404s for a soft-deleted student", async () => {
    const { token } = await createAdmin("admin@test.local");
    const student = await createBareStudent("FIA/2026/003");
    await prisma.student.update({ where: { id: student.id }, data: { deletedAt: new Date() } });

    const res = await request(server).get(`/api/id-cards/students/${student.id}`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe("GET /api/id-cards/students?classId=", () => {
  it("lists ACTIVE-enrolled, non-deleted students in the class, ordered by name", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const other = await createClass("JSS1", "B");
    const zainab = await prisma.student.create({
      data: { admissionNumber: "FIA/2026/010", firstName: "Zainab", lastName: "Yusuf" },
    });
    const ahmed = await prisma.student.create({
      data: { admissionNumber: "FIA/2026/011", firstName: "Ahmed", lastName: "Bello" },
    });
    const withdrawn = await createBareStudent("FIA/2026/012");
    const deleted = await createBareStudent("FIA/2026/013");
    const elsewhere = await createBareStudent("FIA/2026/014");
    for (const s of [zainab, ahmed, withdrawn, deleted]) {
      await enrollStudent(s.id, klass.id, session.id);
    }
    await enrollStudent(elsewhere.id, other.id, session.id);
    await prisma.enrollment.updateMany({ where: { studentId: withdrawn.id }, data: { status: "WITHDRAWN" } });
    await prisma.student.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    const res = await request(server)
      .get("/api/id-cards/students")
      .query({ classId: klass.id })
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((card: { id: string }) => card.id)).toEqual([ahmed.id, zainab.id]);
  });

  it("400s without a classId", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(server).get("/api/id-cards/students").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/id-cards/staff", () => {
  it("returns a staff card with staff number, roles and registration date", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("teacher@test.local");
    await prisma.staff.update({ where: { id: staff.id }, data: { department: "Sciences" } });

    const res = await request(server).get(`/api/id-cards/staff/${staff.id}`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      staffNumber: staff.staffNumber,
      fullName: "Test Teacher",
      department: "Sciences",
      roles: ["TEACHER"],
      email: "teacher@test.local",
      registeredAt: staff.createdAt.toISOString(),
    });
  });

  it("lists only active staff", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff: active } = await createTeacher("active@test.local");
    const { staff: inactive } = await createTeacher("inactive@test.local");
    await prisma.staff.update({ where: { id: inactive.id }, data: { isActive: false } });

    const res = await request(server).get("/api/id-cards/staff").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((card: { id: string }) => card.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);
  });

  it("404s for an unknown staff id", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(server).get("/api/id-cards/staff/does-not-exist").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("access", () => {
  it("rejects a non-admin on every id-card route", async () => {
    const { token, staff } = await createTeacher("teacher@test.local");
    const student = await createBareStudent("FIA/2026/020");
    const klass = await createClass("JSS1", "A");
    const auth = { Authorization: `Bearer ${token}` };

    expect((await request(server).get(`/api/id-cards/students/${student.id}`).set(auth)).status).toBe(403);
    expect((await request(server).get("/api/id-cards/students").query({ classId: klass.id }).set(auth)).status).toBe(
      403,
    );
    expect((await request(server).get(`/api/id-cards/staff/${staff.id}`).set(auth)).status).toBe(403);
    expect((await request(server).get("/api/id-cards/staff").set(auth)).status).toBe(403);
  });
});
