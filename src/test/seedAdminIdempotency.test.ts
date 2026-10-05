import { beforeEach, describe, expect, it } from "vitest";
import { seedAdmin } from "../lib/seedAdmin.js";
import { prisma } from "../db/client.js";
import { resetDb } from "./resetDb.js";

beforeEach(async () => {
  await resetDb();
});

const BOOTSTRAP_ADMIN_EMAIL = "admin@school.test";

/// prisma/seed.ts (`npm run db:seed`) is meant to be safe to run again at
/// any time, not just once against a fresh database — but seedAdmin()'s
/// upsert previously had the SHAPE of a risk: an `update: {}` that LOOKS
/// like a no-op could easily have grown a field over time without anyone
/// noticing it now silently reverts an admin's own password change, or
/// un-deactivates an account someone turned off on purpose. Confirmed
/// directly rather than trusted from reading the upsert's empty `update`
/// object — exactly the kind of regression a code review wouldn't catch
/// (an added field here looks like a small, safe change in isolation).
describe("seedAdmin() re-run safety", () => {
  it("leaves a changed bootstrap-admin password untouched on re-run", async () => {
    await seedAdmin(prisma);
    const original = await prisma.user.findUniqueOrThrow({ where: { email: BOOTSTRAP_ADMIN_EMAIL } });

    const changedHash = "argon2id$some-hash-representing-a-real-password-change";
    await prisma.user.update({ where: { id: original.id }, data: { passwordHash: changedHash } });

    await seedAdmin(prisma);

    const after = await prisma.user.findUniqueOrThrow({ where: { email: BOOTSTRAP_ADMIN_EMAIL } });
    expect(after.passwordHash).toBe(changedHash);
    expect(after.passwordHash).not.toBe(original.passwordHash);
  });

  it("leaves a deactivated bootstrap admin deactivated on re-run", async () => {
    await seedAdmin(prisma);
    const original = await prisma.user.findUniqueOrThrow({ where: { email: BOOTSTRAP_ADMIN_EMAIL } });
    expect(original.isActive).toBe(true);

    await prisma.user.update({ where: { id: original.id }, data: { isActive: false } });

    await seedAdmin(prisma);

    const after = await prisma.user.findUniqueOrThrow({ where: { email: BOOTSTRAP_ADMIN_EMAIL } });
    expect(after.isActive).toBe(false);
  });

  it("still creates the bootstrap admin on a genuinely fresh database", async () => {
    const before = await prisma.user.findUnique({ where: { email: BOOTSTRAP_ADMIN_EMAIL } });
    expect(before).toBeNull();

    await seedAdmin(prisma);

    const after = await prisma.user.findUniqueOrThrow({ where: { email: BOOTSTRAP_ADMIN_EMAIL } });
    expect(after.isActive).toBe(true);
    const roles = await prisma.userRole.findMany({ where: { userId: after.id } });
    expect(roles.map((r) => r.role)).toEqual(["ADMIN"]);
  });
});
