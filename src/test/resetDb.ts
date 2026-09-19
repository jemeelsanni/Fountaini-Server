import { prisma } from "../db/client.js";
import { drainFireAndForget } from "../lib/fireAndForget.js";

/// Explicit child-before-parent deletion order rather than relying on
/// inferred cascade defaults for every relation — several FKs
/// (ClassSubjectAssignment, Enrollment, Score, SubjectResult, Result, and
/// friends) are deliberately NOT cascade-delete, so those must be cleared
/// before their parents or this would throw.
export async function resetDb(): Promise<void> {
  // Structural fix for the whole "unawaited fire-and-forget write races
  // this truncate" class (docs/concurrency.md's 2026-09-19 entries): every
  // production fire-and-forget call site now goes through fireAndForget()
  // (src/lib/fireAndForget.ts), which tracks it here instead of leaving it
  // to whichever test happened to trigger it. Draining before touching any
  // table means a leftover write from the *previous* test can no longer
  // land mid-way through *this* truncate — no per-test waitForNotification
  // call required to prevent it, though tests that want to assert on a
  // notification/audit row's actual content still use that to wait for it
  // to exist within the same test.
  await drainFireAndForget();

  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.identifierCounter.deleteMany(),
    prisma.notificationEvent.deleteMany(),
    prisma.resultOverride.deleteMany(),
    prisma.sessionSubjectAverage.deleteMany(),
    prisma.sessionResult.deleteMany(),
    prisma.result.deleteMany(),
    prisma.rating.deleteMany(),
    prisma.trait.deleteMany(),
    prisma.subjectResult.deleteMany(),
    prisma.score.deleteMany(),
    prisma.timetableEntry.deleteMany(),
    prisma.classSubjectAssignment.deleteMany(),
    prisma.classFormTeacher.deleteMany(),
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
    // School.currentAcademicSessionId FKs to AcademicSession (no cascade),
    // so this must go before it — same reasoning as everything above.
    prisma.school.deleteMany(),
    prisma.academicSession.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}
