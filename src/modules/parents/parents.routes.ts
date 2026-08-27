import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadParent } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./parents.controller.js";
import {
  createParentSchema,
  idParamsSchema,
  type IdParams,
  linkChildSchema,
  parentChildParamsSchema,
} from "./parents.schemas.js";

export const parentsRouter = Router();

parentsRouter.use(requireAuth);

// Must be registered before "/:id" or Express would match "me" as an :id param.
parentsRouter.get("/me/children", requireRole("PARENT"), controller.listMyChildren);

parentsRouter.post(
  "/",
  requireRole("ADMIN"),
  validate({ body: createParentSchema }),
  auditMutation("Parent", "PARENT_CREATED"),
  controller.createParent,
);
parentsRouter.get("/", requireRole("ADMIN"), controller.listParents);
parentsRouter.get(
  "/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  controller.getParent,
);
parentsRouter.get(
  "/:id/children",
  requireRole("ADMIN", "PARENT"),
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadParent(principal, (req.params as unknown as IdParams).id)),
  controller.listChildrenForParentId,
);
parentsRouter.post(
  "/:id/children",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: linkChildSchema }),
  auditMutation("StudentParent", "CHILD_LINKED"),
  controller.linkChild,
);
parentsRouter.delete(
  "/:id/children/:studentId",
  requireRole("ADMIN"),
  validate({ params: parentChildParamsSchema }),
  auditMutation("StudentParent", "CHILD_UNLINKED"),
  controller.unlinkChild,
);
