import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { authRateLimiter, passwordResetRateLimiter } from "../../http/middleware/rateLimit.js";
import { validate } from "../../http/middleware/validate.js";
import * as authController from "./auth.controller.js";
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from "./auth.schemas.js";

export const authRouter = Router();

// login/refresh/logout/forgot-password/reset-password are the five
// genuinely public routes here — refresh and logout authenticate via the
// refresh token in the body, not an access token, so requireAuth doesn't
// apply to any of these either. All five are on the route-guard inventory
// test's public allowlist.
authRouter.post("/login", authRateLimiter, validate({ body: loginSchema }), authController.login);
authRouter.post("/refresh", validate({ body: refreshSchema }), authController.refresh);
authRouter.post("/logout", validate({ body: refreshSchema }), authController.logout);
authRouter.post(
  "/forgot-password",
  passwordResetRateLimiter,
  validate({ body: requestPasswordResetSchema }),
  authController.requestPasswordReset,
);
authRouter.post(
  "/reset-password",
  validate({ body: resetPasswordSchema }),
  authController.resetPassword,
);

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
