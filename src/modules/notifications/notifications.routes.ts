import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canManageOwnNotification } from "../../authorization/scopeResolvers.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./notifications.controller.js";
import {
  idParamsSchema,
  type IdParams,
  listDeliveriesQuerySchema,
  triggerFeeRemindersSchema,
} from "./notifications.schemas.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get("/notifications", requireRole(...ALL_ROLES), controller.listMyNotifications);
// Registered before anything that could ambiguously read "deliveries" as a
// path segment of another route — it doesn't today (no GET /notifications/:id
// exists), but this ordering is the same defensive habit as every other
// static-before-:id registration in this codebase. ADMIN-only and
// deliberately never selects NotificationEvent.body (see listDeliveries's
// own comment, notifications.service.ts) — this is the cross-user,
// admin-facing counterpart to the self-scoped GET /notifications above.
notificationsRouter.get(
  "/notifications/deliveries",
  requireRole("ADMIN"),
  validate({ query: listDeliveriesQuerySchema }),
  controller.listDeliveries,
);
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
