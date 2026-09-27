import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { prisma } from "../../db/client.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as usersController from "./users.controller.js";
import { createUserSchema, userIdParamsSchema } from "./users.schemas.js";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireRole("ADMIN"));

usersRouter.post(
  "/",
  validate({ body: createUserSchema }),
  auditMutation("User", "USER_CREATED"),
  usersController.createUser,
);
usersRouter.get("/", usersController.listUsers);
usersRouter.get("/:id", validate({ params: userIdParamsSchema }), usersController.getUser);
// fetchBefore reads the FULL, unprojected User row (unlike userListSelect,
// which every response in this module goes through) — passwordHash is in
// REDACTED_RESPONSE_FIELDS specifically so this doesn't put a hash into
// beforeData that afterData would never have carried.
const fetchUserBefore = (id: string) => prisma.user.findUnique({ where: { id } });

usersRouter.post(
  "/:id/activate",
  validate({ params: userIdParamsSchema }),
  auditMutation("User", "USER_ACTIVATED", { fetchBefore: fetchUserBefore }),
  usersController.activateUser,
);
usersRouter.post(
  "/:id/deactivate",
  validate({ params: userIdParamsSchema }),
  auditMutation("User", "USER_DEACTIVATED", { fetchBefore: fetchUserBefore }),
  usersController.deactivateUser,
);
