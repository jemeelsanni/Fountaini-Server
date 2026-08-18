import { randomBytes } from "node:crypto";
import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CorrectAttendanceBody, OpenSessionBody, ScanBody } from "./attendance.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Attendance sessions
// ---------------------------------------------------------------------------

export async function openSession(actorUserId: string, input: OpenSessionBody) {
  const [klass, session, term] = await Promise.all([
    prisma.class.findUnique({ where: { id: input.classId } }),
    prisma.academicSession.findUnique({ where: { id: input.academicSessionId } }),
    prisma.term.findUnique({ where: { id: input.termId } }),
  ]);
  if (!klass) throw AppError.notFound("Class not found");
  if (!session) throw AppError.notFound("Academic session not found");
  if (!term || term.academicSessionId !== input.academicSessionId) {
    throw AppError.badRequest("Term does not belong to this academic session");
  }

  const date = startOfDay(input.date ?? new Date());

  try {
    return await prisma.attendanceSession.create({
      data: {
        classId: input.classId,
        academicSessionId: input.academicSessionId,
        termId: input.termId,
        date,
        openedByUserId: actorUserId,
      },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("An attendance session for this class and date already exists");
    }
    throw err;
  }
}

interface LockedSession {
  id: string;
  status: "OPEN" | "CLOSED";
  classId: string;
  academicSessionId: string;
}

/// Takes a row lock on the AttendanceSession itself — SELECT ... FOR UPDATE
/// can't be expressed through the query builder, hence the raw query. Both
/// scan() and closeSession() acquire this same lock as their first operation,
/// inside their own transaction, before reading anything else derived from
/// the session's state. Postgres holds a FOR UPDATE lock until the
/// transaction commits or rolls back, so a concurrent scan and close on the
/// same session fully serialize on this row: whichever started its
/// transaction first runs to completion (commit or rollback) before the
/// other's lock acquisition unblocks — and once unblocked, that statement
/// re-reads the row's latest committed value, so a scan that loses the race
/// sees status = CLOSED and is correctly rejected rather than silently
/// racing the close's writes. The lock is held only for the lifetime of each
/// transaction (a handful of queries), so it only ever contends at the
/// moment of a real scan/close overlap — not against unrelated sessions or
/// unrelated reads.
async function lockSessionForUpdate(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<LockedSession | undefined> {
  const rows = await tx.$queryRaw<LockedSession[]>`
    SELECT "id", "status", "classId", "academicSessionId"
    FROM "AttendanceSession"
    WHERE "id" = ${id}
    FOR UPDATE
  `;
  return rows[0];
}

/// Race-safe scan: serializes against other scans and against closeSession
/// via lockSessionForUpdate (see its comment), then relies on the DB-level
/// unique constraint on (attendanceSessionId, studentId) as the final word.
/// Two scans of the same student that both pass the lock in turn still race
/// to insert — but this uses createMany({ skipDuplicates: true }) rather
/// than create() + catch(P2002): a failed statement inside a Postgres
/// transaction poisons the whole transaction (25P02) until it rolls back, so
/// a caught P2002 here couldn't be followed by the recovery read that used
/// to run right after it once everything moved inside one $transaction.
/// skipDuplicates never errors on the conflict, so the transaction stays
/// healthy and the unconditional read below always succeeds.
export async function scan(attendanceSessionId: string, actorUserId: string, input: ScanBody) {
  return prisma.$transaction(async (tx) => {
    const session = await lockSessionForUpdate(tx, attendanceSessionId);
    if (!session) {
      throw AppError.notFound("Attendance session not found");
    }
    if (session.status === "CLOSED") {
      throw AppError.badRequest("This attendance session is closed");
    }

    const qrCode = await tx.studentQrCode.findUnique({ where: { code: input.code } });
    if (!qrCode || !qrCode.isActive) {
      throw AppError.unauthorized("Invalid or revoked QR code");
    }

    const enrollment = await tx.enrollment.findFirst({
      where: {
        studentId: qrCode.studentId,
        classId: session.classId,
        academicSessionId: session.academicSessionId,
        status: "ACTIVE",
      },
    });
    if (!enrollment) {
      throw AppError.badRequest("This student is not actively enrolled in this class for this session");
    }

    const { count } = await tx.attendanceRecord.createMany({
      data: [
        {
          attendanceSessionId,
          studentId: qrCode.studentId,
          status: input.late ? "LATE" : "PRESENT",
          method: "QR_SCAN",
          scannedAt: new Date(),
          qrCodeVersionUsed: qrCode.version,
          recordedByUserId: actorUserId,
        },
      ],
      skipDuplicates: true,
    });

    const record = await tx.attendanceRecord.findUniqueOrThrow({
      where: { attendanceSessionId_studentId: { attendanceSessionId, studentId: qrCode.studentId } },
    });
    return { record, alreadyMarked: count === 0 };
  });
}

/// Closing a session marks every actively-enrolled student who was never
/// scanned as ABSENT — the "auto-absent on close" decision from the build
/// plan. The enrollment/existing-record reads now happen inside the same
/// locked transaction as the writes (previously they ran outside any
/// transaction, which left a window for a concurrent scan to commit a
/// PRESENT record after these reads but before the writes landed). The
/// ABSENT inserts use createMany({ skipDuplicates: true }) rather than
/// individual create() calls: the lock already prevents a genuine race from
/// reaching this point, but skipDuplicates means a stray conflict (e.g. a
/// retried close() call, or any gap this analysis missed) drops just that
/// one row instead of throwing and rolling back every other student's
/// correctly-computed ABSENT record.
export async function closeSession(id: string, actorUserId: string) {
  await prisma.$transaction(async (tx) => {
    const session = await lockSessionForUpdate(tx, id);
    if (!session) {
      throw AppError.notFound("Attendance session not found");
    }
    if (session.status === "CLOSED") {
      throw AppError.conflict("This attendance session is already closed");
    }

    const [enrollments, existingRecords] = await Promise.all([
      tx.enrollment.findMany({
        where: { classId: session.classId, academicSessionId: session.academicSessionId, status: "ACTIVE" },
      }),
      tx.attendanceRecord.findMany({ where: { attendanceSessionId: id }, select: { studentId: true } }),
    ]);
    const scannedStudentIds = new Set(existingRecords.map((r) => r.studentId));
    const unscanned = enrollments.filter((e) => !scannedStudentIds.has(e.studentId));

    if (unscanned.length > 0) {
      await tx.attendanceRecord.createMany({
        data: unscanned.map((e) => ({
          attendanceSessionId: id,
          studentId: e.studentId,
          status: "ABSENT",
          method: "MANUAL",
          recordedByUserId: actorUserId,
        })),
        skipDuplicates: true,
      });
    }

    await tx.attendanceSession.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } });
  });

  return prisma.attendanceSession.findUniqueOrThrow({ where: { id }, include: { records: true } });
}

