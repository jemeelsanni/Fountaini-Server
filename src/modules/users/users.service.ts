import { Prisma, type Role } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { fireAndForget } from "../../lib/fireAndForget.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import {
  createNotification,
  suppressCredentialNotifications,
} from "../notifications/notifications.service.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const userListSelect = {
  id: true,
  loginId: true,
  email: true,
  mustChangePassword: true,
  roles: { select: { role: true } },
  isActive: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

function flattenRoles<T extends { roles: { role: Role }[] }>(
  user: T,
): Omit<T, "roles"> & { roles: Role[] } {
  return { ...user, roles: user.roles.map((ur) => ur.role) };
}

export async function createUser(input: { email: string; role: Role }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw AppError.conflict("A user with this email already exists");
  }

  // Admin-created accounts never get an admin-chosen password — always
  // generated, always mustChangePassword: true, same as
  // students.service.ts/staff.service.ts's atomic creation paths. Here,
  // email is always the destination (it's required by createUserSchema
  // and IS this account's loginId), so unlike student creation there's no
  // "no destination, return it in the response" fallback — this account
  // always has somewhere to send it.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  let user;
  try {
    user = await prisma.user.create({
      data: {
        loginId: input.email,
        email: input.email,
        passwordHash,
        mustChangePassword: true,
        roles: { create: [{ role: input.role }] },
      },
      select: userListSelect,
    });
  } catch (err) {
    // The existence check above is a stale read the instant a concurrent
    // signup for the same email lands between it and this create() — the
    // DB's own unique constraint is the real backstop, translated into the
    // same 409 the pre-check gives rather than an unhandled 500.
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A user with this email already exists");
    }
    throw err;
  }

  fireAndForget(
    createNotification({
      type: "CREDENTIALS_ISSUED",
      recipientUserId: user.id,
      subject: "Your school portal login",
      body:
        `Your login ID is ${input.email}. Temporary password: ${temporaryPassword}. ` +
        `You'll be asked to change it the first time you sign in.`,
      channels: ["EMAIL"],
      relatedEntityType: "User",
      relatedEntityId: user.id,
      sensitive: true,
    }),
    (err) => logger.error({ err }, "Failed to send user credential notification"),
  );

  return flattenRoles(user);
}

export async function listUsers() {
  const users = await prisma.user.findMany({
    select: userListSelect,
    orderBy: { createdAt: "desc" },
  });
  return users.map(flattenRoles);
}

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: userListSelect });
  if (!user) {
    throw AppError.notFound("User not found");
  }
  return flattenRoles(user);
}

export async function setUserActive(id: string, isActive: boolean) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw AppError.notFound("User not found");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive },
    select: userListSelect,
  });

  if (!isActive) {
    // Deactivation must kill live sessions immediately, not just block new logins.
    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return flattenRoles(updated);
}

