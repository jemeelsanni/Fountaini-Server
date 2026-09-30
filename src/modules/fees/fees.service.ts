import { randomBytes } from "node:crypto";
import { Prisma } from "../../../generated/prisma/index.js";
import type { Principal } from "../../authorization/types.js";
import { logger } from "../../config/logger.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { fireAndForget } from "../../lib/fireAndForget.js";
import { toNumber } from "../../lib/sqlNumeric.js";
import { createNotification } from "../notifications/notifications.service.js";
import { getSchool } from "../school/school.service.js";
import type {
  CreateFeeStructureBody,
  RecordPaymentBody,
  UpdateFeeObligationBody,
  UpdateFeeStructureBody,
} from "./fees.schemas.js";

// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------

export async function createFeeStructure(input: CreateFeeStructureBody) {
  const session = await prisma.academicSession.findUnique({ where: { id: input.academicSessionId } });
  if (!session) {
    throw AppError.notFound("Academic session not found");
  }
  if (input.classId) {
    const klass = await prisma.class.findUnique({ where: { id: input.classId } });
    if (!klass) {
      throw AppError.notFound("Class not found");
    }
  }
  if (input.gradeName) {
    const klass = await prisma.class.findFirst({ where: { gradeName: input.gradeName } });
    if (!klass) {
      throw AppError.notFound("No class exists at this grade level");
    }
  }
  if (input.termId) {
    const term = await prisma.term.findUnique({ where: { id: input.termId } });
    if (!term || term.academicSessionId !== input.academicSessionId) {
      throw AppError.badRequest("Term does not belong to this academic session");
    }
  }

  return prisma.feeStructure.create({ data: input });
}

export function listFeeStructures(filter: { academicSessionId?: string }) {
  return prisma.feeStructure.findMany({
    where: { academicSessionId: filter.academicSessionId },
    orderBy: { createdAt: "desc" },
  });
}

/// Deliberately never touches already-generated FeeObligation rows: an
/// obligation's amountDueKobo is set once, at generateObligations() time,
/// from whatever amountKobo the structure had then — that's a real,
/// already-billed amount, not a live reference to the structure's current
/// price. Editing name/amountKobo here only changes what's used the NEXT
/// time generateObligations() runs (e.g. for students who enroll later).
export async function updateFeeStructure(id: string, input: UpdateFeeStructureBody) {
  const structure = await prisma.feeStructure.findUnique({ where: { id } });
  if (!structure) {
    throw AppError.notFound("Fee structure not found");
  }

  // The schema's own refine only sees THIS request's payload — it can't
  // know the row already has a classId from creation (or a gradeName from
  // an earlier update) that this request doesn't mention at all. Merging
  // with the existing row before checking is what actually enforces "at
  // most one" once partial update is in play, same shape as
  // updateGradeBand's own merge check in grading.service.ts.
  const mergedClassId = input.classId !== undefined ? input.classId : structure.classId;
  const mergedGradeName = input.gradeName !== undefined ? input.gradeName : structure.gradeName;
  if (mergedClassId !== null && mergedGradeName !== null) {
    throw AppError.badRequest("A fee structure may target a specific class or a grade level, not both");
  }

  if (input.classId) {
    const klass = await prisma.class.findUnique({ where: { id: input.classId } });
    if (!klass) {
      throw AppError.notFound("Class not found");
    }
  }
  if (input.gradeName) {
    const klass = await prisma.class.findFirst({ where: { gradeName: input.gradeName } });
    if (!klass) {
      throw AppError.notFound("No class exists at this grade level");
    }
  }

  return prisma.feeStructure.update({ where: { id }, data: input });
}

