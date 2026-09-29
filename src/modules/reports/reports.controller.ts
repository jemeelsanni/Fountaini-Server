import type { Request, Response } from "express";
import * as service from "./reports.service.js";
import type { PaymentHistoryQuery, ScopedReportQuery } from "./reports.schemas.js";

export async function getDefaultersReport(req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.getDefaultersReport(req.validatedQuery as ScopedReportQuery));
}

export async function getCollectionsReport(req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.getCollectionsReport(req.validatedQuery as ScopedReportQuery));
}

export async function getPaymentHistoryReport(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as PaymentHistoryQuery;
  const rows = await service.getPaymentHistoryReport(query);

  if (query.format === "csv") {
    res.status(200).set("Content-Type", "text/csv; charset=utf-8").send(service.paymentHistoryToCsv(rows));
    return;
  }
  res.status(200).json(rows);
}

export async function getTermSummaryReport(req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.getTermSummaryReport(req.validatedQuery as ScopedReportQuery));
}
