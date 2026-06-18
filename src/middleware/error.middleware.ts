import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { AppError, sendError } from '../utils/api-response';

export const errorMiddleware = (error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof AppError) {
    return sendError(res, error.message, error.errors, error.statusCode);
  }

  const isProduction = env.NODE_ENV === 'production';
  const errors = isProduction ? [] : [{ message: error.message, stack: error.stack }];

  return sendError(res, isProduction ? 'Internal server error.' : error.message, errors, 500);
};
