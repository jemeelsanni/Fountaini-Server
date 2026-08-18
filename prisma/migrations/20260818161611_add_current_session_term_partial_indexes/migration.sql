-- Prisma's schema DSL cannot express a WHERE clause on a unique index (see
-- the caveat at the top of schema.prisma). These are the DB-level
-- enforcement of "at most one current academic session" and "at most one
-- current term per session," which setCurrentAcademicSession()/
-- setCurrentTerm() previously relied on application logic (a clear-others,
-- then set-self transaction) alone for — logic which turned out to have a
-- real gap under 3-or-more-way concurrent switches. Both service functions
-- now also take a transaction-scoped advisory lock so a legitimate switch
-- never trips these indexes.
CREATE UNIQUE INDEX "AcademicSession_one_current" ON "AcademicSession" ("isCurrent") WHERE "isCurrent";
CREATE UNIQUE INDEX "Term_one_current_per_session" ON "Term" ("academicSessionId") WHERE "isCurrent";
