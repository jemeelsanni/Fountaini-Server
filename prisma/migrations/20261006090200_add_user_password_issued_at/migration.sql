-- User.passwordIssuedAt: when the current (server-generated) password was
-- issued or reissued — see the column's own comment in schema.prisma and
-- login()'s expiry check in auth.service.ts. Nullable, and left null for
-- every existing row on purpose: expiry is enforced only going forward,
-- never retroactively locking out an account that was already fine.
ALTER TABLE "User" ADD COLUMN "passwordIssuedAt" TIMESTAMP(3);
