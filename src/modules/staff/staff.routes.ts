import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadStaff } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./staff.controller.js";
import { createStaffSchema, idParamsSchema, type IdParams, updateStaffSchema } from "./staff.schemas.js";

export const staffRouter = Router();

staffRouter.use(requireAuth);

staffRouter.post(
  "/",
  requireRole("ADMIN"),
  validate({ body: createStaffSchema }),
  auditMutation("Staff", "STAFF_CREATED"),
  controller.createStaff,
);
staffRouter.get("/", requireRole("ADMIN"), controller.listStaff);
staffRouter.get(
  "/:id",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadStaff(principal, (req.params as unknown as IdParams).id)),
  controller.getStaff,
);
staffRouter.patch(
  "/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: updateStaffSchema }),
  auditMutation("Staff", "STAFF_UPDATED"),
  controller.updateStaff,
);
