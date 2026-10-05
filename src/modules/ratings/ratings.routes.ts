import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canWriteClassRatings } from "../../authorization/scopeResolvers.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./ratings.controller.js";
import {
  bulkUpsertRatingsSchema,
  type ClassTermParams,
  classTermParamsSchema,
  createTraitSchema,
  idParamsSchema,
  updateTraitSchema,
} from "./ratings.schemas.js";

export const ratingsRouter = Router();

ratingsRouter.use(requireAuth);

ratingsRouter.post(
  "/academic-sessions/:id/traits",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: createTraitSchema }),
  auditMutation("Trait", "TRAIT_CREATED"),
  controller.createTrait,
);
ratingsRouter.get(
  "/academic-sessions/:id/traits",
  requireRole(...ALL_ROLES),
  validate({ params: idParamsSchema }),
  controller.listTraits,
);
// Mirrors grading.routes.ts's PATCH /assessment-components/:id — "deactivate"
// rather than DELETE, since a Rating references its trait by FK and can't
// be orphaned (see Trait.isActive's own comment, schema.prisma).
ratingsRouter.patch(
  "/traits/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: updateTraitSchema }),
  auditMutation("Trait", "TRAIT_UPDATED"),
  controller.updateTrait,
);
ratingsRouter.post(
  "/traits/:id/deactivate",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Trait", "TRAIT_DEACTIVATED"),
  controller.deactivateTrait,
);
ratingsRouter.get("/rating-scale", requireRole(...ALL_ROLES), controller.listRatingScale);

ratingsRouter.put(
  "/classes/:id/results/:termId/ratings",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: classTermParamsSchema, body: bulkUpsertRatingsSchema }),
  requireScope((principal, req) => {
    const { id, termId } = req.params as unknown as ClassTermParams;
    return canWriteClassRatings(principal, id, termId);
  }),
  auditMutation("Rating", "RATINGS_WRITTEN"),
  controller.bulkUpsertRatings,
);
