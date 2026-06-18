import type { Response } from 'express';

export class AppError extends Error {
  statusCode: number;
  errors: unknown[];

  constructor(message: string, statusCode = 500, errors: unknown[] = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

export const sendSuccess = <T>(res: Response, message: string, data?: T, statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data: data ?? {}
  });
};

export const sendError = (res: Response, message: string, errors: unknown[] = [], statusCode = 500) => {
  return res.status(statusCode).json({
    success: false,
    message,
    errors
  });
};
