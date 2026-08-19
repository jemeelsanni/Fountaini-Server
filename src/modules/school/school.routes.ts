import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./school.controller.js";
import { createSchoolSchema, updateSchoolSchema } from "./school.schemas.js";

export const schoolRouter = Router();

// Admin-only, every route — school-wide identity/contact info, not
// something any authenticated role needs read access to just to do their
// own job (unlike e.g. GET /api/classes).
schoolRouter.use(requireAuth, requireRole("ADMIN"));

schoolRouter.get("/", controller.getSchool);
schoolRouter.post(
  "/",
  validate({ body: createSchoolSchema }),
  auditMutation("School", "SCHOOL_CREATED"),
  controller.createSchool,
);
schoolRouter.patch(
  "/",
  validate({ body: updateSchoolSchema }),
  auditMutation("School", "SCHOOL_UPDATED"),
  controller.updateSchool,
);
