import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadStudent } from "../../authorization/scopeResolvers.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./madrassah.controller.js";
import { createProgressSchema, idParamsSchema, type IdParams } from "./madrassah.schemas.js";

export const madrassahRouter = Router();

madrassahRouter.use(requireAuth);

madrassahRouter.post(
  "/madrassah-progress",
  requireRole("TEACHER"),
  validate({ body: createProgressSchema }),
  controller.createProgress,
);
madrassahRouter.get(
  "/students/:id/madrassah-progress",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadStudent(principal, (req.params as unknown as IdParams).id)),
  controller.listProgressForStudent,
);
madrassahRouter.get("/surahs", requireRole(...ALL_ROLES), controller.listSurahs);
