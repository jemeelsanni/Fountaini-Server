import type { Request, Response } from "express";
import * as service from "./timetable.service.js";
import type { CreateTimeSlotBody, CreateTimetableEntryBody, IdParams } from "./timetable.schemas.js";

export async function createTimeSlot(req: Request, res: Response): Promise<void> {
  const slot = await service.createTimeSlot(req.body as CreateTimeSlotBody);
  res.status(201).json(slot);
}

export async function listTimeSlots(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listTimeSlots());
}

export async function createTimetableEntry(req: Request, res: Response): Promise<void> {
  const entry = await service.createTimetableEntry(req.body as CreateTimetableEntryBody);
  res.status(201).json(entry);
}

export async function deleteTimetableEntry(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  await service.deleteTimetableEntry(id);
  res.status(204).send();
}

export async function getTimetableForClass(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getTimetableForClass(id));
}

export async function getTimetableForTeacher(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getTimetableForTeacher(id));
}
