import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
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
usersRouter.post(
  "/:id/activate",
  validate({ params: userIdParamsSchema }),
  auditMutation("User", "USER_ACTIVATED"),
  usersController.activateUser,
);
usersRouter.post(
  "/:id/deactivate",
  validate({ params: userIdParamsSchema }),
  auditMutation("User", "USER_DEACTIVATED"),
  usersController.deactivateUser,
);
