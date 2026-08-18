import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./notifications.service.js";
import type { TriggerFeeRemindersBody } from "./notifications.schemas.js";

export async function listMyNotifications(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  res.status(200).json(await service.listNotificationsForUser(req.principal.userId));
}

export async function triggerFeeReminders(req: Request, res: Response): Promise<void> {
  const { academicSessionId } = req.body as TriggerFeeRemindersBody;
  res.status(200).json(await service.triggerFeeReminders(academicSessionId));
}
