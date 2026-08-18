-- Prisma's schema DSL cannot express a WHERE clause on a unique index (see
-- the caveat at the top of schema.prisma). This is the DB-level enforcement
-- of "at most one active QR code per student" that rotateQrCode() previously
-- relied on application logic alone for.
CREATE UNIQUE INDEX "StudentQrCode_one_active_per_student" ON "StudentQrCode" ("studentId") WHERE "isActive";
