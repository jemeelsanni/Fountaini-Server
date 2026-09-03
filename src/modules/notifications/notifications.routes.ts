import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canManageOwnNotification } from "../../authorization/scopeResolvers.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./notifications.controller.js";
import { idParamsSchema, type IdParams, triggerFeeRemindersSchema } from "./notifications.schemas.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get("/notifications", requireRole(...ALL_ROLES), controller.listMyNotifications);
notificationsRouter.patch(
  "/notifications/:id/read",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canManageOwnNotification(principal, (req.params as unknown as IdParams).id)),
  controller.markNotificationRead,
);
notificationsRouter.post(
  "/notifications/read-all",
  requireRole(...ALL_ROLES),
  controller.markAllNotificationsRead,
);
notificationsRouter.post(
  "/notifications/fee-reminders/trigger",
  requireRole("ADMIN", "BURSAR"),
  validate({ body: triggerFeeRemindersSchema }),
  controller.triggerFeeReminders,
);
