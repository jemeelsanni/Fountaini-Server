import { Prisma } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { fireAndForget } from "../../lib/fireAndForget.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import { createNotification, suppressCredentialNotifications } from "../notifications/notifications.service.js";
import { issueFirstLoginForStudent } from "../students/students.service.js";
import type { CreateParentBody, LinkChildBody } from "./parents.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/// Fire-and-forget, same shape as staff.service.ts's deliverStaffCredentials
/// — a parent always has their own email (createParentSchema requires it),
/// so there's no destination resolution to await first and no "return the
/// password instead" fallback: a parent account is never created without
/// somewhere to send its credentials.
function deliverParentCredentials(parent: { id: string; userId: string }, email: string, temporaryPassword: string): void {
  if (suppressCredentialNotifications) {
    return;
  }
  fireAndForget(
    createNotification({
      type: "CREDENTIALS_ISSUED",
      recipientUserId: parent.userId,
      subject: "Your school portal login",
      body:
        `Your login ID is ${email}. Temporary password: ${temporaryPassword}. ` +
        `You'll be asked to change it the first time you sign in.`,
      channels: ["EMAIL"],
      relatedEntityType: "Parent",
      relatedEntityId: parent.id,
    }),
    (err) => logger.error({ err, email }, "Failed to send parent credential notification"),
  );
}

/// Atomic: creates the User (loginId = email, generated password,
/// mustChangePassword: true, PARENT role) and the Parent row in one
/// transaction — matching students.service.ts::issueFirstLoginForStudent
/// and staff.service.ts::createStaff. Replaces the old two-step
/// POST /api/users -> POST /api/parents flow, which left a window where a
/// PARENT-role User existed with no linked Parent record (see
/// auth.service.ts's buildAccessTokenPayload for the boundary check this
/// closes off going forward, not just retroactively).
export async function createParent(input: CreateParentBody) {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  let parent;
  try {
    parent = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          loginId: input.email,
          email: input.email,
          passwordHash,
          mustChangePassword: true,
          roles: { create: [{ role: "PARENT" }] },
        },
      });
      return tx.parent.create({
        data: {
          userId: user.id,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          alternatePhone: input.alternatePhone,
          address: input.address,
        },
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A user with this email already exists");
    }
    throw err;
  }

  deliverParentCredentials(parent, input.email, temporaryPassword);
  return parent;
}

export function listParents() {
  return prisma.parent.findMany({ orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
}

export async function getParentById(id: string) {
  const parent = await prisma.parent.findUnique({ where: { id } });
  if (!parent) {
    throw AppError.notFound("Parent not found");
  }
  return parent;
}

export async function linkChild(parentId: string, input: LinkChildBody) {
  const [parent, student] = await Promise.all([
    prisma.parent.findUnique({ where: { id: parentId }, include: { user: { select: { email: true } } } }),
    prisma.student.findUnique({ where: { id: input.studentId } }),
  ]);
  if (!parent) throw AppError.notFound("Parent not found");
  if (!student) throw AppError.notFound("Student not found");

  let link;
  try {
    link = await prisma.studentParent.create({
      data: {
        parentId,
        studentId: input.studentId,
        relationship: input.relationship,
        isPrimaryContact: input.isPrimaryContact ?? false,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Two different unique constraints can produce this same P2002: the
      // ordinary (studentId, parentId) one, and the partial index enforcing
      // at most one isPrimaryContact per student (see StudentParent's own
      // schema comment) — distinguished by the index name Postgres reports
      // in meta.target, since only the second one is actually caused by
      // what THIS request is trying to do (isPrimaryContact: true) rather
      // than a plain duplicate link.
      const target = err.meta?.target;
      const isPrimaryContactConflict =
        typeof target === "string" && target.includes("one_primary_contact_per_student");
      throw AppError.conflict(
        isPrimaryContactConflict
          ? "This student already has a different primary-contact parent"
          : "This student is already linked to this parent",
      );
    }
    throw err;
  }

  // Fire-and-forget, same posture as fees.service.ts's notifyPaymentConfirmed:
  // a slow password hash + email send must not hold up this response, and
  // issueFirstLoginForStudent already catches and logs its own errors
  // rather than ever rejecting. Fires only on a primary-contact link, and
  // only ever does anything for this student's FIRST login —
  // issueFirstLoginForStudent is the sole authority on that (it checks
  // fresh, not a flag passed in here), so a non-primary link, or relinking
  // a student who already has one, correctly does nothing.
  if (link.isPrimaryContact) {
    fireAndForget(
      issueFirstLoginForStudent(student.id, { userId: parent.userId, user: parent.user }),
      // issueFirstLoginForStudent already catches and logs its own errors
      // rather than ever rejecting — this is belt-and-suspenders, not a
      // realistically reachable branch.
      (err) => logger.error({ err, studentId: student.id }, "issueFirstLoginForStudent rejected unexpectedly"),
    );
  }

  return link;
}

export async function unlinkChild(parentId: string, studentId: string) {
  // deleteMany rather than findUnique-then-delete: a concurrent unlink of
  // the same pair racing in between would make the delete-by-id throw
  // P2025 (unhandled -> 500) once the row it found is already gone.
  // deleteMany matches fresh at delete time and just reports 0 affected
  // rows instead of erroring, which cleanly becomes the same 404.
  const { count } = await prisma.studentParent.deleteMany({ where: { studentId, parentId } });
  if (count === 0) {
    throw AppError.notFound("This student is not linked to this parent");
  }
}

export function listChildrenForParent(parentId: string) {
  return prisma.studentParent.findMany({
    where: { parentId },
    include: { student: true },
  });
}
