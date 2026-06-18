import type { NextFunction, Request, Response } from 'express';
import { canAccess, cheapestPlanWith, cheapestPlanWithLimitAbove, limitFor, resolveUserAccess } from '../services/membership/plan-access';
import { usageForLimit } from '../services/membership/usage.service';
import { AppError } from '../utils/api-response';

// Backend-enforced access control. Never trust the frontend — these guards run
// on protected endpoints and return the upgrade-prompt shapes the UI expects.

/** Block the request unless the user's plan enables `featureKey`. */
export const requireFeature = (featureKey: string) => async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new AppError('Authentication is required.', 401));
  try {
    const access = await resolveUserAccess(req.user.sub);
    if (canAccess(access, featureKey)) return next();
    const requiredPlan = await cheapestPlanWith(featureKey);
    return res.status(403).json({
      success: false,
      error: 'Feature locked',
      feature: featureKey,
      required_plan: requiredPlan,
      message: `Upgrade to ${requiredPlan[0].toUpperCase() + requiredPlan.slice(1)} to access this feature.`
    });
  } catch (err) {
    return next(new AppError('Unable to verify feature access.', 500, [err]));
  }
};

/** Block the request when the user is at/over a numeric plan limit. */
export const requireLimit = (limitKey: string) => async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new AppError('Authentication is required.', 401));
  try {
    const access = await resolveUserAccess(req.user.sub);
    const limit = limitFor(access, limitKey);
    if (limit === null) return next(); // unlimited (or admin)
    const used = await usageForLimit(req.user.sub, limitKey);
    if (used < limit) return next();
    const requiredPlan = await cheapestPlanWithLimitAbove(limitKey, limit);
    const feature = limitKey.replace(/^max_/, '').replace(/_/g, ' ');
    return res.status(403).json({
      success: false,
      error: 'Plan limit reached',
      feature,
      current_limit: limit,
      required_plan: requiredPlan,
      message: `Your ${access.plan.name} plan allows up to ${limit} ${feature}. Upgrade to ${requiredPlan[0].toUpperCase() + requiredPlan.slice(1)} to add more.`
    });
  } catch (err) {
    return next(new AppError('Unable to verify plan limit.', 500, [err]));
  }
};
