import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadPayment, canReadStudentFinancials } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./fees.controller.js";
import {
  createFeeStructureSchema,
  idParamsSchema,
  type IdParams,
  recordPaymentSchema,
  updateFeeObligationSchema,
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
feesRouter.patch(
  "/fee-obligations/:id",
  requireRole("ADMIN", "BURSAR"),
  validate({ params: idParamsSchema, body: updateFeeObligationSchema }),
  auditMutation("FeeObligation", "FEE_OBLIGATION_UPDATED"),
  controller.updateObligation,
);

feesRouter.post(
  "/fee-obligations/:id/payments",
  requireRole("BURSAR", "ADMIN"),
  validate({ params: idParamsSchema, body: recordPaymentSchema }),
  auditMutation("Payment", "PAYMENT_RECORDED"),
  controller.recordPayment,
);
feesRouter.post(
  "/payments/:id/confirm",
  requireRole("BURSAR", "ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Payment", "PAYMENT_CONFIRMED"),
  controller.confirmPayment,
);
feesRouter.post(
  "/payments/:id/reject",
  requireRole("BURSAR", "ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Payment", "PAYMENT_REJECTED"),
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
