import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./scores.service.js";
import type { BulkUpsertScoresBody, IdParams, SubmitScoresBody } from "./scores.schemas.js";

export async function getRoster(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getRoster(id));
}

export async function bulkUpsertScores(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  const scores = await service.bulkUpsertScores(id, req.principal.userId, req.body as BulkUpsertScoresBody);
  res.status(200).json(scores);
}

export async function submitScores(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  const { termId } = req.body as SubmitScoresBody;
  const results = await service.submitScores(id, req.principal.userId, termId);
  res.status(200).json(results);
}

export async function getScoresForStudent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getScoresForStudent(id));
}
