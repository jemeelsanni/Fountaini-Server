import type { Request, Response } from "express";
import * as service from "./academic-structure.service.js";
import type {
  CreateAcademicSessionBody,
  CreateClassBody,
  CreateClassFormTeacherBody,
  CreateClassSubjectAssignmentBody,
  CreateSubjectBody,
  CreateTermBody,
  IdParams,
} from "./academic-structure.schemas.js";

export async function createAcademicSession(req: Request, res: Response): Promise<void> {
  const session = await service.createAcademicSession(req.body as CreateAcademicSessionBody);
  res.status(201).json(session);
}

export async function listAcademicSessions(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listAcademicSessions());
}

export async function setCurrentAcademicSession(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.setCurrentAcademicSession(id));
}

export async function createTerm(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const term = await service.createTerm(id, req.body as CreateTermBody);
  res.status(201).json(term);
}

export async function listTermsForSession(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.listTermsForSession(id));
}

export async function setCurrentTerm(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.setCurrentTerm(id));
}

export async function createClass(req: Request, res: Response): Promise<void> {
  const klass = await service.createClass(req.body as CreateClassBody);
  res.status(201).json(klass);
}

export async function listClasses(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listClasses());
}

export async function createSubject(req: Request, res: Response): Promise<void> {
  const subject = await service.createSubject(req.body as CreateSubjectBody);
  res.status(201).json(subject);
}

export async function listSubjects(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listSubjects());
}

export async function createClassSubjectAssignment(req: Request, res: Response): Promise<void> {
  const assignment = await service.createClassSubjectAssignment(
    req.body as CreateClassSubjectAssignmentBody,
  );
  res.status(201).json(assignment);
}

export async function listClassSubjectAssignments(req: Request, res: Response): Promise<void> {
  const queryTeacherId = typeof req.query.teacherId === "string" ? req.query.teacherId : undefined;
  const classId = typeof req.query.classId === "string" ? req.query.classId : undefined;

  // Teachers can only ever list their own assignments — the query param is
  // ignored for them rather than honored, so there's no "pass someone else's
  // staffId" path to guard against.
  const teacherId =
    req.principal?.roles.has("TEACHER") ? (req.principal.staffId ?? undefined) : queryTeacherId;

  res.status(200).json(await service.listClassSubjectAssignments({ teacherId, classId }));
}

export async function deleteClassSubjectAssignment(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  await service.deleteClassSubjectAssignment(id);
  res.status(204).send();
}

export async function createClassFormTeacher(req: Request, res: Response): Promise<void> {
  const assignment = await service.createClassFormTeacher(req.body as CreateClassFormTeacherBody);
  res.status(201).json(assignment);
}

export async function listClassFormTeachers(req: Request, res: Response): Promise<void> {
  const queryTeacherId = typeof req.query.teacherId === "string" ? req.query.teacherId : undefined;
  const classId = typeof req.query.classId === "string" ? req.query.classId : undefined;

  const teacherId =
    req.principal?.roles.has("TEACHER") ? (req.principal.staffId ?? undefined) : queryTeacherId;

  res.status(200).json(await service.listClassFormTeachers({ teacherId, classId }));
}

export async function deleteClassFormTeacher(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  await service.deleteClassFormTeacher(id);
  res.status(204).send();
}