export async function deleteFeeStructure(id: string) {
  const structure = await prisma.feeStructure.findUnique({ where: { id } });
  if (!structure) {
    throw AppError.notFound("Fee structure not found");
  }
  const obligationCount = await prisma.feeObligation.count({ where: { feeStructureId: id } });
  if (obligationCount > 0) {
    throw AppError.conflict(
      "This fee structure already has generated obligations and cannot be deleted — " +
        "deleting it would orphan the payment records against those obligations.",
    );
  }
  await prisma.feeStructure.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Fee obligations
// ---------------------------------------------------------------------------

/// Generates one FeeObligation per actively-enrolled student in scope
/// (feeStructure.classId, or every class if null) who doesn't already have
/// one for this fee structure — skips students who already have a row rather
/// than erroring, so this is safe to re-run after new students enroll.
export async function generateObligations(feeStructureId: string, actorUserId: string) {
  const feeStructure = await prisma.feeStructure.findUnique({ where: { id: feeStructureId } });
  if (!feeStructure) {
    throw AppError.notFound("Fee structure not found");
  }

  // Resolved fresh here, at generation time, not baked in at creation —
  // this is what makes a class added to a gradeName after the structure
  // was created still get covered: this query re-joins against Class on
  // every call, so a new arm is picked up the moment it exists, with no
  // change needed to the FeeStructure row itself.
  const enrollments = await prisma.enrollment.findMany({
    where: {
      academicSessionId: feeStructure.academicSessionId,
      status: "ACTIVE",
      ...(feeStructure.classId
        ? { classId: feeStructure.classId }
        : feeStructure.gradeName
          ? { class: { gradeName: feeStructure.gradeName } }
          : {}),
    },
  });
  if (enrollments.length === 0) {
    throw AppError.badRequest("No actively enrolled students match this fee structure's scope");
  }

  const studentIds = enrollments.map((e) => e.studentId);
  const existing = await prisma.feeObligation.findMany({
    where: { feeStructureId, studentId: { in: studentIds }, termId: feeStructure.termId },
    select: { studentId: true },
  });
  const existingStudentIds = new Set(existing.map((o) => o.studentId));
  const toCreate = studentIds.filter((id) => !existingStudentIds.has(id));

  if (toCreate.length > 0) {
    await prisma.feeObligation.createMany({
      data: toCreate.map((studentId) => ({
        studentId,
        feeStructureId,
        academicSessionId: feeStructure.academicSessionId,
        termId: feeStructure.termId,
        amountDueKobo: feeStructure.amountKobo,
        createdByUserId: actorUserId,
      })),
      // The existing-obligations read above is a stale read the instant a
      // concurrent (or double-clicked) generate for the same fee structure
      // lands in between — without this, createMany aborts the WHOLE batch
      // (unhandled -> 500) on the first row that collides with the unique
      // constraint on (studentId, feeStructureId, termId), instead of
      // quietly keeping whichever obligations already exist.
      skipDuplicates: true,
    });
  }

  return prisma.feeObligation.findMany({ where: { feeStructureId, studentId: { in: studentIds } } });
}

/// Exported for results.service.ts's fee-withholding check (Feature D) —
/// the authoritative "how much is actually still owed" math lives in
/// exactly one place, used both for the obligation-list/read responses and
/// for deciding whether a result should be withheld.
export function withBalance<T extends { amountDueKobo: number; payments: { amountKobo: number }[] }>(obligation: T) {
  const totalPaidKobo = obligation.payments.reduce((sum, p) => sum + p.amountKobo, 0);
  return { ...obligation, totalPaidKobo, outstandingKobo: obligation.amountDueKobo - totalPaidKobo };
}

export async function listObligationsForStudent(studentId: string) {
  const obligations = await prisma.feeObligation.findMany({
    where: { studentId },
    include: { feeStructure: true, payments: { where: { status: "CONFIRMED" } } },
    orderBy: { createdAt: "desc" },
  });
  return obligations.map(withBalance);
}

export async function getFeeObligationById(id: string) {
  const obligation = await prisma.feeObligation.findUnique({
    where: { id },
    include: { feeStructure: true, payments: { where: { status: "CONFIRMED" } } },
  });
  if (!obligation) {
    throw AppError.notFound("Fee obligation not found");
  }
  return withBalance(obligation);
}

export async function updateObligation(id: string, input: UpdateFeeObligationBody) {
  const obligation = await prisma.feeObligation.findUnique({ where: { id } });
  if (!obligation) {
    throw AppError.notFound("Fee obligation not found");
  }

  return prisma.feeObligation.update({ where: { id }, data: input });
}

/// Takes a Prisma client rather than always using the module-level `prisma`
/// so confirmPayment() can run it as part of its own transaction; rejectPayment()
/// still calls it standalone by passing `prisma` itself (which structurally
/// satisfies the same client interface).
async function recomputeObligationStatus(client: Prisma.TransactionClient, feeObligationId: string) {
  const obligation = await client.feeObligation.findUniqueOrThrow({ where: { id: feeObligationId } });
  if (obligation.status === "WAIVED") {
    return;
  }

  const confirmedPayments = await client.payment.findMany({
    where: { feeObligationId, status: "CONFIRMED" },
  });
  const totalPaidKobo = confirmedPayments.reduce((sum, p) => sum + p.amountKobo, 0);

  const status = totalPaidKobo <= 0 ? "PENDING" : totalPaidKobo >= obligation.amountDueKobo ? "PAID" : "PARTIALLY_PAID";

  await client.feeObligation.update({ where: { id: feeObligationId }, data: { status } });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/// Deliberately narrow: catches an accidental resubmission of the SAME
/// transfer (a parent unsure whether their first claim went through,
/// re-submitting minutes later), not a second, genuinely different
/// instalment. Nigerian parents routinely pay in parts — ₦30,000 this
/// week, ₦25,000 next — and an earlier version of this check (a flat cap
/// of one outstanding PENDING claim per obligation, any amount) blocked
/// exactly that: it protected the bursar from noise, not from fraud, and
/// was blunter than the problem required. This version only fires when
/// BOTH the amount and the obligation match an existing PENDING claim
/// (never CONFIRMED — already settled, a new claim after that is a new
/// instalment, not a resubmission; never REJECTED — already decided
/// invalid, a retry afterward is legitimate) from within the last 10
/// minutes. Two genuine instalments of the same size, submitted minutes
/// apart, are rare enough that a clean 409 (try again shortly, or contact
/// the office) is an acceptable cost for catching the actual noise
/// pattern. ADMIN/BURSAR stay exempt — a legitimate manual/bulk entry can
/// mean more than one identical-amount payment recorded close together.
const NEAR_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/// A parent-logged payment is a claim, not a fact: status is never taken
/// from input (recordPaymentSchema has no status field at all — Zod strips
/// one if sent) and always lands PENDING, same as staff-recorded ones.
export async function recordPayment(feeObligationId: string, principal: Principal, input: RecordPaymentBody) {
  const obligation = await prisma.feeObligation.findUnique({ where: { id: feeObligationId } });
  if (!obligation) {
    throw AppError.notFound("Fee obligation not found");
  }

  if (!principal.roles.has("ADMIN") && !principal.roles.has("BURSAR")) {
    const nearDuplicate = await prisma.payment.findFirst({
      where: {
        feeObligationId,
        status: "PENDING",
        amountKobo: input.amountKobo,
        createdAt: { gte: new Date(Date.now() - NEAR_DUPLICATE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (nearDuplicate) {
      throw AppError.conflict(
        "A pending claim for this exact amount was already logged on this obligation in the last few " +
          "minutes — if that one didn't go through, wait for it to be confirmed or rejected rather than " +
          "resubmitting immediately.",
      );
    }
  }

  try {
    return await prisma.payment.create({
      data: {
        feeObligationId,
        amountKobo: input.amountKobo,
        bankReference: input.bankReference,
        paymentDate: input.paymentDate,
        notes: input.notes,
        recordedByUserId: principal.userId,
      },
    });
  } catch (err) {
    // A real bank reference identifies one transfer — the same reference
    // logged twice (Payment_bankReference_key, a partial unique index:
    // WHERE "bankReference" IS NOT NULL AND status != 'REJECTED') is the
    // actual duplicate this schema can prove, unlike the amount+window
    // heuristic above, which is inference. Unscoped by caller on purpose:
    // a real transfer can't legitimately fund two different claims
    // regardless of who's submitting, so ADMIN/BURSAR aren't exempt here.
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict(
        "This bank reference has already been used on another payment claim — a reference identifies one " +
          "transfer, so it can't be logged twice.",
      );
    }
    throw err;
  }
}

function generateReceiptNumber(): string {
  return `RCPT-${Date.now()}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function confirmPayment(id: string, actorUserId: string) {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) {
    throw AppError.notFound("Payment not found");
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Conditional-update claim, same pattern as auth.service.ts refresh():
    // the WHERE clause re-checks status !== PENDING at write time, so only
    // one of two concurrent confirms can actually flip it. The loser gets a
    // clean 409 here instead of a 500 from Receipt's unique constraint on
    // paymentId once both tried to create one.
    const claimed = await tx.payment.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "CONFIRMED", confirmedByUserId: actorUserId, confirmedAt: new Date() },
    });
    if (claimed.count === 0) {
      const current = await tx.payment.findUniqueOrThrow({ where: { id } });
      throw AppError.conflict(`This payment has already been ${current.status.toLowerCase()}`);
    }

    await tx.receipt.create({
      data: { paymentId: id, receiptNumber: generateReceiptNumber(), issuedByUserId: actorUserId },
    });
    await recomputeObligationStatus(tx, payment.feeObligationId);

    return tx.payment.findUniqueOrThrow({ where: { id } });
  });

  // Fire-and-forget: a slow or failing notification must not hold up the
  // response or fail an otherwise-successful confirmation.
  fireAndForget(notifyPaymentConfirmed(id), (err) =>
    logger.error({ err }, "Failed to send payment confirmation notification"),
  );

  return updated;
}

async function notifyPaymentConfirmed(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      feeObligation: {
        include: { student: { include: { parents: { include: { parent: true } } } }, feeStructure: true },
      },
    },
  });
  if (!payment) {
    return;
  }

  for (const link of payment.feeObligation.student.parents) {
    await createNotification({
      type: "PAYMENT_CONFIRMATION",
      recipientUserId: link.parent.userId,
      subject: `Payment confirmed: ${payment.feeObligation.feeStructure.name}`,
      body: `A payment of ₦${(payment.amountKobo / 100).toFixed(2)} for ${payment.feeObligation.feeStructure.name} has been confirmed for ${payment.feeObligation.student.firstName} ${payment.feeObligation.student.lastName}.`,
      channels: ["SMS", "EMAIL"],
      relatedEntityType: "Payment",
      relatedEntityId: payment.id,
    });
  }
}

export async function rejectPayment(id: string, actorUserId: string) {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) {
    throw AppError.notFound("Payment not found");
  }

  return prisma.$transaction(async (tx) => {
    // Mirrors confirmPayment()'s conditional-update claim exactly: the
    // WHERE clause re-checks status !== PENDING at write time, so only one
    // of two concurrent confirm/reject calls on the same payment can
    // actually flip it. The loser gets a clean 409 instead of silently
    // rejecting a payment that's already been confirmed (or vice versa).
    const claimed = await tx.payment.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "REJECTED", confirmedByUserId: actorUserId, confirmedAt: new Date() },
    });
    if (claimed.count === 0) {
      const current = await tx.payment.findUniqueOrThrow({ where: { id } });
      throw AppError.conflict(`This payment has already been ${current.status.toLowerCase()}`);
    }

    await recomputeObligationStatus(tx, payment.feeObligationId);

    return tx.payment.findUniqueOrThrow({ where: { id } });
  });
}

export function listPaymentsForStudent(studentId: string) {
  return prisma.payment.findMany({
    where: { feeObligation: { studentId } },
    include: { feeObligation: { include: { feeStructure: true } }, receipt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getReceiptForPayment(paymentId: string) {
  const receipt = await prisma.receipt.findUnique({ where: { paymentId } });
  if (!receipt) {
    throw AppError.notFound("No receipt has been issued for this payment yet");
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// Bursar payment queue
// ---------------------------------------------------------------------------

interface ListPaymentsFilter {
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  classId?: string;
  studentId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/// recordedByUserId/confirmedByUserId are plain scalar columns, not Prisma
/// relations to User (see schema.prisma's own Payment model) — there's
/// nothing to `include` them through, so resolving "who logged it" to a
/// name is a second, batched query (one User.findMany for every distinct
/// id on this page), not a join. A recorder is always Staff (ADMIN/BURSAR)
/// or Parent, never Student — canCreatePaymentForObligation doesn't grant
/// STUDENT — so checking both covers every real case.
async function resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      staff: { select: { firstName: true, lastName: true } },
      parent: { select: { firstName: true, lastName: true } },
    },
  });
  const names = new Map<string, string>();
  for (const user of users) {
    const person = user.staff ?? user.parent;
    names.set(user.id, person ? `${person.firstName} ${person.lastName}` : "Unknown");
  }
  return names;
}

/// The bursar's work queue: enough per row to triage without a second
/// request. classId filters via the student's ACTIVE enrollment in that
/// class — a pragmatic proxy, not an exact match against the obligation's
/// own academicSessionId (Prisma's relational filters can't compare two
/// fields on different rows without raw SQL) — correct for the common
/// case of filtering the current queue by class, since a past session's
/// enrollment is no longer ACTIVE once a new one starts.
export async function listPayments(filter: ListPaymentsFilter) {
  const where: Prisma.PaymentWhereInput = {
    status: filter.status,
    feeObligation: {
      studentId: filter.studentId,
      student: filter.classId
        ? { enrollments: { some: { classId: filter.classId, status: "ACTIVE" } } }
        : undefined,
    },
    paymentDate: filter.from ?? filter.to ? { gte: filter.from, lte: filter.to } : undefined,
  };

  const [total, payments] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      include: {
        feeObligation: {
          include: {
            student: {
              include: { enrollments: { where: { status: "ACTIVE" }, include: { class: true }, take: 1 } },
            },
            payments: { where: { status: "CONFIRMED" } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
  ]);

  const names = await resolveUserNames(payments.map((p) => p.recordedByUserId));

  const data = payments.map((payment) => {
    const { student } = payment.feeObligation;
    const enrollment = student.enrollments[0];
    const { outstandingKobo } = withBalance(payment.feeObligation);
    return {
      id: payment.id,
      amountKobo: payment.amountKobo,
      bankReference: payment.bankReference,
      paymentDate: payment.paymentDate,
      status: payment.status,
      recordedByUserId: payment.recordedByUserId,
      recordedByName: names.get(payment.recordedByUserId) ?? "Unknown",
      createdAt: payment.createdAt,
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber,
      },
      class: enrollment
        ? {
            id: enrollment.class.id,
            name: `${enrollment.class.gradeName}${enrollment.class.arm ? ` ${enrollment.class.arm}` : ""}`,
          }
        : null,
      feeObligationId: payment.feeObligationId,
      obligationOutstandingKobo: outstandingKobo,
    };
  });

  return { data, total, page: filter.page, pageSize: filter.pageSize };
}

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

interface FeesSummaryFilter {
  academicSessionId?: string;
  termId?: string;
  classId?: string;
}

/// Raw row shape from summaryByClassSql below — bigint/numeric columns come
/// back as JS `bigint` or `string` from node-postgres depending on type, not
/// `number`; normalizeBucketRow() below converts every one to a real number
/// (kobo amounts and counts are both always well within Number's safe
/// integer range for a school this size) so callers never have to think
/// about it.
interface RawClassBucketRow {
  classId: string;
  gradeName: string;
  arm: string | null;
  expectedKobo: bigint | number | string;
  waivedKobo: bigint | number | string;
  fullyPaidCount: bigint | number | string;
  partiallyPaidCount: bigint | number | string;
  unpaidCount: bigint | number | string;
  collectedKobo: bigint | number | string;
  pendingKobo: bigint | number | string;
}

/// Field names deliberately avoid "pending" on the FeeObligation side and
/// "unpaid"/"paid" on the Payment side — FeeObligation.status's PENDING
/// ("nothing confirmed yet") and Payment.status's PENDING ("awaiting
/// confirmation") are different concepts on different rows, and blurring
/// their names in this response is exactly how a bursar ends up unable to
/// tell which one a number refers to.
export interface FeesSummaryBuckets {
  expectedKobo: number;
  collectedKobo: number;
  pendingKobo: number;
  outstandingKobo: number;
  waivedKobo: number;
  fullyPaidCount: number;
  partiallyPaidCount: number;
  unpaidCount: number;
}

function bucketsFromRow(row: RawClassBucketRow): FeesSummaryBuckets {
  const expectedKobo = toNumber(row.expectedKobo);
  const collectedKobo = toNumber(row.collectedKobo);
  return {
    expectedKobo,
    collectedKobo,
    pendingKobo: toNumber(row.pendingKobo),
    // expected minus collected, deliberately NOT minus pending too — a
    // claimed-but-unconfirmed payment is neither collected nor outstanding,
    // it's its own bucket above. Folding it into either one is exactly the
    // mistake that makes this dashboard stop matching the bank statement.
    outstandingKobo: expectedKobo - collectedKobo,
    waivedKobo: toNumber(row.waivedKobo),
    fullyPaidCount: toNumber(row.fullyPaidCount),
    partiallyPaidCount: toNumber(row.partiallyPaidCount),
    unpaidCount: toNumber(row.unpaidCount),
  };
}

function sumBuckets(rows: FeesSummaryBuckets[]): FeesSummaryBuckets {
  return rows.reduce(
    (acc, r) => ({
      expectedKobo: acc.expectedKobo + r.expectedKobo,
      collectedKobo: acc.collectedKobo + r.collectedKobo,
      pendingKobo: acc.pendingKobo + r.pendingKobo,
      outstandingKobo: acc.outstandingKobo + r.outstandingKobo,
      waivedKobo: acc.waivedKobo + r.waivedKobo,
      fullyPaidCount: acc.fullyPaidCount + r.fullyPaidCount,
      partiallyPaidCount: acc.partiallyPaidCount + r.partiallyPaidCount,
      unpaidCount: acc.unpaidCount + r.unpaidCount,
    }),
    {
      expectedKobo: 0,
      collectedKobo: 0,
      pendingKobo: 0,
      outstandingKobo: 0,
      waivedKobo: 0,
      fullyPaidCount: 0,
      partiallyPaidCount: 0,
      unpaidCount: 0,
    },
  );
}

/// Everything aggregated in SQL, in one query, never by fetching obligation/
/// payment rows and reducing them in application code. Three CTEs:
///   1. obligation_scope — every FeeObligation in the requested session/
///      term/class, resolved to its class via the student's Enrollment for
///      THAT SAME academicSessionId (FeeObligation has no classId of its
///      own — see listPayments()'s own comment on the same join).
///   2. obligation_agg — expectedKobo/waivedKobo/the three status counts,
///      grouped by class, computed straight from obligation_scope (no join
///      to Payment here, so no risk of the fan-out a direct join would
///      cause — one obligation can have several payments, which would
///      otherwise multiply amountDueKobo once per matching payment row).
///   3. payment_agg — collectedKobo/pendingKobo, separately, joining
///      obligation_scope to Payment and grouping by class — fan-out here is
///      fine and correct, since this branch only ever sums Payment.amountKobo,
///      never amountDueKobo.
/// The final SELECT joins the two pre-aggregated CTEs by class. The grand
/// total (always returned) is then computed by summing these already-
/// aggregated per-class rows in application code — arithmetic over at most
/// a few dozen numbers, not a reduce over raw obligation/payment rows, so
/// it isn't the thing "aggregate in SQL" is warning against.
export async function getFeesSummary(filter: FeesSummaryFilter) {
  const conditions: Prisma.Sql[] = [];
  if (filter.academicSessionId) {
    conditions.push(Prisma.sql`fo."academicSessionId" = ${filter.academicSessionId}`);
  }
  if (filter.termId) {
    conditions.push(Prisma.sql`fo."termId" = ${filter.termId}`);
  }
  if (filter.classId) {
    conditions.push(Prisma.sql`e."classId" = ${filter.classId}`);
  }
  // Prisma.sql fragments compose by concatenation, not by interpolating
  // into the middle of an existing one — the `WHERE 1=1` below is what
  // lets an arbitrary number of AND-ed conditions (zero or more) attach
  // cleanly regardless of which filters were actually given.
  const whereClause = conditions.length > 0 ? Prisma.sql`AND ${Prisma.join(conditions, " AND ")}` : Prisma.empty;

  const rows = await prisma.$queryRaw<RawClassBucketRow[]>`
    WITH obligation_scope AS (
      SELECT fo.id, fo."amountDueKobo", fo.status, e."classId"
      FROM "FeeObligation" fo
      JOIN "Enrollment" e
        ON e."studentId" = fo."studentId"
       AND e."academicSessionId" = fo."academicSessionId"
      WHERE 1=1 ${whereClause}
    ),
    obligation_agg AS (
      SELECT
        "classId",
        COALESCE(SUM(CASE WHEN status != 'WAIVED' THEN "amountDueKobo" ELSE 0 END), 0) AS "expectedKobo",
        COALESCE(SUM(CASE WHEN status = 'WAIVED' THEN "amountDueKobo" ELSE 0 END), 0) AS "waivedKobo",
        COUNT(*) FILTER (WHERE status = 'PAID') AS "fullyPaidCount",
        COUNT(*) FILTER (WHERE status = 'PARTIALLY_PAID') AS "partiallyPaidCount",
        COUNT(*) FILTER (WHERE status = 'PENDING') AS "unpaidCount"
      FROM obligation_scope
      GROUP BY "classId"
    ),
    payment_agg AS (
      SELECT
        os."classId",
        COALESCE(SUM(CASE WHEN p.status = 'CONFIRMED' THEN p."amountKobo" ELSE 0 END), 0) AS "collectedKobo",
        COALESCE(SUM(CASE WHEN p.status = 'PENDING' THEN p."amountKobo" ELSE 0 END), 0) AS "pendingKobo"
      FROM obligation_scope os
      JOIN "Payment" p ON p."feeObligationId" = os.id
      GROUP BY os."classId"
    )
    SELECT
      cls.id AS "classId", cls."gradeName", cls.arm,
      oa."expectedKobo", oa."waivedKobo", oa."fullyPaidCount", oa."partiallyPaidCount", oa."unpaidCount",
      COALESCE(pa."collectedKobo", 0) AS "collectedKobo",
      COALESCE(pa."pendingKobo", 0) AS "pendingKobo"
    FROM obligation_agg oa
    JOIN "Class" cls ON cls.id = oa."classId"
    LEFT JOIN payment_agg pa ON pa."classId" = oa."classId"
    ORDER BY cls."order"
  `;

  const byClass = rows.map((row) => ({
    classId: row.classId,
    className: `${row.gradeName}${row.arm ? ` ${row.arm}` : ""}`,
    ...bucketsFromRow(row),
  }));

  const total = sumBuckets(byClass);

  // Per-class breakdown only when the caller didn't already scope to one
  // class — a single-class request already IS the "breakdown".
  return filter.classId ? { total } : { total, byClass };
}

// ---------------------------------------------------------------------------
// Student statement
// ---------------------------------------------------------------------------

interface StatementFilter {
  academicSessionId?: string;
  termId?: string;
}

/// Every obligation in scope, every payment against it at every status
/// (unlike listObligationsForStudent/withBalance, which only ever include
/// CONFIRMED payments — a family statement should show a pending or
/// rejected claim too, not just what's already settled), and the resulting
/// balance — computed from CONFIRMED payments only, same rule as
/// recomputeObligationStatus, regardless of what else is shown alongside
/// it. Plus the school's own name/address so the frontend can render this
/// as a printable document without a second request.
export async function getStudentStatement(studentId: string, filter: StatementFilter) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { id: true, firstName: true, lastName: true, admissionNumber: true },
  });
  if (!student) {
    throw AppError.notFound("Student not found");
  }

  const [school, obligations] = await Promise.all([
    getSchool(),
    prisma.feeObligation.findMany({
      where: { studentId, academicSessionId: filter.academicSessionId, termId: filter.termId },
      include: { feeStructure: true, payments: { orderBy: { paymentDate: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return {
    school: { name: school.name, address: school.address },
    student: {
      id: student.id,
      name: `${student.firstName} ${student.lastName}`,
      admissionNumber: student.admissionNumber,
    },
    obligations: obligations.map((obligation) => {
      const confirmedPaidKobo = obligation.payments
        .filter((p) => p.status === "CONFIRMED")
        .reduce((sum, p) => sum + p.amountKobo, 0);
      return {
        id: obligation.id,
        feeStructureName: obligation.feeStructure.name,
        category: obligation.feeStructure.category,
        amountDueKobo: obligation.amountDueKobo,
        status: obligation.status,
        dueDate: obligation.dueDate,
        payments: obligation.payments.map((p) => ({
          id: p.id,
          amountKobo: p.amountKobo,
          status: p.status,
          bankReference: p.bankReference,
          paymentDate: p.paymentDate,
        })),
        totalConfirmedPaidKobo: confirmedPaidKobo,
        balanceKobo: obligation.amountDueKobo - confirmedPaidKobo,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Payment detail
// ---------------------------------------------------------------------------

/// What a bursar needs to decide on a claim: the payment, the obligation,
/// the student/class it's for, who logged it, and the balance before/after
/// — computed the same way regardless of this payment's own status (PENDING,
/// CONFIRMED, or REJECTED), so it reads consistently whether the bursar is
/// still deciding or looking back at a past decision. "Before" is the
/// balance from every OTHER CONFIRMED payment on this obligation (this one
/// excluded, whatever its status); "after" is that minus this payment's own
/// amount — "would this confirmation settle the account, or leave a
/// remainder" for a still-PENDING claim, and "did/would" for a CONFIRMED/
/// REJECTED one.
export async function getPaymentById(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      feeObligation: {
        include: {
          feeStructure: true,
          payments: { where: { status: "CONFIRMED" } },
          student: {
            include: { enrollments: { where: { status: "ACTIVE" }, include: { class: true }, take: 1 } },
          },
        },
      },
    },
  });
  if (!payment) {
    throw AppError.notFound("Payment not found");
  }

  const { feeObligation } = payment;
  const otherConfirmedPaidKobo = feeObligation.payments
    .filter((p) => p.id !== payment.id)
    .reduce((sum, p) => sum + p.amountKobo, 0);
  const balanceBeforeKobo = feeObligation.amountDueKobo - otherConfirmedPaidKobo;
  const balanceAfterKobo = balanceBeforeKobo - payment.amountKobo;

  const [recordedByName, confirmedByName] = await Promise.all([
    resolveUserNames([payment.recordedByUserId]).then((m) => m.get(payment.recordedByUserId) ?? "Unknown"),
    payment.confirmedByUserId
      ? resolveUserNames([payment.confirmedByUserId]).then((m) => m.get(payment.confirmedByUserId!) ?? "Unknown")
      : Promise.resolve(null),
  ]);

  const enrollment = feeObligation.student.enrollments[0];

  return {
    id: payment.id,
    amountKobo: payment.amountKobo,
    method: payment.method,
    bankReference: payment.bankReference,
    paymentDate: payment.paymentDate,
    status: payment.status,
    notes: payment.notes,
    recordedByUserId: payment.recordedByUserId,
    recordedByName,
    createdAt: payment.createdAt,
    confirmedByUserId: payment.confirmedByUserId,
    confirmedByName,
    confirmedAt: payment.confirmedAt,
    student: {
      id: feeObligation.student.id,
      name: `${feeObligation.student.firstName} ${feeObligation.student.lastName}`,
      admissionNumber: feeObligation.student.admissionNumber,
    },
    class: enrollment
      ? {
          id: enrollment.class.id,
          name: `${enrollment.class.gradeName}${enrollment.class.arm ? ` ${enrollment.class.arm}` : ""}`,
        }
      : null,
    feeObligation: {
      id: feeObligation.id,
      feeStructureName: feeObligation.feeStructure.name,
      amountDueKobo: feeObligation.amountDueKobo,
      status: feeObligation.status,
    },
    balanceBeforeKobo,
    balanceAfterKobo,
  };
}
