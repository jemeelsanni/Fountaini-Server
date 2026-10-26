import type { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { ListStudentIdCardsQuery } from "./id-cards.schemas.js";

/// Everything printed on an ID card, in one read — the frontend renders
/// the card (and the QR image from qrCode.code) without a second request.
/// Read-only: a student with no active QR code gets qrCode: null rather
/// than one issued here as a GET side effect — POST
/// /api/students/:id/qr-code/rotate issues one, same as it always has.
/// school is null (not a 404) when the school record isn't configured yet,
/// so a card can still be rendered without its header.

function fullName(person: { firstName: string; otherNames: string | null; lastName: string }): string {
  return [person.firstName, person.otherNames, person.lastName].filter(Boolean).join(" ");
}

function className(klass: { gradeName: string; arm: string | null }): string {
  return `${klass.gradeName}${klass.arm ? ` ${klass.arm}` : ""}`;
}

function getSchoolHeader() {
  return prisma.school.findFirst({ select: { name: true, address: true, contactPhone: true, contactEmail: true } });
}

const studentCardInclude = {
  qrCodes: { where: { isActive: true }, select: { code: true, version: true, issuedAt: true }, take: 1 },
} satisfies Prisma.StudentInclude;

type StudentCardRow = Prisma.StudentGetPayload<{ include: typeof studentCardInclude }>;

function toStudentCard(
  student: StudentCardRow,
  enrollment: { class: { id: string; gradeName: string; arm: string | null }; academicSession: { id: string; name: string } } | null,
  school: Awaited<ReturnType<typeof getSchoolHeader>>,
) {
  return {
    id: student.id,
    admissionNumber: student.admissionNumber,
    firstName: student.firstName,
    lastName: student.lastName,
    otherNames: student.otherNames,
    fullName: fullName(student),
    gender: student.gender,
    dateOfBirth: student.dateOfBirth,
    registeredAt: student.admissionDate,
    status: student.status,
    class: enrollment ? { id: enrollment.class.id, name: className(enrollment.class) } : null,
    academicSession: enrollment ? { id: enrollment.academicSession.id, name: enrollment.academicSession.name } : null,
    qrCode: student.qrCodes[0] ?? null,
    school,
  };
}

const enrollmentCardInclude = {
  class: { select: { id: true, gradeName: true, arm: true } },
  academicSession: { select: { id: true, name: true } },
} satisfies Prisma.EnrollmentInclude;

export async function getStudentIdCard(studentId: string) {
  const [student, enrollment, school] = await Promise.all([
    prisma.student.findUnique({ where: { id: studentId, deletedAt: null }, include: studentCardInclude }),
    // Current-session, ACTIVE enrollment only — same rule as
    // searchStudents' className: a withdrawn student, or one not enrolled
    // this session, gets class: null rather than a stale class.
    prisma.enrollment.findFirst({
      where: { studentId, status: "ACTIVE", academicSession: { isCurrent: true } },
      include: enrollmentCardInclude,
    }),
    getSchoolHeader(),
  ]);
  if (!student) {
    throw AppError.notFound("Student not found");
  }
  return toStudentCard(student, enrollment, school);
}

/// Every ACTIVE-enrolled student in one class, for printing a class's cards
/// in one go — ordered like a class roster (lastName, firstName).
export async function listStudentIdCards(query: ListStudentIdCardsQuery) {
  const academicSessionId =
    query.academicSessionId ??
    (await prisma.academicSession.findFirst({ where: { isCurrent: true }, select: { id: true } }))?.id;
  if (!academicSessionId) {
    throw AppError.badRequest("No academic session is marked current — pass academicSessionId explicitly");
  }

  const [enrollments, school] = await Promise.all([
    prisma.enrollment.findMany({
      where: { classId: query.classId, academicSessionId, status: "ACTIVE", student: { deletedAt: null } },
      include: { ...enrollmentCardInclude, student: { include: studentCardInclude } },
      orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
    }),
    getSchoolHeader(),
  ]);
  return enrollments.map((enrollment) => toStudentCard(enrollment.student, enrollment, school));
}

const staffCardInclude = {
  user: { select: { email: true, phone: true, roles: { select: { role: true } } } },
} satisfies Prisma.StaffInclude;

type StaffCardRow = Prisma.StaffGetPayload<{ include: typeof staffCardInclude }>;

function toStaffCard(staff: StaffCardRow, school: Awaited<ReturnType<typeof getSchoolHeader>>) {
  return {
    id: staff.id,
    staffNumber: staff.staffNumber,
    firstName: staff.firstName,
    lastName: staff.lastName,
    otherNames: staff.otherNames,
    fullName: fullName(staff),
    department: staff.department,
    roles: staff.user.roles.map((r) => r.role),
    email: staff.user.email,
    phone: staff.user.phone,
    employmentDate: staff.employmentDate,
    registeredAt: staff.createdAt,
    isActive: staff.isActive,
    school,
  };
}

export async function getStaffIdCard(staffId: string) {
  const [staff, school] = await Promise.all([
    prisma.staff.findUnique({ where: { id: staffId }, include: staffCardInclude }),
    getSchoolHeader(),
  ]);
  if (!staff) {
    throw AppError.notFound("Staff member not found");
  }
  return toStaffCard(staff, school);
}

/// Every active staff member, for printing everyone's cards in one go.
export async function listStaffIdCards() {
  const [staff, school] = await Promise.all([
    prisma.staff.findMany({
      where: { isActive: true },
      include: staffCardInclude,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    getSchoolHeader(),
  ]);
  return staff.map((member) => toStaffCard(member, school));
}
