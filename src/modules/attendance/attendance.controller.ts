import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./attendance.service.js";
import type {
  ClassAttendanceQuery,
  CorrectAttendanceBody,
  IdParams,
  OpenSessionBody,
  ScanBody,
} from "./attendance.schemas.js";

export async function openSession(req: Request, res: Response): Promise<void> {
  if (!req.principal) throw AppError.unauthorized();
  const session = await service.openSession(req.principal.userId, req.body as OpenSessionBody);
  res.status(201).json(session);
}

export async function scan(req: Request, res: Response): Promise<void> {
  if (!req.principal) throw AppError.unauthorized();
  const { id } = req.params as unknown as IdParams;
  const { record, alreadyMarked } = await service.scan(id, req.principal.userId, req.body as ScanBody);
  res.status(alreadyMarked ? 200 : 201).json({ record, alreadyMarked });
}

export async function closeSession(req: Request, res: Response): Promise<void> {
  if (!req.principal) throw AppError.unauthorized();
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.closeSession(id, req.principal.userId));
}

export async function correctRecord(req: Request, res: Response): Promise<void> {
  if (!req.principal) throw AppError.unauthorized();
  const { id } = req.params as unknown as IdParams;
  const record = await service.correctRecord(id, req.principal.userId, req.body as CorrectAttendanceBody);
  res.status(200).json(record);
}

export async function getAttendanceForStudent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getAttendanceForStudent(id));
}

export async function getAttendanceForClass(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const { date } = req.query as unknown as ClassAttendanceQuery;
  res.status(200).json(await service.getAttendanceForClass(id, date));
}

export async function rotateQrCode(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(201).json(await service.rotateQrCode(id));
}

export async function getActiveQrCode(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getActiveQrCode(id));
}
