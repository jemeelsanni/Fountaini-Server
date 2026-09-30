import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { toNumber } from "../../lib/sqlNumeric.js";
import { getFeesSummary } from "../fees/fees.service.js";
import { resolvePrimaryContactParent } from "../students/students.service.js";
import type { PaymentHistoryQuery, ScopedReportQuery } from "./reports.schemas.js";

interface RawDefaulterRow {
  studentId: string;
  firstName: string;
  lastName: string;
  admissionNumber: string;
  classId: string;
  gradeName: string;
  arm: string | null;
  outstandingKobo: bigint | number | string;
}

/// Every student with a positive outstanding balance in scope, by class,
/// with the primary-contact parent's name and phone — a chasing list is
/// useless without contact details. Aggregated in SQL per student (one
/// student can have several obligations; this sums the outstanding across
/// all of them, not per-obligation), same CTE shape as
/// fees.service.ts::getFeesSummary. The primary-contact lookup itself is
/// per-student (resolvePrimaryContactParent, the same helper credential
/// issuance and password-reset already use) — not folded into the SQL,
/// since it's identity resolution, not a kobo/count aggregate, and reusing
/// the existing, already-correct helper beats a second implementation of
/// "which parent is primary" in raw SQL.
export async function getDefaultersReport(filter: ScopedReportQuery) {
  const conditions: Prisma.Sql[] = [Prisma.sql`fo.status != 'WAIVED'`];
  if (filter.academicSessionId) {
    conditions.push(Prisma.sql`fo."academicSessionId" = ${filter.academicSessionId}`);
  }
  if (filter.termId) {
    conditions.push(Prisma.sql`fo."termId" = ${filter.termId}`);
  }

  const rows = await prisma.$queryRaw<RawDefaulterRow[]>`
    WITH obligation_scope AS (
      SELECT fo.id, fo."amountDueKobo", fo."studentId", e."classId"
      FROM "FeeObligation" fo
      JOIN "Enrollment" e
        ON e."studentId" = fo."studentId"
       AND e."academicSessionId" = fo."academicSessionId"
      WHERE ${Prisma.join(conditions, " AND ")}
    ),
    confirmed_paid AS (
      SELECT os.id AS "obligationId", COALESCE(SUM(p."amountKobo"), 0) AS "paidKobo"
      FROM obligation_scope os
      LEFT JOIN "Payment" p ON p."feeObligationId" = os.id AND p.status = 'CONFIRMED'
      GROUP BY os.id
    ),
    student_outstanding AS (
      SELECT os."studentId", os."classId", SUM(os."amountDueKobo" - cp."paidKobo") AS "outstandingKobo"
      FROM obligation_scope os
      JOIN confirmed_paid cp ON cp."obligationId" = os.id
      GROUP BY os."studentId", os."classId"
    )
    SELECT
      s.id AS "studentId", s."firstName", s."lastName", s."admissionNumber",
      cls.id AS "classId", cls."gradeName", cls.arm,
      so."outstandingKobo"
    FROM student_outstanding so
    JOIN "Student" s ON s.id = so."studentId"
    JOIN "Class" cls ON cls.id = so."classId"
    WHERE so."outstandingKobo" > 0
    ORDER BY cls."order", s."lastName", s."firstName"
  `;

  return Promise.all(
    rows.map(async (row) => {
      const contact = await resolvePrimaryContactParent(row.studentId);
      return {
        studentId: row.studentId,
        studentName: `${row.firstName} ${row.lastName}`,
        admissionNumber: row.admissionNumber,
        class: { id: row.classId, name: `${row.gradeName}${row.arm ? ` ${row.arm}` : ""}` },
        outstandingKobo: toNumber(row.outstandingKobo),
        primaryContact: contact
          ? { name: `${contact.parent.firstName} ${contact.parent.lastName}`, phone: contact.parent.phone }
          : null,
      };
    }),
  );
}

/// expected/collected/outstanding per class — a deliberate subset of
/// getFeesSummary's own byClass buckets (dropping pending/waived/the three
/// status counts, which aren't this report's concern), not a second SQL
/// implementation of the same aggregate.
export async function getCollectionsReport(filter: ScopedReportQuery) {
  const summary = await getFeesSummary(filter);
  const byClass = summary.byClass ?? [];
  return byClass.map((c) => ({
    classId: c.classId,
    className: c.className,
    expectedKobo: c.expectedKobo,
    collectedKobo: c.collectedKobo,
    outstandingKobo: c.outstandingKobo,
  }));
}

/// Every payment in a date range, for reconciling against a bank
/// statement — bankReference is the join key. Unlike GET /api/payments
/// (the bursar's queue), this has no PENDING default and no pagination:
/// a reconciliation pass needs the whole range, not the work queue.
export function getPaymentHistoryReport(filter: PaymentHistoryQuery) {
  return prisma.payment.findMany({
    where: {
      status: filter.status,
      paymentDate: filter.from ?? filter.to ? { gte: filter.from, lte: filter.to } : undefined,
    },
    include: {
      feeObligation: {
        include: { student: { select: { firstName: true, lastName: true, admissionNumber: true } } },
      },
    },
    orderBy: { paymentDate: "asc" },
  });
}

export function paymentHistoryToCsv(rows: Awaited<ReturnType<typeof getPaymentHistoryReport>>): string {
  const header = "paymentDate,studentName,admissionNumber,amountKobo,status,bankReference,recordedByUserId";
  const lines = rows.map((p) => {
    const studentName = `${p.feeObligation.student.firstName} ${p.feeObligation.student.lastName}`;
    const cells = [
      p.paymentDate.toISOString(),
      studentName,
      p.feeObligation.student.admissionNumber,
      String(p.amountKobo),
      p.status,
      p.bankReference ?? "",
      p.recordedByUserId,
    ];
    // Minimal CSV escaping: only studentName/bankReference can plausibly
    // contain a comma or quote; everything else here is a controlled
    // value (an enum, a kobo integer, an ISO date, a cuid).
    return cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",");
  });
  return [header, ...lines].join("\n");
}

/// The dashboard figures plus payment counts by status, in a shape
/// suitable for showing the proprietor — reuses getFeesSummary's total
/// rather than recomputing the kobo buckets a second way.
export async function getTermSummaryReport(filter: ScopedReportQuery) {
  const [summary, paymentCounts] = await Promise.all([
    getFeesSummary(filter),
    prisma.$queryRaw<{ status: string; count: bigint | number | string }[]>`
      SELECT p.status, COUNT(*) AS count
      FROM "Payment" p
      JOIN "FeeObligation" fo ON fo.id = p."feeObligationId"
      WHERE 1=1
        ${filter.academicSessionId ? Prisma.sql`AND fo."academicSessionId" = ${filter.academicSessionId}` : Prisma.empty}
        ${filter.termId ? Prisma.sql`AND fo."termId" = ${filter.termId}` : Prisma.empty}
      GROUP BY p.status
    `,
  ]);

  const counts = { PENDING: 0, CONFIRMED: 0, REJECTED: 0 };
  for (const row of paymentCounts) {
    counts[row.status as keyof typeof counts] = toNumber(row.count);
  }

  return {
    ...summary.total,
    paymentCounts: {
      pendingCount: counts.PENDING,
      confirmedCount: counts.CONFIRMED,
      rejectedCount: counts.REJECTED,
    },
  };
}
