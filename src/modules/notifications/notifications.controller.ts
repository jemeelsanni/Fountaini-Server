import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./notifications.service.js";
import type { IdParams, ListDeliveriesQuery, TriggerFeeRemindersBody } from "./notifications.schemas.js";

export async function listMyNotifications(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  res.status(200).json(await service.listNotificationsForUser(req.principal.userId));
}

export async function markNotificationRead(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.markNotificationRead(id));
}

export async function markAllNotificationsRead(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  res.status(200).json(await service.markAllNotificationsRead(req.principal.userId));
}

export async function triggerFeeReminders(req: Request, res: Response): Promise<void> {
  const { academicSessionId } = req.body as TriggerFeeRemindersBody;
  res.status(200).json(await service.triggerFeeReminders(academicSessionId));
}

export async function listDeliveries(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as ListDeliveriesQuery;
  res.status(200).json(await service.listDeliveries(query));
}
