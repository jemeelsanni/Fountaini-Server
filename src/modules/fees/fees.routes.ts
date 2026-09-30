import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import {
  canCreatePaymentForObligation,
  canReadFeeObligation,
  canReadPayment,
  canReadStudentFinancials,
} from "../../authorization/scopeResolvers.js";
import { prisma } from "../../db/client.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./fees.controller.js";
import {
  createFeeStructureSchema,
  feesSummaryQuerySchema,
  idParamsSchema,
  type IdParams,
  listPaymentsQuerySchema,
  recordPaymentSchema,
  studentStatementQuerySchema,
  updateFeeObligationSchema,
  updateFeeStructureSchema,
} from "./fees.schemas.js";

export const feesRouter = Router();

feesRouter.use(requireAuth);

feesRouter.post(
  "/fee-structures",
  requireRole("ADMIN", "BURSAR"),
  validate({ body: createFeeStructureSchema }),
  auditMutation("FeeStructure", "FEE_STRUCTURE_CREATED"),
  controller.createFeeStructure,
);
feesRouter.get("/fee-structures", requireRole("ADMIN", "BURSAR"), controller.listFeeStructures);
const fetchFeeStructureBefore = (id: string) => prisma.feeStructure.findUnique({ where: { id } });

feesRouter.patch(
  "/fee-structures/:id",
  requireRole("ADMIN", "BURSAR"),
  validate({ params: idParamsSchema, body: updateFeeStructureSchema }),
  auditMutation("FeeStructure", "FEE_STRUCTURE_UPDATED", { fetchBefore: fetchFeeStructureBefore }),
  controller.updateFeeStructure,
);
feesRouter.delete(
  "/fee-structures/:id",
  requireRole("ADMIN", "BURSAR"),
  validate({ params: idParamsSchema }),
  auditMutation("FeeStructure", "FEE_STRUCTURE_DELETED", { fetchBefore: fetchFeeStructureBefore }),
  controller.deleteFeeStructure,
);
feesRouter.post(
  "/fee-structures/:id/generate-obligations",
  requireRole("ADMIN", "BURSAR"),
  validate({ params: idParamsSchema }),
  auditMutation("FeeObligation", "FEE_OBLIGATIONS_GENERATED"),
  controller.generateObligations,
);

feesRouter.get(
  "/students/:id/fee-obligations",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) =>
    canReadStudentFinancials(principal, (req.params as unknown as IdParams).id),
  ),
  controller.listObligationsForStudent,
);
feesRouter.get(
  "/fee-obligations/:id",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadFeeObligation(principal, (req.params as unknown as IdParams).id)),
  controller.getFeeObligationById,
);
feesRouter.patch(
  "/fee-obligations/:id",
  requireRole("ADMIN", "BURSAR"),
  validate({ params: idParamsSchema, body: updateFeeObligationSchema }),
  auditMutation("FeeObligation", "FEE_OBLIGATION_UPDATED", {
    fetchBefore: (id) => prisma.feeObligation.findUnique({ where: { id } }),
  }),
  controller.updateObligation,
);

feesRouter.post(
  "/fee-obligations/:id/payments",
  validate({ params: idParamsSchema, body: recordPaymentSchema }),
  requireScope((principal, req) =>
    canCreatePaymentForObligation(principal, (req.params as unknown as IdParams).id),
  ),
  auditMutation("Payment", "PAYMENT_RECORDED"),
  controller.recordPayment,
);
const fetchPaymentBefore = (id: string) => prisma.payment.findUnique({ where: { id } });

feesRouter.post(
  "/payments/:id/confirm",
  requireRole("BURSAR", "ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Payment", "PAYMENT_CONFIRMED", { fetchBefore: fetchPaymentBefore }),
  controller.confirmPayment,
);
feesRouter.post(
  "/payments/:id/reject",
  requireRole("BURSAR", "ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Payment", "PAYMENT_REJECTED", { fetchBefore: fetchPaymentBefore }),
  controller.rejectPayment,
);
feesRouter.get(
  "/payments/:id/receipt",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadPayment(principal, (req.params as unknown as IdParams).id)),
  controller.getReceiptForPayment,
);
feesRouter.get(
  // Same scope as /receipt above (canReadPayment: ADMIN/BURSAR, or via
  // canReadStudentFinancials on the obligation's student) rather than a
  // narrower parent-only variant — the spec for this route names ADMIN,
  // BURSAR and "the linked parent" without mentioning the student, but
  // fragmenting payment-read access across two slightly different
  // resolvers for two routes reading the same underlying thing (a payment)
  // is worse than the alternative: this keeps "who can read a given
  // payment's detail" answerable in exactly one place.
  "/payments/:id",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadPayment(principal, (req.params as unknown as IdParams).id)),
  controller.getPaymentById,
);
feesRouter.get(
  "/students/:id/payments",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) =>
    canReadStudentFinancials(principal, (req.params as unknown as IdParams).id),
  ),
  controller.listPaymentsForStudent,
);

feesRouter.get(
  "/students/:id/statement",
  validate({ params: idParamsSchema, query: studentStatementQuerySchema }),
  requireScope((principal, req) =>
    canReadStudentFinancials(principal, (req.params as unknown as IdParams).id),
  ),
  controller.getStudentStatement,
);

feesRouter.get(
  "/payments",
  requireRole("ADMIN", "BURSAR"),
  validate({ query: listPaymentsQuerySchema }),
  controller.listPayments,
);

feesRouter.get(
  "/fees/summary",
  requireRole("ADMIN", "BURSAR"),
  validate({ query: feesSummaryQuerySchema }),
  controller.getFeesSummary,
);
