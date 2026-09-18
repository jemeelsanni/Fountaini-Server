import type { Prisma } from "../../../generated/prisma/index.js";
import { AppError } from "../../errors/AppError.js";

/// No fallback to the calendar year, ever — a session-less creation is a
/// setup error the admin needs to fix (mark a session current), not
/// something to paper over with a number that would misrecord the
/// admission/employment year.
export async function getCurrentSessionStartYear(tx: Prisma.TransactionClient): Promise<number> {
  const session = await tx.academicSession.findFirst({
    where: { isCurrent: true },
    select: { startDate: true },
  });
  if (!session) {
    throw AppError.badRequest(
      "Cannot issue an admission/staff number: no academic session is marked current",
    );
  }
  return session.startDate.getFullYear();
}

/// Single atomic upsert-increment: handles both "this prefix has never been
/// used" and "this prefix already has a counter" in one statement, so
/// there's no separate existence check to race on. The row this touches
/// (existing or newly inserted) is locked for the rest of the transaction,
/// which is what actually makes two concurrent callers for the SAME prefix
/// serialize into two different numbers rather than a shared one — see
/// docs/concurrency.md.
async function incrementCounter(tx: Prisma.TransactionClient, prefix: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ lastValue: number }>>`
    INSERT INTO "IdentifierCounter" ("prefix", "lastValue")
    VALUES (${prefix}, 1)
    ON CONFLICT ("prefix") DO UPDATE SET "lastValue" = "IdentifierCounter"."lastValue" + 1
    RETURNING "lastValue"
  `;
  return rows[0]!.lastValue;
}

/// Bumps a prefix's counter up to `sequence` if it isn't already there —
/// used when an admin's explicit override number is ahead of what the
/// generator has issued so far for that prefix, so the generator never
/// reissues the imported number to someone else later (see
/// IdentifierCounter's own schema comment). A no-op if the counter is
/// already at or past `sequence`.
async function bumpCounterAtLeast(tx: Prisma.TransactionClient, prefix: string, sequence: number): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "IdentifierCounter" ("prefix", "lastValue")
    VALUES (${prefix}, ${sequence})
    ON CONFLICT ("prefix") DO UPDATE SET "lastValue" = GREATEST("IdentifierCounter"."lastValue", ${sequence})
  `;
}

const MAX_SEQUENCE = 999;

function formatSequence(prefix: string, sequence: number): string {
  return `${prefix}/${String(sequence).padStart(3, "0")}`;
}

export const ADMISSION_NUMBER_FORMAT = /^FIA\/\d{4}\/\d{3}$/;
export const STAFF_NUMBER_FORMAT = /^FIA\/ST\d{4}\/\d{3}$/;

function studentPrefix(year: number): string {
  return `FIA/${year}`;
}
function staffPrefix(year: number): string {
  return `FIA/ST${year}`;
}

/// Must run inside the same transaction as the Student insert it feeds —
/// see students.service.ts's createStudent. Deliberately does NOT roll
/// back its own increment on the MAX_SEQUENCE throw below: it doesn't need
/// to — an AppError thrown from inside the caller's transaction callback
/// aborts the whole transaction, so a failed creation never actually
/// consumes a sequence number (only a creation that fails AFTER this point
/// for an unrelated reason leaves the gap the batch spec accepts).
export async function generateAdmissionNumber(tx: Prisma.TransactionClient, year: number): Promise<string> {
  const prefix = studentPrefix(year);
  const sequence = await incrementCounter(tx, prefix);
  if (sequence > MAX_SEQUENCE) {
    throw AppError.conflict(
      `No more admission numbers are available for ${year} — the ${MAX_SEQUENCE}-sequence limit for "${prefix}" has been reached`,
    );
  }
  return formatSequence(prefix, sequence);
}

export async function generateStaffNumber(tx: Prisma.TransactionClient, year: number): Promise<string> {
  const prefix = staffPrefix(year);
  const sequence = await incrementCounter(tx, prefix);
  if (sequence > MAX_SEQUENCE) {
    throw AppError.conflict(
      `No more staff numbers are available for ${year} — the ${MAX_SEQUENCE}-sequence limit for "${prefix}" has been reached`,
    );
  }
  return formatSequence(prefix, sequence);
}

/// Registers an admin-supplied override number against the counter it
/// would otherwise have come from, so a later generated number can never
/// collide with it. The prefix (and therefore the year) is parsed directly
/// out of `value` itself, NOT taken from the current session — a legacy
/// paper-record import is very often from a PAST year, not the current
/// one, and computing the prefix from "today's current session" instead
/// would silently misparse the sequence for any override that isn't from
/// this year. This also means registering an override never depends on a
/// current session existing at all — only generation does.
export async function registerAdmissionNumberOverride(tx: Prisma.TransactionClient, value: string): Promise<void> {
  const match = /^(FIA\/\d{4})\/(\d{3})$/.exec(value);
  if (!match) {
    throw AppError.internal(`Admission number override "${value}" passed schema validation but failed to parse`);
  }
  await bumpCounterAtLeast(tx, match[1]!, Number(match[2]));
}

export async function registerStaffNumberOverride(tx: Prisma.TransactionClient, value: string): Promise<void> {
  const match = /^(FIA\/ST\d{4})\/(\d{3})$/.exec(value);
  if (!match) {
    throw AppError.internal(`Staff number override "${value}" passed schema validation but failed to parse`);
  }
  await bumpCounterAtLeast(tx, match[1]!, Number(match[2]));
}
