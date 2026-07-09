import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { canAccess, resolveUserAccess } from '../services/membership/plan-access';
import { buildOverview, type Universe } from '../services/overview/overview.service';
import { generateMarketRead } from '../services/ai/marketRead.service';

// GET /api/v1/overview?universe=clean|all — the daily market command center.
export const getOverview = asyncHandler(async (req: Request, res: Response) => {
  const universe: Universe = getQueryString(req.query, 'universe') === 'all' ? 'all' : 'clean';
  const access = await resolveUserAccess(req.user!.sub);
  const tier = access.isAdmin || access.plan.slug === 'premium' ? 'premium' : access.plan.slug === 'mid' ? 'mid' : 'free';
  // Premium interpretation (signal cards + strongest/warning + full read) is gated
  // by a feature flag that admins can toggle per plan from /admin/plans.
  const hasInterp = canAccess(access, 'access_premium_interpretation');

  let data;
  try {
    data = await buildOverview({ universe, isPaid: hasInterp });
  } catch (e) {
    if (e instanceof Error && e.message === 'NO_MARKET_DATA') throw new AppError('Market data is not available yet. Run a sync first.', 503);
    throw e;
  }

  // Without the interpretation feature, return metrics + condition + a short read
  // + report preview only (the frontend renders blurred upgrade cards for the rest).
  const payload: Record<string, unknown> = { ...data, tier, has_interpretation: hasInterp };
  if (!hasInterp) {
    payload.signals = null;
    payload.strongest_signal_today = null;
    payload.biggest_warning_today = null;
    payload.daily_market_read = `${data.daily_market_read.split('. ')[0]}.`;
  }
  return sendSuccess(res, 'Overview fetched successfully.', payload);
});

// GET /api/v1/overview/market-read?lang=en|sw — premium AI synthesis of the same
// signals. Fetched separately so the LLM latency never blocks the dashboard, and
// returns { read: null } (rather than erroring) whenever the feature is off, the
// user isn't premium, or the model is unavailable — the UI then shows the
// deterministic rule-based verdict. The synthesis interprets the app's computed
// signals; it never produces the numbers.
export const getMarketRead = asyncHandler(async (req: Request, res: Response) => {
  const lang = getQueryString(req.query, 'lang') === 'sw' ? 'sw' : 'en';
  const access = await resolveUserAccess(req.user!.sub);
  if (!canAccess(access, 'access_premium_interpretation')) {
    return sendSuccess(res, 'Premium AI read is not available on this plan.', { read: null });
  }

  let data;
  try {
    data = await buildOverview({ universe: 'clean', isPaid: true });
  } catch {
    return sendSuccess(res, 'Market data unavailable.', { read: null });
  }

  const read = await generateMarketRead(data.signals, data.market_condition, lang);
  return sendSuccess(res, 'Market read fetched successfully.', { read });
});
