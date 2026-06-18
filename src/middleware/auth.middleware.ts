import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../utils/api-response';
import type { AuthTokenPayload } from '../types';

export const authenticate = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return next(new AppError('Authentication token is required.', 401));
  }

  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
    return next();
  } catch {
    return next(new AppError('Invalid or expired authentication token.', 401));
  }
};

/**
 * Attaches `req.user` when a valid token is present, but never blocks the request
 * when it is absent. Used for endpoints that work for guests but enrich the
 * response for signed-in users.
 */
export const optionalAuthenticate = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;

  if (header?.startsWith('Bearer ')) {
    try {
      const token = header.split(' ')[1];
      req.user = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
    } catch {
      // Ignore invalid tokens on optional routes — treat as a guest.
    }
  }

  return next();
};
