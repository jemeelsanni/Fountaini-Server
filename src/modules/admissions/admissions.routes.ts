import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { admissionEnquiryRateLimiter } from "../../http/middleware/rateLimit.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./admissions.controller.js";
import {
  convertEnquirySchema,
  createEnquirySchema,
  idParamsSchema,
  listEnquiriesQuerySchema,
  updateEnquirySchema,
} from "./admissions.schemas.js";

export const admissionsRouter = Router();

// Deliberately NOT `admissionsRouter.use(requireAuth, ...)`: this router
// shares the bare "/api" mount prefix with several others (app.ts), and
// Express's router.use() with no path matches EVERY request reaching that
// mount point — not just routes defined in this file. A blanket call here
// would either get shadowed by an earlier router's blanket requireAuth
// (blocking the public route below) or, if mounted first, leak its own
// requireRole("ADMIN") onto unrelated paths meant for other routers. Each
// protected route below applies requireAuth/requireRole itself instead.

// Public — the one genuinely unauthenticated write endpoint in the whole API.
admissionsRouter.post(
  "/admission-enquiries",
  admissionEnquiryRateLimiter,
  validate({ body: createEnquirySchema }),
  controller.createEnquiry,
);

admissionsRouter.get(
  "/admission-enquiries",
  requireAuth,
  requireRole("ADMIN"),
  validate({ query: listEnquiriesQuerySchema }),
  controller.listEnquiries,
);
admissionsRouter.get(
  "/admission-enquiries/:id",
  requireAuth,
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  controller.getEnquiry,
);
admissionsRouter.patch(
  "/admission-enquiries/:id",
  requireAuth,
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: updateEnquirySchema }),
  auditMutation("AdmissionEnquiry", "ENQUIRY_UPDATED"),
  controller.updateEnquiry,
);
admissionsRouter.post(
  "/admission-enquiries/:id/convert",
  requireAuth,
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: convertEnquirySchema }),
  auditMutation("AdmissionEnquiry", "ENQUIRY_CONVERTED"),
  controller.convertEnquiry,
);
