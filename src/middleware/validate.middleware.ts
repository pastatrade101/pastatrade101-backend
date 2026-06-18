import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { AppError } from '../utils/api-response';

type ValidationTarget = {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
};

export const validate = (schemas: ValidationTarget) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const errors: unknown[] = [];

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) errors.push(...result.error.errors);
      else req.body = result.data;
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) errors.push(...result.error.errors);
      else req.params = result.data;
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) errors.push(...result.error.errors);
      else req.query = result.data;
    }

    if (errors.length > 0) {
      return next(new AppError('Validation failed.', 422, errors));
    }

    return next();
  };
};
