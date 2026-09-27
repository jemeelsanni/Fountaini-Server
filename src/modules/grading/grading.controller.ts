import type { Request, Response } from "express";
import * as service from "./grading.service.js";
import type {
  CreateAssessmentComponentBody,
  CreateGradeBandBody,
  CreateGradingScaleBody,
  IdParams,
  UpdateAssessmentComponentBody,
  UpdateGradeBandBody,
} from "./grading.schemas.js";

export async function createAssessmentComponent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const component = await service.createAssessmentComponent(id, req.body as CreateAssessmentComponentBody);
  res.status(201).json(component);
}

export async function listAssessmentComponents(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.listAssessmentComponents(id));
}

export async function updateAssessmentComponent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const component = await service.updateAssessmentComponent(id, req.body as UpdateAssessmentComponentBody);
  res.status(200).json(component);
}

export async function deleteAssessmentComponent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  await service.deleteAssessmentComponent(id);
  res.status(204).send();
}

export async function createGradingScale(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(201).json(await service.createGradingScale(id, req.body as CreateGradingScaleBody));
}

export async function getGradingScaleForSession(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getGradingScaleForSession(id));
}

export async function createGradeBand(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const band = await service.createGradeBand(id, req.body as CreateGradeBandBody);
  res.status(201).json(band);
}

export async function updateGradeBand(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const band = await service.updateGradeBand(id, req.body as UpdateGradeBandBody);
  res.status(200).json(band);
}

export async function deleteGradeBand(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  await service.deleteGradeBand(id);
  res.status(204).send();
}
