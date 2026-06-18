import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '../types';
import { AppError } from '../utils/api-response';

export const authorizeRoles = (...roles: UserRole[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('Authentication is required.', 401));
    }

    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action.', 403));
    }

    return next();
  };
};

// Analysts and admins can reach analyst-tier features (custom indicators, forecast, advanced screener).
export const analystOrAdmin = authorizeRoles('analyst', 'admin');
export const adminOnly = authorizeRoles('admin');
