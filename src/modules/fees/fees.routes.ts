import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import {
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
  idParamsSchema,
  type IdParams,
  recordPaymentSchema,
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
  requireRole("BURSAR", "ADMIN"),
  validate({ params: idParamsSchema, body: recordPaymentSchema }),
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
  "/students/:id/payments",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) =>
    canReadStudentFinancials(principal, (req.params as unknown as IdParams).id),
  ),
  controller.listPaymentsForStudent,
);
