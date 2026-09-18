import { Prisma, type Role } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import {
  generateStaffNumber,
  getCurrentSessionStartYear,
  registerStaffNumberOverride,
} from "../identifiers/identifiers.service.js";
import { createNotification } from "../notifications/notifications.service.js";
import type { CreateStaffBody, UpdateStaffBody } from "./staff.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/// Fire-and-forget, same shape as notifyPaymentConfirmed in
/// fees.service.ts — staff always has their own email (createStaffSchema
/// requires it), so unlike student delivery there's no destination
/// resolution to await first, and therefore no "return the password
/// instead" fallback: a staff account is never created without somewhere
/// to send its credentials.
function deliverStaffCredentials(staff: { id: string; staffNumber: string }, userId: string, email: string, temporaryPassword: string): void {
  createNotification({
    type: "CREDENTIALS_ISSUED",
    recipientUserId: userId,
    subject: "Your school portal login",
    body:
      `Your login ID is ${staff.staffNumber}. Temporary password: ${temporaryPassword}. ` +
      `You'll be asked to change it the first time you sign in.`,
    channels: ["EMAIL"],
    relatedEntityType: "Staff",
    relatedEntityId: staff.id,
  }).catch((err: unknown) => {
    logger.error({ err, email }, "Failed to send staff credential notification");
  });
}

/// Atomic: generates (or registers an override for) the staff number,
/// creates the User (with a generated password, mustChangePassword: true)
/// and the Staff row in one transaction — see the report on why the old
/// two-step POST /api/users -> POST /api/staff flow can't survive a
/// loginId derived from a number that doesn't exist until this row is
/// written.
export async function createStaff(input: CreateStaffBody) {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  let staff;
  try {
    staff = await prisma.$transaction(async (tx) => {
      let staffNumber: string;
      if (input.staffNumber) {
        // A legacy import may be from any past year — registering it
        // never needs "a session is current right now" to be true.
        staffNumber = input.staffNumber;
        await registerStaffNumberOverride(tx, staffNumber);
      } else {
        const year = await getCurrentSessionStartYear(tx);
        staffNumber = await generateStaffNumber(tx, year);
      }

      const user = await tx.user.create({
        data: {
          loginId: staffNumber,
          email: input.email,
          passwordHash,
          mustChangePassword: true,
          roles: { create: [{ role: input.role }] },
        },
      });

      return tx.staff.create({
        data: {
          userId: user.id,
          staffNumber,
          firstName: input.firstName,
          lastName: input.lastName,
          otherNames: input.otherNames,
          department: input.department,
          employmentDate: input.employmentDate,
        },
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Could be the staffNumber/loginId collision (an override reused by
      // mistake) or the email already belonging to another User —
      // distinguished with a plain (non-transactional) lookup: a Postgres
      // transaction aborts its whole session the instant one statement
      // inside it errors, so querying via the same `tx` here (the
      // transaction just rolled back) would itself throw 25P02 instead of
      // answering anything (see docs/concurrency.md's own note on this
      // trap) — this uses the module-level `prisma` client instead, after
      // the rollback has already completed.
      const existingEmailUser = await prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      throw AppError.conflict(
        existingEmailUser
          ? "A user with this email already exists"
          : "A staff member with this staff number already exists",
      );
    }
    throw err;
  }

  deliverStaffCredentials(staff, staff.userId, input.email, temporaryPassword);
  return staff;
}

const staffUserSelect = { email: true, roles: { select: { role: true } } } as const;

function flattenUserRoles<U extends { roles: { role: Role }[] }, S extends { user: U }>(
  staff: S,
): Omit<S, "user"> & { user: Omit<U, "roles"> & { roles: Role[] } } {
  return {
    ...staff,
    user: { ...staff.user, roles: staff.user.roles.map((ur) => ur.role) },
  };
}

export async function listStaff() {
  const staff = await prisma.staff.findMany({
    include: { user: { select: staffUserSelect } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return staff.map((s) => flattenUserRoles(s));
}

export async function getStaffById(id: string) {
  const staff = await prisma.staff.findUnique({
    where: { id },
    include: { user: { select: staffUserSelect } },
  });
  if (!staff) {
    throw AppError.notFound("Staff member not found");
  }
  return flattenUserRoles(staff);
}

export async function updateStaff(id: string, input: UpdateStaffBody) {
  const staff = await prisma.staff.findUnique({ where: { id } });
  if (!staff) {
    throw AppError.notFound("Staff member not found");
  }

  try {
    if (input.staffNumber === undefined) {
      return await prisma.staff.update({ where: { id }, data: input });
    }

    // staffNumber changed — the linked User's loginId must change with it,
    // in the same transaction (Staff.userId is never null, unlike
    // Student's).
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.staff.update({ where: { id }, data: input });
      await tx.user.update({ where: { id: updated.userId }, data: { loginId: input.staffNumber! } });
      return updated;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A staff member with this staff number already exists");
    }
    throw err;
  }
}
