import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { setCurrentAcademicSession, setCurrentTerm } from "./academic-structure.service.js";
import {
  createAdmin,
  createAssessmentComponent,
  createAssignment,
  createBursar,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createStudentWithLogin,
  createSubject,
  createTeacher,
  createTermForSession,
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

describe("academic sessions", () => {
  it("allows an admin to create a session", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");

    const asAdmin = await request(server)
      .post("/api/academic-sessions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" });
    expect(asAdmin.status).toBe(201);
  });

  it("rejects endDate before startDate", async () => {
    const { token } = await createAdmin("admin@test.local");

    const res = await request(server)
      .post("/api/academic-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "2026/2027", startDate: "2027-07-31", endDate: "2026-09-01" });

    expect(res.status).toBe(400);
  });

  it("rejects a duplicate session name", async () => {
    const { token } = await createAdmin("admin@test.local");
    const body = { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" };

    await request(server).post("/api/academic-sessions").set("Authorization", `Bearer ${token}`).send(body);
    const res = await request(server)
      .post("/api/academic-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(409);
  });

  it("set-current clears isCurrent on every other session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const a = await prisma.academicSession.create({
      data: { name: "A", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31"), isCurrent: true },
    });
    const b = await prisma.academicSession.create({
      data: { name: "B", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    const res = await request(server)
      .patch(`/api/academic-sessions/${b.id}/set-current`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const refreshedA = await prisma.academicSession.findUniqueOrThrow({ where: { id: a.id } });
    const refreshedB = await prisma.academicSession.findUniqueOrThrow({ where: { id: b.id } });
    expect(refreshedA.isCurrent).toBe(false);
    expect(refreshedB.isCurrent).toBe(true);
  });

  it("switching current session to several different targets concurrently leaves exactly one current row", async () => {
    // A plain updateMany(clear others)-then-update(set self) has a real gap
    // under 3-or-more-way concurrency (see the fix's comment in
    // academic-structure.service.ts) that isn't reliably exposed by only 2
    // concurrent switches — this uses 4 to reproduce it consistently.
    await prisma.academicSession.create({
      data: { name: "A", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31"), isCurrent: true },
    });
    const targets = await Promise.all(
      ["B", "C", "D", "E"].map((name, i) =>
        prisma.academicSession.create({
          data: {
            name,
            startDate: new Date(2026 + i, 8, 1),
            endDate: new Date(2027 + i, 6, 31),
          },
        }),
      ),
    );

    await Promise.all(targets.map((t) => setCurrentAcademicSession(t.id)));

    const current = await prisma.academicSession.findMany({ where: { isCurrent: true } });
    expect(current).toHaveLength(1);
    // Whichever target committed last legitimately wins — not asserting
    // which, only that there's exactly one, and it's one of the four that
    // was actually raced for (never the untouched A).
    expect(targets.map((t) => t.id)).toContain(current[0]?.id);
  });
});

describe("terms", () => {
  // A PARENT needs a termId to call GET /api/results/:studentId/:termId —
  // this route was already open to every authenticated role before this
  // pass (requireRole(...ALL_ROLES)), so this is added coverage for an
  // already-correct path, not a fail-before/pass-after regression test.
  it("is readable by a PARENT, not just staff roles", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const session = await createCurrentSessionViaApi(server, adminToken);
    await request(server)
      .post(`/api/academic-sessions/${session.id}/terms`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "First Term", order: 1, startDate: "2026-09-01", endDate: "2026-12-15" });

    const res = await request(server)
      .get(`/api/academic-sessions/${session.id}/terms`)
      .set("Authorization", `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("rejects a duplicate order within the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentSessionViaApi(server, token);

    const body = { name: "First Term", order: 1, startDate: "2026-09-01", endDate: "2026-12-15" };
    await request(server)
      .post(`/api/academic-sessions/${session.id}/terms`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    const res = await request(server)
      .post(`/api/academic-sessions/${session.id}/terms`)
      .set("Authorization", `Bearer ${token}`)
      .send({ ...body, name: "Also First Term" });

    expect(res.status).toBe(409);
  });

  it("set-current only clears isCurrent within the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const sessionA = await createCurrentSessionViaApi(server, token, "A");
    const sessionB = await createCurrentSessionViaApi(server, token, "B");

    const termA = await prisma.term.create({
      data: {
        academicSessionId: sessionA.id,
        name: "Term A1",
        order: 1,
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-12-01"),
        isCurrent: true,
      },
    });
    const termB = await prisma.term.create({
      data: {
        academicSessionId: sessionB.id,
        name: "Term B1",
        order: 1,
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-12-01"),
        isCurrent: true,
      },
    });
    const termA2 = await prisma.term.create({
      data: {
        academicSessionId: sessionA.id,
        name: "Term A2",
        order: 2,
        startDate: new Date("2027-01-01"),
        endDate: new Date("2027-04-01"),
      },
    });

    const res = await request(server)
      .patch(`/api/terms/${termA2.id}/set-current`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const refreshedTermA = await prisma.term.findUniqueOrThrow({ where: { id: termA.id } });
    const refreshedTermA2 = await prisma.term.findUniqueOrThrow({ where: { id: termA2.id } });
    const refreshedTermB = await prisma.term.findUniqueOrThrow({ where: { id: termB.id } });

    expect(refreshedTermA.isCurrent).toBe(false);
    expect(refreshedTermA2.isCurrent).toBe(true);
    expect(refreshedTermB.isCurrent).toBe(true); // untouched — different session
  });

  it("switching current term to several different targets concurrently leaves exactly one current row per session", async () => {
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });
    await prisma.term.create({
      data: {
        academicSessionId: session.id,
        name: "Term 0",
        order: 0,
        startDate: new Date("2026-08-01"),
        endDate: new Date("2026-08-31"),
        isCurrent: true,
      },
    });
    const targets = await Promise.all(
      [1, 2, 3, 4].map((order) =>
        prisma.term.create({
          data: {
            academicSessionId: session.id,
            name: `Term ${order}`,
            order,
            startDate: new Date(2026, order, 1),
            endDate: new Date(2026, order + 1, 0),
          },
        }),
      ),
    );

    await Promise.all(targets.map((t) => setCurrentTerm(t.id)));

    const current = await prisma.term.findMany({ where: { academicSessionId: session.id, isCurrent: true } });
    expect(current).toHaveLength(1);
    expect(targets.map((t) => t.id)).toContain(current[0]?.id);
  });
});

describe("classes and subjects", () => {
  it("rejects a duplicate (gradeName, arm) class", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createClass("JSS1", "A");

    const res = await request(server)
      .post("/api/classes")
      .set("Authorization", `Bearer ${token}`)
      .send({ gradeName: "JSS1", arm: "A", order: 1 });

    expect(res.status).toBe(409);
  });

  it("rejects a duplicate subject code", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createSubject("Mathematics", "MTH");

    const res = await request(server)
      .post("/api/subjects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Maths (again)", code: "MTH" });

    expect(res.status).toBe(409);
  });
});

describe("class-subject-teacher assignments", () => {
  it("assigns a teacher and rejects a non-teaching staff role", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff: teacherStaff } = await createTeacher("teacher@test.local");
    const { staff: bursarStaff } = await createBursar("bursar@test.local");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    const validAssignment = await request(server)
      .post("/api/class-subject-assignments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        classId: klass.id,
        subjectId: subject.id,
        teacherId: teacherStaff.id,
        academicSessionId: session.id,
      });
    expect(validAssignment.status).toBe(201);

    const bursarAssignment = await request(server)
      .post("/api/class-subject-assignments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        classId: klass.id,
        subjectId: subject.id,
        teacherId: bursarStaff.id,
        academicSessionId: session.id,
      });
    expect(bursarAssignment.status).toBe(400);
  });

  it("rejects a duplicate class/subject/session assignment", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("teacher@test.local");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });
    const body = {
      classId: klass.id,
      subjectId: subject.id,
      teacherId: staff.id,
      academicSessionId: session.id,
    };

    await request(server).post("/api/class-subject-assignments").set("Authorization", `Bearer ${token}`).send(body);
    const res = await request(server)
      .post("/api/class-subject-assignments")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(409);
  });

  it("scopes a teacher's assignment list to their own assignments regardless of the query param", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { staff: teacherA, token: teacherAToken } = await createTeacher("teacher-a@test.local");
    const { staff: teacherB } = await createTeacher("teacher-b@test.local");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    await prisma.classSubjectAssignment.create({
      data: { classId: klass.id, subjectId: subject.id, teacherId: teacherA.id, academicSessionId: session.id },
    });
    const subject2 = await createSubject("English", "ENG");
    await prisma.classSubjectAssignment.create({
      data: { classId: klass.id, subjectId: subject2.id, teacherId: teacherB.id, academicSessionId: session.id },
    });

    // Teacher A tries to peek at teacher B's assignments via the query param.
    const res = await request(server)
      .get(`/api/class-subject-assignments?teacherId=${teacherB.id}`)
      .set("Authorization", `Bearer ${teacherAToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].teacherId).toBe(teacherA.id);

    // Sanity: admin sees everything.
    const asAdmin = await request(server)
      .get("/api/class-subject-assignments")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(asAdmin.body).toHaveLength(2);
  });
});

describe("deleting a class-subject-teacher assignment", () => {
  async function buildAssignment() {
    const { token } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("teacher@test.local");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    return { token, staff, klass, subject, session, term, assignment };
  }

  async function attachTimetableEntry(assignment: { id: string; classId: string; teacherId: string }, sessionId: string) {
    const timeSlot = await prisma.timeSlot.create({
      data: { name: "Period 1", startTime: "08:00", endTime: "08:40", order: 1 },
    });
    return prisma.timetableEntry.create({
      data: {
        classSubjectAssignmentId: assignment.id,
        classId: assignment.classId,
        teacherId: assignment.teacherId,
        academicSessionId: sessionId,
        timeSlotId: timeSlot.id,
        dayOfWeek: "MONDAY",
      },
    });
  }

  it("204s and removes the assignment when nothing is attached", async () => {
    const { token, assignment } = await buildAssignment();

    const res = await request(server)
      .delete(`/api/class-subject-assignments/${assignment.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(await prisma.classSubjectAssignment.findUnique({ where: { id: assignment.id } })).toBeNull();
  });

  it("204s and removes its timetable entries along with it when only timetable entries are attached", async () => {
    const { token, assignment, session } = await buildAssignment();
    const entry = await attachTimetableEntry(assignment, session.id);

    const res = await request(server)
      .delete(`/api/class-subject-assignments/${assignment.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(await prisma.classSubjectAssignment.findUnique({ where: { id: assignment.id } })).toBeNull();
    expect(await prisma.timetableEntry.findUnique({ where: { id: entry.id } })).toBeNull();
  });

  it("409s naming the blocker when scores exist, even alongside timetable entries — and deletes nothing", async () => {
    const { token, staff, assignment, session, term } = await buildAssignment();
    const entry = await attachTimetableEntry(assignment, session.id);
    const component = await createAssessmentComponent(session.id, "CA1", "CA", 40, 1);
    const { student } = await createStudentWithLogin("scored-student@test.local", "STU-DEL-001");
    await prisma.score.create({
      data: {
        studentId: student.id,
        classSubjectAssignmentId: assignment.id,
        termId: term.id,
        assessmentComponentId: component.id,
        rawScore: 30,
        enteredByUserId: staff.userId,
      },
    });

    const res = await request(server)
      .delete(`/api/class-subject-assignments/${assignment.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("1 recorded score");
    // The whole operation aborted — nothing was cleaned up, not even the
    // timetable entry that would otherwise be deleted on its own.
    expect(await prisma.classSubjectAssignment.findUnique({ where: { id: assignment.id } })).not.toBeNull();
    expect(await prisma.timetableEntry.findUnique({ where: { id: entry.id } })).not.toBeNull();
  });

  it("rejects a non-admin caller", async () => {
    const { assignment } = await buildAssignment();
    const { token: otherTeacherToken } = await createTeacher("other-teacher@test.local");

    const res = await request(server)
      .delete(`/api/class-subject-assignments/${assignment.id}`)
      .set("Authorization", `Bearer ${otherTeacherToken}`);

    expect(res.status).toBe(403);
  });
});

describe("class form teachers", () => {
  it("assigns a form teacher and rejects a non-teaching staff role", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff: teacherStaff } = await createTeacher("teacher@test.local");
    const { staff: bursarStaff } = await createBursar("bursar@test.local");
    const klass = await createClass("JSS1", "A");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    const validAssignment = await request(server)
      .post("/api/class-form-teachers")
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, teacherId: teacherStaff.id, academicSessionId: session.id });
    expect(validAssignment.status).toBe(201);

    const bursarAssignment = await request(server)
      .post("/api/class-form-teachers")
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, teacherId: bursarStaff.id, academicSessionId: session.id });
    expect(bursarAssignment.status).toBe(400);
  });

  it("rejects a second form teacher for the same class/session (one form teacher per class per session)", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff: teacherA } = await createTeacher("teacher-a@test.local");
    const { staff: teacherB } = await createTeacher("teacher-b@test.local");
    const klass = await createClass("JSS1", "A");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    await request(server)
      .post("/api/class-form-teachers")
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, teacherId: teacherA.id, academicSessionId: session.id });
    const res = await request(server)
      .post("/api/class-form-teachers")
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, teacherId: teacherB.id, academicSessionId: session.id });

    expect(res.status).toBe(409);
  });

  it("allows a class to have a different form teacher in a different session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff: teacherA } = await createTeacher("teacher-a@test.local");
    const { staff: teacherB } = await createTeacher("teacher-b@test.local");
    const klass = await createClass("JSS1", "A");
    const sessionA = await prisma.academicSession.create({
      data: { name: "2025/2026", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31") },
    });
    const sessionB = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    const resA = await request(server)
      .post("/api/class-form-teachers")
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, teacherId: teacherA.id, academicSessionId: sessionA.id });
    const resB = await request(server)
      .post("/api/class-form-teachers")
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, teacherId: teacherB.id, academicSessionId: sessionB.id });

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
  });

  it("scopes a teacher's form-teacher list to their own assignments regardless of the query param", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { staff: teacherA, token: teacherAToken } = await createTeacher("teacher-a@test.local");
    const { staff: teacherB } = await createTeacher("teacher-b@test.local");
    const klassA = await createClass("JSS1", "A");
    const klassB = await createClass("JSS1", "B");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    await prisma.classFormTeacher.create({
      data: { classId: klassA.id, teacherId: teacherA.id, academicSessionId: session.id },
    });
    await prisma.classFormTeacher.create({
      data: { classId: klassB.id, teacherId: teacherB.id, academicSessionId: session.id },
    });

    const res = await request(server)
      .get(`/api/class-form-teachers?teacherId=${teacherB.id}`)
      .set("Authorization", `Bearer ${teacherAToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].teacherId).toBe(teacherA.id);

    const asAdmin = await request(server)
      .get("/api/class-form-teachers")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(asAdmin.body).toHaveLength(2);
  });

  it("deletes a form teacher assignment", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("teacher@test.local");
    const klass = await createClass("JSS1", "A");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });
    const assignment = await prisma.classFormTeacher.create({
      data: { classId: klass.id, teacherId: staff.id, academicSessionId: session.id },
    });

    const res = await request(server)
      .delete(`/api/class-form-teachers/${assignment.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);

    const stillThere = await prisma.classFormTeacher.findUnique({ where: { id: assignment.id } });
    expect(stillThere).toBeNull();
  });
});

describe("GET /api/classes/:id/students", () => {
  async function buildClassWithStudents() {
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const otherClass = await createClass("JSS1", "B");
    const subject = await createSubject("Mathematics", "MTH");
    const { staff: assignedTeacher, token: assignedTeacherToken } = await createTeacher("assigned@test.local");
    await createAssignment(klass.id, subject.id, assignedTeacher.id, session.id);
    const { token: otherTeacherToken } = await createTeacher("other-teacher@test.local");
    await createAssignment(otherClass.id, subject.id, (await createTeacher("filler@test.local")).staff.id, session.id);

    const { student: activeStudent } = await createStudentWithLogin("active@test.local", "ADM-ROSTER-001");
    await enrollStudent(activeStudent.id, klass.id, session.id);

    // A student who transferred out — an Enrollment row exists (so it
    // would show up if the roster query didn't filter by status) but it's
    // not ACTIVE.
    const { student: transferredStudent } = await createStudentWithLogin("transferred@test.local", "ADM-ROSTER-002");
    await prisma.enrollment.create({
      data: { studentId: transferredStudent.id, classId: klass.id, academicSessionId: session.id, status: "TRANSFERRED_OUT" },
    });

    return { session, klass, otherClass, assignedTeacherToken, otherTeacherToken, activeStudent, transferredStudent };
  }

  it("returns only actively-enrolled students — a transferred-out student doesn't appear", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { klass, activeStudent, transferredStudent } = await buildClassWithStudents();

    const res = await request(server)
      .get(`/api/classes/${klass.id}/students`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const studentIds = (res.body as Array<{ student: { id: string } }>).map((row) => row.student.id);
    expect(studentIds).toContain(activeStudent.id);
    expect(studentIds).not.toContain(transferredStudent.id);
    // { student, enrollment }[], not bare students.
    const activeRow = (res.body as Array<{ student: { id: string }; enrollment: { status: string } }>).find(
      (row) => row.student.id === activeStudent.id,
    );
    expect(activeRow?.enrollment.status).toBe("ACTIVE");
  });

  it("200s for an assigned teacher, 403s for a teacher of a different class, 403s for a parent", async () => {
    const { klass, assignedTeacherToken, otherTeacherToken } = await buildClassWithStudents();
    const { token: parentToken } = await createParent("parent@test.local");

    const asAssigned = await request(server)
      .get(`/api/classes/${klass.id}/students`)
      .set("Authorization", `Bearer ${assignedTeacherToken}`);
    expect(asAssigned.status).toBe(200);

    const asOtherTeacher = await request(server)
      .get(`/api/classes/${klass.id}/students`)
      .set("Authorization", `Bearer ${otherTeacherToken}`);
    expect(asOtherTeacher.status).toBe(403);

    const asParent = await request(server)
      .get(`/api/classes/${klass.id}/students`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(asParent.status).toBe(403);
  });

  it("allows BURSAR too", async () => {
    const { token: bursarToken } = await createBursar("bursar@test.local");
    const { klass } = await buildClassWithStudents();

    const res = await request(server)
      .get(`/api/classes/${klass.id}/students`)
      .set("Authorization", `Bearer ${bursarToken}`);

    expect(res.status).toBe(200);
  });
});

async function createCurrentSessionViaApi(appInstance: Server, token: string, name = "S") {
  const res = await request(appInstance)
    .post("/api/academic-sessions")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `${name}-${Date.now()}-${Math.random()}`, startDate: "2026-09-01", endDate: "2027-07-31" });
  return res.body as { id: string };
}
