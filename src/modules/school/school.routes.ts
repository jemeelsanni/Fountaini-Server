import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./school.controller.js";
import { createSchoolSchema, updateSchoolSchema } from "./school.schemas.js";

export const schoolRouter = Router();

schoolRouter.use(requireAuth);

// Every authenticated role, not just ADMIN — the response is the school's
// own name/address/contact info plus createdAt/updatedAt/
// currentAcademicSessionId (an internal FK nothing else in this codebase
// reads — see school.schemas.ts's own comment). None of that is anything a
// parent or student shouldn't see, so there's no need for a separate
// public projection here.
schoolRouter.get("/", requireRole(...ALL_ROLES), controller.getSchool);
schoolRouter.post(
  "/",
  requireRole("ADMIN"),
  validate({ body: createSchoolSchema }),
  auditMutation("School", "SCHOOL_CREATED"),
  controller.createSchool,
);
schoolRouter.patch(
  "/",
  requireRole("ADMIN"),
  validate({ body: updateSchoolSchema }),
  auditMutation("School", "SCHOOL_UPDATED"),
  controller.updateSchool,
);
