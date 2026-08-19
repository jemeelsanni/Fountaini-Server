import type { Role } from "../../generated/prisma/index.js";
import { prisma } from "../db/client.js";
import { signAccessToken } from "../modules/auth/jwt.js";
import { hashPassword } from "../modules/auth/password.js";

/// Test-only helpers: sign tokens directly rather than round-tripping through
/// /api/auth/login for every fixture — login itself is already covered by
/// Phase 1's auth tests, so these just need a valid, correctly-shaped token.
async function createUser(email: string, roles: Role[], password = "password-123456") {
  const passwordHash = await hashPassword(password);
  return prisma.user.create({
    data: { email, passwordHash, roles: { create: roles.map((role) => ({ role })) } },
  });
}

export async function createAdmin(email: string) {
  const user = await createUser(email, ["ADMIN"]);
  const token = signAccessToken({
    sub: user.id,
    roles: ["ADMIN"],
    staffId: null,
    parentId: null,
    studentId: null,
  });
  return { user, token };
}

export async function createTeacher(email: string) {
  const user = await createUser(email, ["TEACHER"]);
  const staff = await prisma.staff.create({
    data: {
      userId: user.id,
      staffNumber: `STAFF-${user.id.slice(0, 10)}`,
      firstName: "Test",
      lastName: "Teacher",
    },
  });
  const token = signAccessToken({
    sub: user.id,
    roles: ["TEACHER"],
    staffId: staff.id,
    parentId: null,
    studentId: null,
  });
  return { user, staff, token };
}

export async function createBursar(email: string) {
  const user = await createUser(email, ["BURSAR"]);
  const staff = await prisma.staff.create({
    data: {
      userId: user.id,
      staffNumber: `STAFF-${user.id.slice(0, 10)}`,
      firstName: "Test",
      lastName: "Bursar",
    },
  });
  const token = signAccessToken({
    sub: user.id,
    roles: ["BURSAR"],
    staffId: staff.id,
    parentId: null,
    studentId: null,
  });
  return { user, staff, token };
}

export async function createParent(email: string) {
  const user = await createUser(email, ["PARENT"]);
  const parent = await prisma.parent.create({
    data: { userId: user.id, firstName: "Test", lastName: "Parent" },
  });
  const token = signAccessToken({
    sub: user.id,
    roles: ["PARENT"],
    staffId: null,
    parentId: parent.id,
    studentId: null,
  });
  return { user, parent, token };
}

export async function createStudentWithLogin(email: string, admissionNumber: string) {
  const user = await createUser(email, ["STUDENT"]);
  const student = await prisma.student.create({
    data: { admissionNumber, firstName: "Test", lastName: "Student", userId: user.id },
  });
  const token = signAccessToken({
    sub: user.id,
    roles: ["STUDENT"],
    staffId: null,
    parentId: null,
    studentId: student.id,
  });
  return { user, student, token };
}

/// A user who genuinely holds two roles at once — the case this schema
/// couldn't represent before UserRole existed. Used to prove scope resolvers
/// grant access via EITHER role independently, not just the "first" one.
export async function createStaffParent(email: string) {
  const user = await createUser(email, ["TEACHER", "PARENT"]);
  const staff = await prisma.staff.create({
    data: {
      userId: user.id,
      staffNumber: `STAFF-${user.id.slice(0, 10)}`,
      firstName: "Test",
      lastName: "StaffParent",
    },
  });
  const parent = await prisma.parent.create({
    data: { userId: user.id, firstName: "Test", lastName: "StaffParent" },
  });
  const token = signAccessToken({
    sub: user.id,
    roles: ["TEACHER", "PARENT"],
    staffId: staff.id,
    parentId: parent.id,
    studentId: null,
  });
  return { user, staff, parent, token };
}

export function createBareStudent(admissionNumber: string, overrides: { firstName?: string } = {}) {
  return prisma.student.create({
    data: { admissionNumber, firstName: overrides.firstName ?? "Bare", lastName: "Student" },
  });
}

export function createCurrentAcademicSession(name: string) {
  return prisma.academicSession.create({
    data: { name, startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31"), isCurrent: true },
  });
}

export function createClass(gradeName: string, arm?: string) {
  return prisma.class.create({ data: { gradeName, arm, order: 1 } });
}

export function createSubject(name: string, code: string) {
  return prisma.subject.create({ data: { name, code } });
}

export function createTermForSession(academicSessionId: string, name: string, order: number) {
  return prisma.term.create({
    data: {
      academicSessionId,
      name,
      order,
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-12-15"),
      isCurrent: true,
    },
  });
}

export function createAssessmentComponent(
  academicSessionId: string,
  code: string,
  type: "CA" | "EXAM",
  maxScore: number,
  order: number,
) {
  return prisma.assessmentComponent.create({
    data: { academicSessionId, code, name: code, type, maxScore, order },
  });
}

export async function createGradingScaleWithBands(
  academicSessionId: string,
  bands: Array<{ grade: string; min: number; max: number }>,
) {
  const scale = await prisma.gradingScale.create({ data: { academicSessionId } });
  await prisma.gradeBand.createMany({
    data: bands.map((b) => ({ gradingScaleId: scale.id, grade: b.grade, minScore: b.min, maxScore: b.max })),
  });
  return scale;
}

export function createAssignment(
  classId: string,
  subjectId: string,
  teacherId: string,
  academicSessionId: string,
) {
  return prisma.classSubjectAssignment.create({
    data: { classId, subjectId, teacherId, academicSessionId },
  });
}

export function enrollStudent(studentId: string, classId: string, academicSessionId: string) {
  return prisma.enrollment.create({ data: { studentId, classId, academicSessionId } });
}
