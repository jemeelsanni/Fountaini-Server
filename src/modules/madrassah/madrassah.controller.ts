import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./madrassah.service.js";
import type { CreateProgressBody, IdParams } from "./madrassah.schemas.js";

export async function createProgress(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  if (!req.principal.staffId) {
    throw AppError.badRequest("Your account has no staff profile yet — ask an admin to create one first");
  }
  const progress = await service.createProgress(req.principal.staffId, req.body as CreateProgressBody);
  res.status(201).json(progress);
}

export async function listProgressForStudent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.listProgressForStudent(id));
}

export async function listSurahs(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listSurahs());
}
