import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./admissions.service.js";
import type {
  ConvertEnquiryBody,
  CreateEnquiryBody,
  IdParams,
  ListEnquiriesQuery,
  UpdateEnquiryBody,
} from "./admissions.schemas.js";

export async function createEnquiry(req: Request, res: Response): Promise<void> {
  const enquiry = await service.createEnquiry(req.body as CreateEnquiryBody);
  res.status(201).json(enquiry);
}

export async function listEnquiries(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListEnquiriesQuery;
  res.status(200).json(await service.listEnquiries(query));
}

export async function getEnquiry(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getEnquiryById(id));
}

export async function updateEnquiry(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  const enquiry = await service.updateEnquiry(id, req.principal.userId, req.body as UpdateEnquiryBody);
  res.status(200).json(enquiry);
}

export async function convertEnquiry(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { id } = req.params as unknown as IdParams;
  const { admissionNumber } = req.body as ConvertEnquiryBody;
  const result = await service.convertEnquiry(id, req.principal.userId, admissionNumber);
  res.status(201).json(result);
}
