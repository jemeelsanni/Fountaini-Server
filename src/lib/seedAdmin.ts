import argon2 from "argon2";
import { prisma } from "../db/client.js";

/// Creates (or, on every later run, no-ops on) the bootstrap admin account —
/// the one piece of prisma/seed.ts genuinely worth unit-testing directly
/// (see src/test/seedAdminIdempotency.test.ts), so it lives here rather
/// than inline in that script. Lives in src/ specifically so a test under
/// src/test/ can import it without crossing tsconfig.json's `rootDir: "src"`
/// boundary — prisma/seed.ts imports this the same way seed-demo.ts/
/// wipe-demo.ts already import real src/ services for the same reason.
///
/// `update: {}` on the upsert is deliberate and load-bearing: re-running
/// this (the real sequence — `npm run db:seed` is meant to be safe to run
/// again at any time, not just once) must never silently undo an admin's
/// own password change or an intentional deactivation. Neither
/// passwordHash nor isActive is in the update payload, so Prisma's upsert
/// cannot touch either one on an existing row — confirmed directly by
/// the idempotency test rather than trusted from reading this alone.
export async function seedAdmin(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@school.test";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  // loginId = email here, same as any other bare account with no linked
  // Student/Staff record (see User.loginId's own schema comment) — this
  // seeded admin never gets one of those.
  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { loginId: email, email, passwordHash, roles: { create: [{ role: "ADMIN" }] } },
  });

  console.log(`Seeded admin user: ${admin.email} (id: ${admin.id})`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`Default password used: ${password} — set SEED_ADMIN_PASSWORD to override.`);
  }
}
