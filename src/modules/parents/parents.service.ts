import { Prisma } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { fireAndForget } from "../../lib/fireAndForget.js";
import { normalizeEmail } from "../auth/loginIdentifier.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import { createNotification, suppressCredentialNotifications } from "../notifications/notifications.service.js";
import { issueFirstLoginForStudent } from "../students/students.service.js";
import type { CreateParentBody, LinkChildBody, UpdateParentBody } from "./parents.schemas.js";

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
      sensitive: true,
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
  const email = normalizeEmail(input.email);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  let parent;
  try {
    parent = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          loginId: email,
          email,
          passwordHash,
          mustChangePassword: true,
          passwordIssuedAt: new Date(),
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

  deliverParentCredentials(parent, email, temporaryPassword);
  return parent;
}

/// How long a soft-deleted Parent stays restorable before
/// purgeDeletedParents removes it for good.
export const PARENT_PURGE_AFTER_DAYS = 30;
const PARENT_PURGE_AFTER_MS = PARENT_PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000;

export function listParents() {
  return prisma.parent.findMany({ where: { deletedAt: null }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
}

/// The admin's view of the restore window: every soft-deleted Parent still
/// awaiting purge, most recently deleted first, with the date
/// purgeDeletedParents will remove it — the only way to find a parent to
/// pass to restoreParent, since every other parent read excludes them.
export async function listDeletedParents() {
  const parents = await prisma.parent.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
  });
  // flatMap with a real null check rather than a non-null assertion: the
  // where clause guarantees deletedAt is set, but the compiler can't see
  // that, and this keeps deletedAt typed as Date (not Date | null) in the
  // response, matching DeletedParentSchema.
  return parents.flatMap(({ deletedAt, ...parent }) =>
    deletedAt ? [{ ...parent, deletedAt, purgeAt: new Date(deletedAt.getTime() + PARENT_PURGE_AFTER_MS) }] : [],
  );
}

export async function getParentById(id: string) {
  const parent = await prisma.parent.findUnique({ where: { id, deletedAt: null } });
  if (!parent) {
    throw AppError.notFound("Parent not found");
  }
  return parent;
}

/// data: input passed straight through, not manually merged field-by-field —
/// Prisma's own update() already treats an undefined field as "don't touch"
/// and an explicit null as "set to null", which is exactly the distinction
/// updateParentSchema's .nullable().optional() fields preserve from the
/// request body. Login email/loginId is never touched here — see
/// parents.routes.ts's route comment on why that's a separate concern.
export async function updateParent(id: string, input: UpdateParentBody) {
  const parent = await prisma.parent.findUnique({ where: { id, deletedAt: null } });
  if (!parent) {
    throw AppError.notFound("Parent not found");
  }
  return prisma.parent.update({ where: { id }, data: input });
}

export async function linkChild(parentId: string, input: LinkChildBody) {
  const [parent, student] = await Promise.all([
    prisma.parent.findUnique({
      where: { id: parentId, deletedAt: null },
      include: { user: { select: { email: true } } },
    }),
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

/// Soft delete, in one transaction: stamps deletedAt, unlinks every child,
/// and removes the PARENT role. Unlinking and the role removal are what
/// actually cut the parent off — every scope resolver, fee/result
/// notification and primary-contact lookup reads through StudentParent
/// links or the PARENT role, so none of them needs a deletedAt filter of
/// its own. Unlinking is not undone by restoreParent: an admin relinks
/// children explicitly, the same as for any new parent.
///
/// Never just the Parent row: a User still holding PARENT with no live
/// Parent record is rejected by buildAccessTokenPayload (auth.service.ts) at
/// every token issuance — for a staff-parent that would lock them out of
/// their staff access too. A User left with no roles at all is deactivated
/// (it could no longer log in anyway); refresh tokens are revoked either
/// way, since every live token still carries this parentId and PARENT.
export async function deleteParent(parentId: string) {
  await prisma.$transaction(async (tx) => {
    // updateMany rather than findUnique-then-update, same reasoning as
    // unlinkChild: a concurrent delete of the same parent becomes a clean
    // 404 instead of a double-stamp.
    const { count } = await tx.parent.updateMany({
      where: { id: parentId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) {
      throw AppError.notFound("Parent not found");
    }
    const { userId } = await tx.parent.findUniqueOrThrow({ where: { id: parentId }, select: { userId: true } });

    await tx.studentParent.deleteMany({ where: { parentId } });
    await tx.userRole.deleteMany({ where: { userId, role: "PARENT" } });
    if ((await tx.userRole.count({ where: { userId } })) === 0) {
      await tx.user.update({ where: { id: userId }, data: { isActive: false } });
    }
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
}

/// Undoes deleteParent within the PARENT_PURGE_AFTER_DAYS window: clears
/// deletedAt, gives back the PARENT role, and reactivates the User. Child
/// links are NOT restored (see deleteParent) — the restored parent starts
/// with no children until an admin relinks them.
export async function restoreParent(parentId: string) {
  return prisma.$transaction(async (tx) => {
    const parent = await tx.parent.findUnique({ where: { id: parentId } });
    if (!parent || !parent.deletedAt) {
      throw AppError.notFound("No deleted parent with this id");
    }
    await tx.userRole.upsert({
      where: { userId_role: { userId: parent.userId, role: "PARENT" } },
      create: { userId: parent.userId, role: "PARENT" },
      update: {},
    });
    await tx.user.update({ where: { id: parent.userId }, data: { isActive: true } });
    return tx.parent.update({ where: { id: parentId }, data: { deletedAt: null } });
  });
}

/// Permanently removes every Parent soft-deleted more than
/// PARENT_PURGE_AFTER_DAYS ago. Run on a schedule by
/// scripts/purgeDeletedParents.ts. Only the Parent row goes — its links and
/// PARENT role were already removed at soft-delete time, and the User stays
/// (deactivated, or still a staff member) because NotificationEvent and
/// AuditLog reference it without a cascade.
export async function purgeDeletedParents(now = new Date()) {
  const cutoff = new Date(now.getTime() - PARENT_PURGE_AFTER_MS);
  const { count } = await prisma.parent.deleteMany({ where: { deletedAt: { lt: cutoff } } });
  return { purged: count, cutoff };
}
