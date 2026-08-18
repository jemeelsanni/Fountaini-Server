import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./fees.service.js";
import type {
  CreateFeeStructureBody,
  IdParams,
  RecordPaymentBody,
  UpdateFeeObligationBody,
} from "./fees.schemas.js";

export async function createFeeStructure(req: Request, res: Response): Promise<void> {
  const structure = await service.createFeeStructure(req.body as CreateFeeStructureBody);
  res.status(201).json(structure);
}

export async function listFeeStructures(req: Request, res: Response): Promise<void> {
  const academicSessionId =
    typeof req.query.academicSessionId === "string" ? req.query.academicSessionId : undefined;
  res.status(200).json(await service.listFeeStructures({ academicSessionId }));
}

export async function generateObligations(req: Request, res: Response): Promise<void> {
  if (!req.principal) throw AppError.unauthorized();
  const { id } = req.params as unknown as IdParams;
  res.status(201).json(await service.generateObligations(id, req.principal.userId));
}

export async function listObligationsForStudent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.listObligationsForStudent(id));
}

export async function updateObligation(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.updateObligation(id, req.body as UpdateFeeObligationBody));
}

export async function recordPayment(req: Request, res: Response): Promise<void> {
  if (!req.principal) throw AppError.unauthorized();
  const { id } = req.params as unknown as IdParams;
  const payment = await service.recordPayment(id, req.principal.userId, req.body as RecordPaymentBody);
  res.status(201).json(payment);
}

export async function confirmPayment(req: Request, res: Response): Promise<void> {
  if (!req.principal) throw AppError.unauthorized();
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.confirmPayment(id, req.principal.userId));
}

export async function rejectPayment(req: Request, res: Response): Promise<void> {
  if (!req.principal) throw AppError.unauthorized();
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.rejectPayment(id, req.principal.userId));
}

export async function listPaymentsForStudent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.listPaymentsForStudent(id));
}

export async function getReceiptForPayment(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getReceiptForPayment(id));
}
