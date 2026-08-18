import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { validate } from "../../http/middleware/validate.js";
import * as authController from "./auth.controller.js";
import { changePasswordSchema, loginSchema, refreshSchema } from "./auth.schemas.js";

export const authRouter = Router();

// login/refresh/logout are the three genuinely public routes here — refresh
// and logout authenticate via the refresh token in the body, not an access
// token, so requireAuth doesn't apply to them either. All three are on the
// route-guard inventory test's public allowlist.
authRouter.post("/login", validate({ body: loginSchema }), authController.login);
authRouter.post("/refresh", validate({ body: refreshSchema }), authController.refresh);
authRouter.post("/logout", validate({ body: refreshSchema }), authController.logout);

// "Who am I" / "change my own password" are inherently self-only — every
// authenticated role must be able to call these, so that's stated explicitly
// rather than left as an implicit gap.
authRouter.get("/me", requireAuth, requireRole(...ALL_ROLES), authController.me);
authRouter.post(
  "/change-password",
  requireAuth,
  requireRole(...ALL_ROLES),
  validate({ body: changePasswordSchema }),
  authController.changePassword,
);