export async function correctRecord(id: string, actorUserId: string, input: CorrectAttendanceBody) {
  const record = await prisma.attendanceRecord.findUnique({ where: { id } });
  if (!record) {
    throw AppError.notFound("Attendance record not found");
  }

  return prisma.attendanceRecord.update({
    where: { id },
    data: {
      status: input.status,
      correctedByUserId: actorUserId,
      correctedAt: new Date(),
      correctionReason: input.reason,
    },
  });
}

export function getAttendanceForStudent(studentId: string) {
  return prisma.attendanceRecord.findMany({
    where: { studentId },
    include: { attendanceSession: { include: { class: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getAttendanceForClass(classId: string, date?: Date) {
  const klass = await prisma.class.findUnique({ where: { id: classId } });
  if (!klass) {
    throw AppError.notFound("Class not found");
  }

  return prisma.attendanceSession.findMany({
    where: { classId, date: date ? startOfDay(date) : undefined },
    include: { records: { include: { student: true } } },
    orderBy: { date: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Student QR codes
// ---------------------------------------------------------------------------

function generateQrCode(): string {
  return randomBytes(32).toString("base64url");
}

/// Handles both first issuance (no active code yet) and rotation (deactivate
/// the current one, issue the next version) in one atomic transaction. The
/// "current" read now happens inside that transaction rather than before it,
/// so deactivate-then-create is computed from a read taken as part of the
/// same unit of work as the writes. That alone doesn't stop two concurrent
/// rotations from both reading "no active code" and both creating one under
/// READ COMMITTED, though — the partial unique index on ("studentId") WHERE
/// "isActive" (migration add_qr_code_one_active_partial_index) is what
/// actually guarantees at most one active row: the loser's create() is
/// rejected by the DB instead of silently leaving two active codes.
export async function rotateQrCode(studentId: string) {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) {
    throw AppError.notFound("Student not found");
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.studentQrCode.findFirst({ where: { studentId, isActive: true } });

    if (current) {
      await tx.studentQrCode.update({
        where: { id: current.id },
        data: { isActive: false, revokedAt: new Date() },
      });
    }
    return tx.studentQrCode.create({
      data: { studentId, code: generateQrCode(), version: (current?.version ?? 0) + 1 },
    });
  });
}

export async function getActiveQrCode(studentId: string) {
  const code = await prisma.studentQrCode.findFirst({ where: { studentId, isActive: true } });
  if (!code) {
    throw AppError.notFound("No active QR code for this student");
  }
  return code;
}
