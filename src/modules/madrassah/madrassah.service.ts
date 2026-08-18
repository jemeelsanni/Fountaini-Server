import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateProgressBody } from "./madrassah.schemas.js";

export async function createProgress(staffId: string, input: CreateProgressBody) {
  const [student, session, term] = await Promise.all([
    prisma.student.findUnique({ where: { id: input.studentId } }),
    prisma.academicSession.findUnique({ where: { id: input.academicSessionId } }),
    prisma.term.findUnique({ where: { id: input.termId } }),
  ]);
  if (!student) throw AppError.notFound("Student not found");
  if (!session) throw AppError.notFound("Academic session not found");
  if (!term || term.academicSessionId !== input.academicSessionId) {
    throw AppError.badRequest("Term does not belong to this academic session");
  }
  if (input.surahId) {
    const surah = await prisma.surah.findUnique({ where: { id: input.surahId } });
    if (!surah) {
      throw AppError.notFound("Surah not found");
    }
  }

  return prisma.madrassahProgress.create({
    data: {
      studentId: input.studentId,
      staffId,
      academicSessionId: input.academicSessionId,
      termId: input.termId,
      surahId: input.surahId,
      ayahFrom: input.ayahFrom,
      ayahTo: input.ayahTo,
      juzNumber: input.juzNumber,
      progressType: input.progressType,
      status: input.status,
      tajweedNotes: input.tajweedNotes,
      generalNotes: input.generalNotes,
    },
  });
}

export function listProgressForStudent(studentId: string) {
  return prisma.madrassahProgress.findMany({
    where: { studentId },
    include: { surah: true, staff: { select: { firstName: true, lastName: true } }, term: true },
    orderBy: { recordedAt: "desc" },
  });
}

export function listSurahs() {
  return prisma.surah.findMany({ orderBy: { number: "asc" } });
}
