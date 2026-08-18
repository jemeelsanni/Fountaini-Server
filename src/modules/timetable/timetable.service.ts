import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateTimeSlotBody, CreateTimetableEntryBody } from "./timetable.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export function createTimeSlot(input: CreateTimeSlotBody) {
  if (input.endTime <= input.startTime) {
    throw AppError.badRequest("endTime must be after startTime");
  }
  return prisma.timeSlot.create({ data: input });
}

export function listTimeSlots() {
  return prisma.timeSlot.findMany({ orderBy: { order: "asc" } });
}

export async function createTimetableEntry(input: CreateTimetableEntryBody) {
  const [assignment, timeSlot] = await Promise.all([
    prisma.classSubjectAssignment.findUnique({ where: { id: input.classSubjectAssignmentId } }),
    prisma.timeSlot.findUnique({ where: { id: input.timeSlotId } }),
  ]);
  if (!assignment) {
    throw AppError.notFound("Class-subject assignment not found");
  }
  if (!timeSlot) {
    throw AppError.notFound("Time slot not found");
  }

  try {
    return await prisma.timetableEntry.create({
      data: {
        classSubjectAssignmentId: input.classSubjectAssignmentId,
        classId: assignment.classId,
        teacherId: assignment.teacherId,
        academicSessionId: assignment.academicSessionId,
        timeSlotId: input.timeSlotId,
        dayOfWeek: input.dayOfWeek,
      },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("This class or teacher is already booked for this day and time slot");
    }
    throw err;
  }
}

export async function deleteTimetableEntry(id: string) {
  const entry = await prisma.timetableEntry.findUnique({ where: { id } });
  if (!entry) {
    throw AppError.notFound("Timetable entry not found");
  }
  await prisma.timetableEntry.delete({ where: { id } });
}

export function getTimetableForClass(classId: string) {
  return prisma.timetableEntry.findMany({
    where: { classId },
    include: { classSubjectAssignment: { include: { subject: true } }, timeSlot: true, teacher: true },
    orderBy: [{ dayOfWeek: "asc" }, { timeSlot: { order: "asc" } }],
  });
}

export function getTimetableForTeacher(teacherId: string) {
  return prisma.timetableEntry.findMany({
    where: { teacherId },
    include: { classSubjectAssignment: { include: { subject: true, class: true } }, timeSlot: true },
    orderBy: [{ dayOfWeek: "asc" }, { timeSlot: { order: "asc" } }],
  });
}
