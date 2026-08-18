import type { Request, Response } from "express";
import * as service from "./students.service.js";
import type {
  CreateEnrollmentBody,
  CreateStudentBody,
  IdParams,
  UpdateStudentBody,
} from "./students.schemas.js";

export async function createStudent(req: Request, res: Response): Promise<void> {
  const student = await service.createStudent(req.body as CreateStudentBody);
  res.status(201).json(student);
}

export async function listStudents(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listStudents());
}

export async function getStudent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getStudentById(id));
}

export async function updateStudent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.updateStudent(id, req.body as UpdateStudentBody));
}

export async function createEnrollment(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const enrollment = await service.createEnrollment(id, req.body as CreateEnrollmentBody);
  res.status(201).json(enrollment);
}

export async function listEnrollments(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.listEnrollmentsForStudent(id));
}
