import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./results.service.js";
import type {
  ClassTermParams,
  ComputeResultsBody,
  IdParams,
  OverrideResultBody,
  StudentTermParams,
} from "./results.schemas.js";

export async function computeResults(req: Request, res: Response): Promise<void> {
  const results = await service.computeResultsForClass(req.body as ComputeResultsBody);
  res.status(200).json(results);
}

export async function getResultForStudentTerm(req: Request, res: Response): Promise<void> {
  const { studentId, termId } = req.params as unknown as StudentTermParams;
  res.status(200).json(await service.getResultForStudentTerm(studentId, termId));
}

export async function listResultsForClass(req: Request, res: Response): Promise<void> {
  const { id, termId } = req.params as unknown as ClassTermParams;
  res.status(200).json(await service.listResultsForClass(id, termId));
}

export async function finalizeResult(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.finalizeResult(id, req.principal.userId));
}

export async function overrideResult(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  const updated = await service.overrideResult(id, req.principal.userId, req.body as OverrideResultBody);
  res.status(200).json(updated);
}
