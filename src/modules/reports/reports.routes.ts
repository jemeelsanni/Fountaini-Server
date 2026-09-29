import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./reports.controller.js";
import { paymentHistoryQuerySchema, scopedReportQuerySchema } from "./reports.schemas.js";

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireRole("ADMIN", "BURSAR"));

reportsRouter.get(
  "/defaulters",
  validate({ query: scopedReportQuerySchema }),
  controller.getDefaultersReport,
);
reportsRouter.get(
  "/collections",
  validate({ query: scopedReportQuerySchema }),
  controller.getCollectionsReport,
);
reportsRouter.get(
  "/payments",
  validate({ query: paymentHistoryQuerySchema }),
  controller.getPaymentHistoryReport,
);
reportsRouter.get(
  "/term-summary",
  validate({ query: scopedReportQuerySchema }),
  controller.getTermSummaryReport,
);
