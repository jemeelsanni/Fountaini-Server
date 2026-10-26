import type { Request, Response } from "express";
import * as service from "./id-cards.service.js";
import type { IdParams, ListStudentIdCardsQuery } from "./id-cards.schemas.js";

export async function getStudentIdCard(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getStudentIdCard(id));
}

export async function listStudentIdCards(req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listStudentIdCards(req.validatedQuery as ListStudentIdCardsQuery));
}

export async function getStaffIdCard(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getStaffIdCard(id));
}

export async function listStaffIdCards(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listStaffIdCards());
}
