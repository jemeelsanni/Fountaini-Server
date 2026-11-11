import type { Class, Prisma, Programme } from "../../../generated/prisma/index.js";

/// Which report card a subject's scores count towards. The SUBJECT decides:
/// an Islamiyyah subject (SubjectType MADRASSAH) taught in a regular class
/// counts only towards the student's Islamiyyah result, never the Western
/// (ACADEMIC) one — so JSS1 A's Tawheed and Qur'an Memorisation land on the
/// Islamiyyah card while its Mathematics and Islamic Studies stay Western.
/// Everything taught in a Weekday Madrasa group (Class.programme MADRASSAH)
/// is Islamiyyah too, whatever the subject is marked.
///
/// Mirrored on the frontend (report sheet) — keep the two in step.
export function subjectCardWhere(programme: Programme): Prisma.ClassSubjectAssignmentWhereInput {
  return programme === "MADRASSAH"
    ? { OR: [{ subject: { type: "MADRASSAH" } }, { class: { programme: "MADRASSAH" } }] }
    : { subject: { type: "ACADEMIC" }, class: { programme: "ACADEMIC" } };
}

/// The cards a class's own compute produces this session. A Madrasa group
/// only ever has the Islamiyyah card. A regular class always has the
/// Western card, plus an Islamiyyah card once it has an Islamiyyah subject
/// assigned — a class without one (Creche, say) never gets an empty
/// Islamiyyah result.
export async function cardsForClass(
  db: Prisma.TransactionClient,
  klass: Pick<Class, "id" | "programme">,
  academicSessionId: string,
): Promise<Programme[]> {
  if (klass.programme === "MADRASSAH") {
    return ["MADRASSAH"];
  }
  const islamiyyahSubject = await db.classSubjectAssignment.findFirst({
    where: { classId: klass.id, academicSessionId, subject: { type: "MADRASSAH" } },
    select: { id: true },
  });
  return islamiyyahSubject ? ["ACADEMIC", "MADRASSAH"] : ["ACADEMIC"];
}

/// Students of a regular class whose Islamiyyah card belongs to their
/// Weekday Madrasa group instead: an ACTIVE enrollment in a MADRASSAH class
/// this session. That group's compute already reads every Islamiyyah
/// subject they took (subjectCardWhere is by subject, not class), so the
/// regular class leaves their Islamiyyah result alone rather than fight it
/// over the position and enrollment.
export async function studentsWithMadrasaGroup(
  db: Prisma.TransactionClient,
  studentIds: string[],
  academicSessionId: string,
): Promise<Set<string>> {
  const rows = await db.enrollment.findMany({
    where: { studentId: { in: studentIds }, academicSessionId, status: "ACTIVE", programme: "MADRASSAH" },
    select: { studentId: true },
  });
  return new Set(rows.map((r) => r.studentId));
}

/// The students a class's compute writes a given card for.
export async function enrollmentsForCard<T extends { studentId: string }>(
  db: Prisma.TransactionClient,
  klass: Pick<Class, "programme">,
  programme: Programme,
  enrollments: T[],
  academicSessionId: string,
): Promise<T[]> {
  if (programme === klass.programme) {
    return enrollments;
  }
  const elsewhere = await studentsWithMadrasaGroup(
    db,
    enrollments.map((e) => e.studentId),
    academicSessionId,
  );
  return enrollments.filter((e) => !elsewhere.has(e.studentId));
}
