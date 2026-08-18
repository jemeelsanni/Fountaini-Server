import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
  createStudentWithLogin,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForAuditLog } from "../../test/waitForAuditLog.js";

const app = createApp();

async function setupClass() {
  const session = await createCurrentAcademicSession("2026/2027");
  const term = await createTermForSession(session.id, "First Term", 1);
  const klass = await createClass("JSS1", "A");
  return { session, term, klass };
}

async function openSession(token: string, classId: string, academicSessionId: string, termId: string) {
  const res = await request(app)
    .post("/api/attendance-sessions")
    .set("Authorization", `Bearer ${token}`)
    .send({ classId, academicSessionId, termId });
  return res.body as { id: string };
}

async function issueQrCode(adminToken: string, studentId: string) {
  const res = await request(app)
    .post(`/api/students/${studentId}/qr-code/rotate`)
    .set("Authorization", `Bearer ${adminToken}`);
  return res.body as { code: string; version: number };
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("QR code issuance and rotation", () => {
  it("issues version 1 on first request, then rotates to version 2 and revokes the old code", async () => {
    const { token } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-001");

    const first = await issueQrCode(token, student.id);
    expect(first.version).toBe(1);

    const second = await issueQrCode(token, student.id);
    expect(second.version).toBe(2);
    expect(second.code).not.toBe(first.code);

    const oldCodeRow = await prisma.studentQrCode.findUnique({ where: { code: first.code } });
    expect(oldCodeRow?.isActive).toBe(false);
    expect(oldCodeRow?.revokedAt).not.toBeNull();
  });
});

describe("opening attendance sessions", () => {
  it("rejects a second session for the same class on the same day", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { session, term, klass } = await setupClass();

    await request(app)
      .post("/api/attendance-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, academicSessionId: session.id, termId: term.id });
    const res = await request(app)
      .post("/api/attendance-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, academicSessionId: session.id, termId: term.id });

    expect(res.status).toBe(409);
  });
});

describe("POST .../scan", () => {
  it("records a valid scan, then reports a duplicate scan as already-marked without changing the row", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const qr = await issueQrCode(adminToken, student.id);
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

    const first = await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ code: qr.code });
    expect(first.status).toBe(201);
    expect(first.body.alreadyMarked).toBe(false);
    expect(first.body.record.status).toBe("PRESENT");

    const second = await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ code: qr.code });
    expect(second.status).toBe(200);
    expect(second.body.alreadyMarked).toBe(true);
    expect(second.body.record.id).toBe(first.body.record.id);

    const count = await prisma.attendanceRecord.count({
      where: { attendanceSessionId: attendanceSession.id, studentId: student.id },
    });
    expect(count).toBe(1);
  });

  it("handles N concurrent scans of the same student/session with exactly one winner", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const qr = await issueQrCode(adminToken, student.id);
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

    const concurrency = 20;
    const responses = await Promise.all(
      Array.from({ length: concurrency }, () =>
        request(app)
          .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
          .set("Authorization", `Bearer ${teacherToken}`)
          .send({ code: qr.code }),
      ),
    );

    const freshScans = responses.filter((r) => r.body.alreadyMarked === false);
    const duplicates = responses.filter((r) => r.body.alreadyMarked === true);
    expect(freshScans).toHaveLength(1);
    expect(duplicates).toHaveLength(concurrency - 1);

    const count = await prisma.attendanceRecord.count({
      where: { attendanceSessionId: attendanceSession.id, studentId: student.id },
    });
    expect(count).toBe(1);
  });

  it("rejects an invalid or revoked QR code", async () => {
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

    const res = await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ code: "not-a-real-code" });

    expect(res.status).toBe(401);
  });

  it("rejects a scan for a student not enrolled in this session's class", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const unenrolledStudent = await createBareStudent("ADM-002");
    const qr = await issueQrCode(adminToken, unenrolledStudent.id);
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

    const res = await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ code: qr.code });

    expect(res.status).toBe(400);
  });

  it("rejects a scan against a closed session", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const qr = await issueQrCode(adminToken, student.id);
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

    await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/close`)
      .set("Authorization", `Bearer ${teacherToken}`);

    const res = await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ code: qr.code });

    expect(res.status).toBe(400);
  });

  it("marks LATE when the scanning staff member flags it", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const qr = await issueQrCode(adminToken, student.id);
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

    const res = await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ code: qr.code, late: true });

    expect(res.body.record.status).toBe("LATE");
  });
});

describe("POST .../close", () => {
  it("marks every unscanned actively-enrolled student ABSENT, and leaves scanned ones untouched", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const scannedStudent = await createBareStudent("ADM-001");
    const absentStudent = await createBareStudent("ADM-002");
    await enrollStudent(scannedStudent.id, klass.id, session.id);
    await enrollStudent(absentStudent.id, klass.id, session.id);
    const qr = await issueQrCode(adminToken, scannedStudent.id);
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

    await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ code: qr.code });

    const closeRes = await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/close`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(closeRes.status).toBe(200);

    const records = await prisma.attendanceRecord.findMany({
      where: { attendanceSessionId: attendanceSession.id },
    });
    const scannedRecord = records.find((r) => r.studentId === scannedStudent.id);
    const absentRecord = records.find((r) => r.studentId === absentStudent.id);
    expect(scannedRecord?.status).toBe("PRESENT");
    expect(absentRecord?.status).toBe("ABSENT");
    expect(absentRecord?.method).toBe("MANUAL");
  });

  it("rejects closing an already-closed session", async () => {
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

    await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/close`)
      .set("Authorization", `Bearer ${teacherToken}`);
    const res = await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/close`)
      .set("Authorization", `Bearer ${teacherToken}`);

    expect(res.status).toBe(409);
  });
});

