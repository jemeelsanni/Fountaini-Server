import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createAssignment,
  createClass,
  createCurrentAcademicSession,
  createSubject,
  createTeacher,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("time slots", () => {
  it("creates a time slot and rejects endTime before startTime", async () => {
    const { token } = await createAdmin("admin@test.local");

    const ok = await request(app)
      .post("/api/time-slots")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Period 1", startTime: "08:00", endTime: "08:40", order: 1 });
    expect(ok.status).toBe(201);

    const bad = await request(app)
      .post("/api/time-slots")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Period 2", startTime: "09:40", endTime: "09:00", order: 2 });
    expect(bad.status).toBe(400);
  });
});

describe("timetable entries and double-booking", () => {
  async function setup() {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klassA = await createClass("JSS1", "A");
    const klassB = await createClass("JSS1", "B");
    const maths = await createSubject("Mathematics", "MTH");
    const english = await createSubject("English", "ENG");
    const { staff: teacher } = await createTeacher("teacher@test.local");
    const assignmentA = await createAssignment(klassA.id, maths.id, teacher.id, session.id);
    const assignmentB = await createAssignment(klassB.id, english.id, teacher.id, session.id);

    const slotRes = await request(app)
      .post("/api/time-slots")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Period 1", startTime: "08:00", endTime: "08:40", order: 1 });

    return { token, klassA, klassB, assignmentA, assignmentB, timeSlot: slotRes.body as { id: string } };
  }

  it("creates a timetable entry with class/teacher denormalized from the assignment", async () => {
    const { token, klassA, assignmentA, timeSlot } = await setup();

    const res = await request(app)
      .post("/api/timetable-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ classSubjectAssignmentId: assignmentA.id, timeSlotId: timeSlot.id, dayOfWeek: "MONDAY" });

    expect(res.status).toBe(201);
    expect(res.body.classId).toBe(klassA.id);
  });

  it("rejects double-booking the same class in the same day/slot", async () => {
    const { token, assignmentA, klassA, timeSlot } = await setup();
    const otherSubject = await prisma.subject.create({ data: { name: "Science", code: "SCI" } });
    const { staff: otherTeacher } = await createTeacher("other-teacher@test.local");
    const session = await prisma.academicSession.findFirstOrThrow();
    const conflictingAssignment = await createAssignment(klassA.id, otherSubject.id, otherTeacher.id, session.id);

    await request(app)
      .post("/api/timetable-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ classSubjectAssignmentId: assignmentA.id, timeSlotId: timeSlot.id, dayOfWeek: "MONDAY" });

    const res = await request(app)
      .post("/api/timetable-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ classSubjectAssignmentId: conflictingAssignment.id, timeSlotId: timeSlot.id, dayOfWeek: "MONDAY" });

    expect(res.status).toBe(409);
  });

  it("rejects double-booking the same teacher across two different classes in the same day/slot", async () => {
    const { token, assignmentA, assignmentB, timeSlot } = await setup();

    await request(app)
      .post("/api/timetable-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ classSubjectAssignmentId: assignmentA.id, timeSlotId: timeSlot.id, dayOfWeek: "MONDAY" });

    // Same teacher (assignmentB uses the same teacher as assignmentA), different class.
    const res = await request(app)
      .post("/api/timetable-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ classSubjectAssignmentId: assignmentB.id, timeSlotId: timeSlot.id, dayOfWeek: "MONDAY" });

    expect(res.status).toBe(409);
  });

  it("allows the same teacher in two classes on the same day at DIFFERENT time slots", async () => {
    const { token, assignmentA, assignmentB, timeSlot } = await setup();
    const secondSlotRes = await request(app)
      .post("/api/time-slots")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Period 2", startTime: "08:40", endTime: "09:20", order: 2 });

    await request(app)
      .post("/api/timetable-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ classSubjectAssignmentId: assignmentA.id, timeSlotId: timeSlot.id, dayOfWeek: "MONDAY" });

    const res = await request(app)
      .post("/api/timetable-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({
        classSubjectAssignmentId: assignmentB.id,
        timeSlotId: secondSlotRes.body.id,
        dayOfWeek: "MONDAY",
      });

    expect(res.status).toBe(201);
  });

  it("deletes a timetable entry", async () => {
    const { token, assignmentA, timeSlot } = await setup();
    const createRes = await request(app)
      .post("/api/timetable-entries")
      .set("Authorization", `Bearer ${token}`)
      .send({ classSubjectAssignmentId: assignmentA.id, timeSlotId: timeSlot.id, dayOfWeek: "MONDAY" });

    const deleteRes = await request(app)
      .delete(`/api/timetable-entries/${createRes.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);

    const remaining = await prisma.timetableEntry.findUnique({ where: { id: createRes.body.id } });
    expect(remaining).toBeNull();
  });
});

// Who can read GET /api/classes/:id/timetable and GET /api/staff/:id/timetable
// (own class/self vs. an unrelated student/colleague) is covered by the auth
// matrix (src/authorization/authMatrix.data.ts).
