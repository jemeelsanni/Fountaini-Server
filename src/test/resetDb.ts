import { prisma } from "../db/client.js";

/// Explicit child-before-parent deletion order rather than relying on
/// inferred cascade defaults for every relation — several FKs
/// (ClassSubjectAssignment, Enrollment, Score, SubjectResult, Result, and
/// friends) are deliberately NOT cascade-delete, so those must be cleared
/// before their parents or this would throw.
export async function resetDb(): Promise<void> {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.notificationEvent.deleteMany(),
    prisma.resultOverride.deleteMany(),
    prisma.result.deleteMany(),
    prisma.subjectResult.deleteMany(),
    prisma.score.deleteMany(),
    prisma.timetableEntry.deleteMany(),
    prisma.classSubjectAssignment.deleteMany(),
    prisma.attendanceRecord.deleteMany(),
    prisma.attendanceSession.deleteMany(),
    prisma.studentQrCode.deleteMany(),
    prisma.receipt.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.feeObligation.deleteMany(),
    prisma.feeStructure.deleteMany(),
    prisma.madrassahProgress.deleteMany(),
    prisma.admissionEnquiry.deleteMany(),
    prisma.enrollment.deleteMany(),
    prisma.studentParent.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.passwordResetToken.deleteMany(),
    prisma.staff.deleteMany(),
    prisma.parent.deleteMany(),
    prisma.student.deleteMany(),
    prisma.gradeBand.deleteMany(),
    prisma.gradingScale.deleteMany(),
    prisma.assessmentComponent.deleteMany(),
    prisma.timeSlot.deleteMany(),
    prisma.term.deleteMany(),
    prisma.subject.deleteMany(),
    prisma.class.deleteMany(),
    prisma.academicSession.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}