describe("scan/close concurrency", () => {
  it("never lets a concurrent scan and close corrupt each other — scan's own claim always matches the persisted row", async () => {
    // A fair row lock can't make scan deterministically win a genuinely
    // simultaneous race with close — two requests microseconds apart have no
    // well-defined "real" order, and whichever transaction reaches the lock
    // first legitimately goes first. What the lock guarantees instead: the
    // loser is told it lost. Before the fix, a scan that lost this race still
    // reported success (200, alreadyMarked: true) while silently handing back
    // the stale ABSENT row close had just written — the API lied about what
    // happened. After the fix, scan either succeeds and the row really is
    // PRESENT, or it's cleanly rejected (400, session closed) and the row is
    // legitimately ABSENT. Every iteration must land in exactly one of those
    // two consistent states — never a "success" response paired with a
    // record that says otherwise.
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      await resetDb();

      const { token: adminToken } = await createAdmin(`admin-${i}@test.local`);
      const { token: teacherToken } = await createTeacher(`teacher-${i}@test.local`);
      const session = await createCurrentAcademicSession(`2026/2027-${i}`);
      const term = await createTermForSession(session.id, "First Term", 1);
      const klass = await createClass("JSS1", "A");
      const student = await createBareStudent(`ADM-001-${i}`);
      await enrollStudent(student.id, klass.id, session.id);
      const qr = await issueQrCode(adminToken, student.id);
      const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);

      // Fired via Promise.all, not awaited one at a time — a real scan and a
      // real close in flight at the same time, exactly the interleaving that
      // used to let close's unprotected reads run between a scan's create()
      // and its own writes.
      const [scanRes] = await Promise.all([
        request(app)
          .post(`/api/attendance-sessions/${attendanceSession.id}/scan`)
          .set("Authorization", `Bearer ${teacherToken}`)
          .send({ code: qr.code }),
        request(app)
          .post(`/api/attendance-sessions/${attendanceSession.id}/close`)
          .set("Authorization", `Bearer ${teacherToken}`),
      ]);

      const record = await prisma.attendanceRecord.findUnique({
        where: {
          attendanceSessionId_studentId: { attendanceSessionId: attendanceSession.id, studentId: student.id },
        },
      });
      const scanBody = scanRes.body as { record?: { status?: string }; error?: { message?: string } };
      const scanClaimsSuccess = scanRes.status === 200 || scanRes.status === 201;

      if (scanClaimsSuccess) {
        expect(
          scanBody.record?.status,
          `iteration ${i}: scan reported success (${scanRes.status}) but its own response body disagrees: ${JSON.stringify(scanBody)}`,
        ).toBe("PRESENT");
        expect(
          record?.status,
          `iteration ${i}: scan reported success (${scanRes.status}, record ${scanBody.record?.status}) but the persisted row is ${record?.status} — scan lied`,
        ).toBe("PRESENT");
      } else {
        expect(
          scanRes.status,
          `iteration ${i}: scan neither succeeded nor was cleanly rejected as closed: ${scanRes.status} ${JSON.stringify(scanBody)}`,
        ).toBe(400);
        expect(scanBody.error?.message).toBe("This attendance session is closed");
        expect(
          record?.status,
          `iteration ${i}: scan was correctly rejected as closed, but the persisted row isn't ABSENT`,
        ).toBe("ABSENT");
      }
    }
  }, 120_000);
});

describe("PATCH /api/attendance-records/:id (manual correction)", () => {
  it("corrects a record and leaves an audited trail", async () => {
    const { token: adminToken, user: adminUser } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);
    await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/close`)
      .set("Authorization", `Bearer ${teacherToken}`);

    const absentRecord = await prisma.attendanceRecord.findFirstOrThrow({
      where: { attendanceSessionId: attendanceSession.id, studentId: student.id },
    });
    expect(absentRecord.status).toBe("ABSENT");

    const correctRes = await request(app)
      .patch(`/api/attendance-records/${absentRecord.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "PRESENT", reason: "Student was present; scanner was offline at the gate" });

    expect(correctRes.status).toBe(200);
    expect(correctRes.body.status).toBe("PRESENT");
    expect(correctRes.body.correctionReason).toBe("Student was present; scanner was offline at the gate");
    expect(correctRes.body.correctedByUserId).toBe(adminUser.id);

    const auditEntry = await waitForAuditLog("AttendanceRecord", absentRecord.id);
    expect(auditEntry).not.toBeNull();
    expect(auditEntry?.action).toBe("ATTENDANCE_CORRECTED");
  });
});

describe("GET /api/students/:id/attendance — data-scoped", () => {
  // Who can read this route (self/linked parent/assigned teacher/stranger)
  // is covered by the auth matrix (src/authorization/authMatrix.data.ts).
  // This test only checks the attendance-specific content of an allowed
  // response.
  it("returns the student's attendance records", async () => {
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { session, term, klass } = await setupClass();
    const { student, token: studentToken } = await createStudentWithLogin("student@test.local", "ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const attendanceSession = await openSession(teacherToken, klass.id, session.id, term.id);
    await request(app)
      .post(`/api/attendance-sessions/${attendanceSession.id}/close`)
      .set("Authorization", `Bearer ${teacherToken}`);

    const asSelf = await request(app)
      .get(`/api/students/${student.id}/attendance`)
      .set("Authorization", `Bearer ${studentToken}`);
    expect(asSelf.status).toBe(200);
    expect(asSelf.body).toHaveLength(1);
  });
});
