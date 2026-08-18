import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./notifications.controller.js";
import { triggerFeeRemindersSchema } from "./notifications.schemas.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get("/notifications", requireRole(...ALL_ROLES), controller.listMyNotifications);
notificationsRouter.post(
  "/notifications/fee-reminders/trigger",
  requireRole("ADMIN", "BURSAR"),
  validate({ body: triggerFeeRemindersSchema }),
  controller.triggerFeeReminders,
);
