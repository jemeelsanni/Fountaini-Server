import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { prisma } from "../../db/client.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as usersController from "./users.controller.js";
import { createUserSchema, updateUserEmailSchema, userIdParamsSchema } from "./users.schemas.js";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireRole("ADMIN"));

usersRouter.post(
  "/",
  validate({ body: createUserSchema }),
  auditMutation("User", "USER_CREATED"),
  usersController.createUser,
);
usersRouter.get("/", usersController.listUsers);
// Registered before "/:id" or Express would match "pending-activation" as
// :id. The onboarding chase list — see listPendingActivation's own comment
// (users.service.ts).
usersRouter.get("/pending-activation", usersController.pendingActivation);
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
// Generalizes POST /api/students/:id/reissue-credentials (which now
// delegates to the same service function, reissueCredentialsForUser) to
// any account — staff, parent, or student. temporaryPassword, on the rare
// student-with-nowhere-to-deliver response, is kept out of both the
// response's own afterData and beforeData's old passwordHash by
// REDACTED_RESPONSE_FIELDS (auditMutation.ts), same as every other
// credential-bearing response in this codebase.
usersRouter.post(
  "/:id/reissue-credentials",
  validate({ params: userIdParamsSchema }),
  auditMutation("User", "USER_CREDENTIALS_REISSUED", { fetchBefore: fetchUserBefore }),
  usersController.reissueCredentials,
);
// Treated as exactly as sensitive as reissue-credentials above (see
// updateUserEmail's own comment, users.service.ts) — same fetchBefore, same
// audit action family, same REDACTED_RESPONSE_FIELDS protection for the
// rare temporaryPassword-in-response case.
usersRouter.patch(
  "/:id/email",
  validate({ params: userIdParamsSchema, body: updateUserEmailSchema }),
  auditMutation("User", "USER_EMAIL_CHANGED", { fetchBefore: fetchUserBefore }),
  usersController.updateEmail,
);
