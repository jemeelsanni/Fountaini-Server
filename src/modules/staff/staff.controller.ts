import type { Request, Response } from "express";
import * as service from "./staff.service.js";
import type { CreateStaffBody, IdParams, UpdateStaffBody } from "./staff.schemas.js";

export async function createStaff(req: Request, res: Response): Promise<void> {
  const staff = await service.createStaff(req.body as CreateStaffBody);
  res.status(201).json(staff);
}

export async function listStaff(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listStaff());
}

export async function getStaff(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getStaffById(id));
}

export async function updateStaff(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.updateStaff(id, req.body as UpdateStaffBody));
}
