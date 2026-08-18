import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { AppError } from "../../errors/AppError.js";

interface ValidationTargets {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

export function validate(schemas: ValidationTargets) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        next(AppError.badRequest("Invalid request body", result.error.issues));
        return;
      }
      req.body = result.data;
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        next(AppError.badRequest("Invalid request params", result.error.issues));
        return;
      }
      req.params = result.data as typeof req.params;
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        next(AppError.badRequest("Invalid query parameters", result.error.issues));
        return;
      }
      // Express 5's req.query has no setter — mutate the existing object instead
      // of reassigning the reference.
      Object.assign(req.query, result.data);
    }

    next();
  };
}
