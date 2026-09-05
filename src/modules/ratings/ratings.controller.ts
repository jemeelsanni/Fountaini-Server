import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./ratings.service.js";
import type { BulkUpsertRatingsBody, ClassTermParams, CreateTraitBody, IdParams } from "./ratings.schemas.js";

export async function createTrait(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const trait = await service.createTrait(id, req.body as CreateTraitBody);
  res.status(201).json(trait);
}

export async function listTraits(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.listTraits(id));
}

export async function listRatingScale(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listRatingScale());
}

export async function bulkUpsertRatings(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id, termId } = req.params as unknown as ClassTermParams;
  const ratings = await service.bulkUpsertRatings(
    id,
    termId,
    req.principal.userId,
    req.body as BulkUpsertRatingsBody,
  );
  res.status(200).json(ratings);
}
