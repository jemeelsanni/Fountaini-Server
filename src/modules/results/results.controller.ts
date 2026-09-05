import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./results.service.js";
import type {
  ClassTermParams,
  ComputeResultsBody,
  ComputeSessionResultsBody,
  IdParams,
  ListResultsForStudentQuery,
  OverrideResultBody,
  ReleaseWithholdingBody,
  StudentSessionParams,
  StudentTermParams,
  WriteCommentBody,
} from "./results.schemas.js";

export async function computeResults(req: Request, res: Response): Promise<void> {
  const results = await service.computeResultsForClass(req.body as ComputeResultsBody);
  res.status(200).json(results);
}

export async function getResultForStudentTerm(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { studentId, termId } = req.params as unknown as StudentTermParams;
  res.status(200).json(await service.getResultForStudentTerm(studentId, termId, req.principal));
}

export async function listResultsForStudent(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  const { academicSessionId } = req.query as unknown as ListResultsForStudentQuery;
  res.status(200).json(await service.listResultsForStudent(id, academicSessionId, req.principal));
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

export async function rankClassResults(req: Request, res: Response): Promise<void> {
  const { id, termId } = req.params as unknown as ClassTermParams;
  res.status(200).json(await service.rankClassResults(id, termId));
}

export async function releaseWithholding(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  const { reason } = req.body as ReleaseWithholdingBody;
  res.status(200).json(await service.releaseWithholding(id, req.principal.userId, reason));
}

export async function computeSessionResults(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const results = await service.computeSessionResultsForClass(
    req.body as ComputeSessionResultsBody,
    req.principal.userId,
  );
  res.status(200).json(results);
}

export async function getSessionResultForStudent(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { studentId, academicSessionId } = req.params as unknown as StudentSessionParams;
  res.status(200).json(await service.getSessionResultForStudent(studentId, academicSessionId, req.principal));
}

export async function overrideResult(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  const updated = await service.overrideResult(id, req.principal.userId, req.body as OverrideResultBody);
  res.status(200).json(updated);
}

export async function writeClassTeacherComment(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const { comment } = req.body as WriteCommentBody;
  res.status(200).json(await service.writeClassTeacherComment(id, comment));
}

export async function writePrincipalComment(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const { comment } = req.body as WriteCommentBody;
  res.status(200).json(await service.writePrincipalComment(id, comment));
}