/// The account to notify/contact when a student has no email of their own —
/// the flagged isPrimaryContact link if one exists (see StudentParent's own
/// comment: at most one, enforced by a partial unique index), otherwise the
/// earliest-linked parent. Returns null if the student has no linked
/// parents at all. Shared by credential issuance (parents.service.ts's
/// linkChild, via issueFirstLoginForStudent), reissueCredentialsForUser
/// below, and password-reset destination resolution (auth.service.ts).
/// Lives here rather than students.service.ts specifically so
/// reissueCredentialsForUser can call it without students.service.ts and
/// this module importing each other in a cycle — students.service.ts's own
/// reissueCredentialsForStudent now delegates to reissueCredentialsForUser
/// instead of needing this directly.
export async function resolvePrimaryContactParent(studentId: string) {
  const links = await prisma.studentParent.findMany({
    where: { studentId },
    include: { parent: { include: { user: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (links.length === 0) {
    return null;
  }
  return links.find((l) => l.isPrimaryContact) ?? links[0]!;
}

/// The one implementation behind both POST /api/users/:id/reissue-credentials
/// and POST /api/students/:id/reissue-credentials (students.service.ts's
/// reissueCredentialsForStudent delegates here after its own 404/409
/// student-specific checks). Always generates a fresh password (never
/// admin-chosen), always resets mustChangePassword to true, and always
/// revokes existing refresh tokens — a freshly issued credential must not
/// coexist with sessions built on whatever existed before it, the same
/// posture changePassword()/resetPassword() already take.
///
/// Destination resolution has exactly one branch that can lack a
/// destination: a student-linked account has no email of its own and is
/// redirected to resolvePrimaryContactParent, which can legitimately return
/// nothing (every linked parent unlinked, or none ever had an email) — that
/// case returns `temporaryPassword` in the result for a paper hand-over,
/// exactly like students.service.ts's pre-existing behavior. Staff, parent,
/// and bare accounts always have their own email (required at creation by
/// createStaffSchema/createParentSchema/createUserSchema) — delivery there
/// cannot fail to have a destination, so `temporaryPassword` is never
/// present in the result for those three.
export async function reissueCredentialsForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { staff: true, parent: true, student: true },
  });
  if (!user) {
    throw AppError.notFound("User not found");
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: true } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  if (user.student) {
    const student = user.student;
    const contact = await resolvePrimaryContactParent(student.id);
    const parentEmail = contact?.parent.user.email;
    if (!contact || !parentEmail) {
      return { id: user.id, temporaryPassword };
    }
    if (!suppressCredentialNotifications) {
      await createNotification({
        type: "CREDENTIALS_ISSUED",
        recipientUserId: contact.parent.userId,
        subject: `Login credentials for ${student.firstName} ${student.lastName}`,
        body:
          `A new temporary password has been issued for ${student.firstName} ${student.lastName}'s ` +
          `school portal login (${student.admissionNumber}): ${temporaryPassword}. ` +
          `They'll be asked to change it the first time they sign in.`,
        channels: ["EMAIL"],
        relatedEntityType: "Student",
        relatedEntityId: student.id,
        sensitive: true,
      });
    }
    return { id: user.id };
  }

  // Staff, parent, or bare account — always has its own email (enforced at
  // creation; see this function's own comment), so there is no destination
  // fallback to consider here.
  if (!suppressCredentialNotifications) {
    await createNotification({
      type: "CREDENTIALS_ISSUED",
      recipientUserId: user.id,
      subject: "Your school portal login",
      body:
        `A new temporary password has been issued for your school portal login (${user.loginId}): ` +
        `${temporaryPassword}. You'll be asked to change it the first time you sign in.`,
      channels: ["EMAIL"],
      relatedEntityType: user.staff ? "Staff" : user.parent ? "Parent" : "User",
      relatedEntityId: user.staff?.id ?? user.parent?.id ?? user.id,
      sensitive: true,
    });
  }
  return { id: user.id };
}

/// The onboarding chase list: every active account still on its
/// server-generated password, i.e. one that has never actually been signed
/// into, paired with the most recent CREDENTIALS_ISSUED email's delivery
/// status. For a student-linked account (no email of its own), the
/// relevant event is the one sent to their primary-contact parent
/// (relatedEntityType "Student", not recipientUserId — see
/// reissueCredentialsForUser) — matched on relatedEntityId so a parent
/// chasing several children's accounts doesn't collapse them into one
/// status. `null` status means no CREDENTIALS_ISSUED email was ever
/// recorded at all (e.g. SUPPRESS_CREDENTIAL_NOTIFICATIONS was set when
/// this account was created), distinct from an EMAIL delivery that exists
/// and is PENDING/FAILED/SENT/DELIVERED.
export async function listPendingActivation() {
  const users = await prisma.user.findMany({
    where: { mustChangePassword: true, isActive: true },
    select: {
      id: true,
      loginId: true,
      email: true,
      createdAt: true,
      roles: { select: { role: true } },
      student: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (users.length === 0) {
    return [];
  }

  const directUserIds = users.filter((u) => !u.student).map((u) => u.id);
  const studentIds = users.filter((u) => u.student).map((u) => u.student!.id);

  const events = await prisma.notificationEvent.findMany({
    where: {
      type: "CREDENTIALS_ISSUED",
      OR: [
        ...(directUserIds.length > 0 ? [{ recipientUserId: { in: directUserIds } }] : []),
        ...(studentIds.length > 0
          ? [{ relatedEntityType: "Student", relatedEntityId: { in: studentIds } }]
          : []),
      ],
    },
    select: {
      recipientUserId: true,
      relatedEntityType: true,
      relatedEntityId: true,
      deliveries: { where: { channel: "EMAIL" }, select: { status: true }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });

  // Newest-first, so the first match recorded for a given key is its latest.
  const latestByDirectUser = new Map<string, (typeof events)[number]>();
  const latestByStudent = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    if (event.relatedEntityType === "Student" && event.relatedEntityId) {
      if (!latestByStudent.has(event.relatedEntityId)) {
        latestByStudent.set(event.relatedEntityId, event);
      }
    } else if (!latestByDirectUser.has(event.recipientUserId)) {
      latestByDirectUser.set(event.recipientUserId, event);
    }
  }

  return users.map((user) => {
    const event = user.student ? latestByStudent.get(user.student.id) : latestByDirectUser.get(user.id);
    return {
      id: user.id,
      loginId: user.loginId,
      email: user.email,
      roles: user.roles.map((ur) => ur.role),
      createdAt: user.createdAt,
      latestCredentialDeliveryStatus: event?.deliveries[0]?.status ?? null,
    };
  });
}
