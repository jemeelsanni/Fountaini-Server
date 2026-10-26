import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./id-cards.controller.js";
import { idParamsSchema, listStudentIdCardsQuerySchema } from "./id-cards.schemas.js";

export const idCardsRouter = Router();

idCardsRouter.use(requireAuth);

// ADMIN only: the school office prints ID cards. Read-only — nothing here
// issues or rotates a QR code (see id-cards.service.ts's top comment).
idCardsRouter.get(
  "/students",
  requireRole("ADMIN"),
  validate({ query: listStudentIdCardsQuerySchema }),
  controller.listStudentIdCards,
);
idCardsRouter.get(
  "/students/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  controller.getStudentIdCard,
);
idCardsRouter.get("/staff", requireRole("ADMIN"), controller.listStaffIdCards);
idCardsRouter.get("/staff/:id", requireRole("ADMIN"), validate({ params: idParamsSchema }), controller.getStaffIdCard);
