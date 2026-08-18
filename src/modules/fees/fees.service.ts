import { randomBytes } from "node:crypto";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { createNotification } from "../notifications/notifications.service.js";
import type {
  CreateFeeStructureBody,
  RecordPaymentBody,
  UpdateFeeObligationBody,
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

  const enrollments = await prisma.enrollment.findMany({
    where: {
      academicSessionId: feeStructure.academicSessionId,
      status: "ACTIVE",
      classId: feeStructure.classId ?? undefined,
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
    });
  }

  return prisma.feeObligation.findMany({ where: { feeStructureId, studentId: { in: studentIds } } });
}

function withBalance<T extends { amountDueKobo: number; payments: { amountKobo: number }[] }>(obligation: T) {
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

export async function updateObligation(id: string, input: UpdateFeeObligationBody) {
  const obligation = await prisma.feeObligation.findUnique({ where: { id } });
  if (!obligation) {
    throw AppError.notFound("Fee obligation not found");
  }

  return prisma.feeObligation.update({ where: { id }, data: input });
}

async function recomputeObligationStatus(feeObligationId: string) {
  const obligation = await prisma.feeObligation.findUniqueOrThrow({ where: { id: feeObligationId } });
  if (obligation.status === "WAIVED") {
    return;
  }

  const confirmedPayments = await prisma.payment.findMany({
    where: { feeObligationId, status: "CONFIRMED" },
  });
  const totalPaidKobo = confirmedPayments.reduce((sum, p) => sum + p.amountKobo, 0);

  const status = totalPaidKobo <= 0 ? "PENDING" : totalPaidKobo >= obligation.amountDueKobo ? "PAID" : "PARTIALLY_PAID";

  await prisma.feeObligation.update({ where: { id: feeObligationId }, data: { status } });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function recordPayment(feeObligationId: string, actorUserId: string, input: RecordPaymentBody) {
  const obligation = await prisma.feeObligation.findUnique({ where: { id: feeObligationId } });
  if (!obligation) {
    throw AppError.notFound("Fee obligation not found");
  }

  return prisma.payment.create({
    data: {
      feeObligationId,
      amountKobo: input.amountKobo,
      bankReference: input.bankReference,
      paymentDate: input.paymentDate,
      notes: input.notes,
      recordedByUserId: actorUserId,
    },
  });
}

function generateReceiptNumber(): string {
  return `RCPT-${Date.now()}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function confirmPayment(id: string, actorUserId: string) {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) {
    throw AppError.notFound("Payment not found");
  }
  if (payment.status !== "PENDING") {
    throw AppError.conflict(`This payment has already been ${payment.status.toLowerCase()}`);
  }

  const [updated] = await prisma.$transaction([
    prisma.payment.update({
      where: { id },
      data: { status: "CONFIRMED", confirmedByUserId: actorUserId, confirmedAt: new Date() },
    }),
    prisma.receipt.create({
      data: { paymentId: id, receiptNumber: generateReceiptNumber(), issuedByUserId: actorUserId },
    }),
  ]);

  await recomputeObligationStatus(payment.feeObligationId);
  await notifyPaymentConfirmed(id);
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
  if (payment.status !== "PENDING") {
    throw AppError.conflict(`This payment has already been ${payment.status.toLowerCase()}`);
  }

  const updated = await prisma.payment.update({
    where: { id },
    data: { status: "REJECTED", confirmedByUserId: actorUserId, confirmedAt: new Date() },
  });
  await recomputeObligationStatus(payment.feeObligationId);
  return updated;
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
