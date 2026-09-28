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
      // req.query cannot be written back to: Express 5 exposes it as a
      // getter that re-derives a fresh object from req.url on every single
      // access, not a stored, mutable property — confirmed directly (it has
      // no own property descriptor on the request instance). Assigning onto
      // one snapshot of it silently never persists to the next access, which
      // means any route relying on a Zod .default()/coerce/.transform() to
      // reach its controller via req.query was always getting the raw,
      // unvalidated value instead. Stored separately here instead.
      req.validatedQuery = result.data;
    }

    next();
  };
}
