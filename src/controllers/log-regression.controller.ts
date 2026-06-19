import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { resolveUserAccess } from '../services/membership/plan-access';
import { buildTakeaway, computeLogRegression, sliceRange } from '../services/log-regression/logRegression.service';
import type { AssetSymbol } from '../services/log-regression/logRegressionSettings.service';

// User-facing Logarithmic Regression Bands (BTC + ETH). Free can preview BTC with
// a capped range; ETH requires a paid plan.

const parseAsset = (raw: string | undefined): AssetSymbol => {
  const a = (raw ?? '').toUpperCase();
  if (a !== 'BTC' && a !== 'ETH') throw new AppError('Unknown asset. Use btc or eth.', 400);
  return a;
};

const isPaid = async (userId: string): Promise<boolean> => {
  const access = await resolveUserAccess(userId);
  return access.isAdmin || access.plan.slug === 'mid' || access.plan.slug === 'premium';
};

// GET /api/v1/charts/log-regression/:asset?range=all|10y|5y|3y|1y
export const getLogRegression = asyncHandler(async (req: Request, res: Response) => {
  const asset = parseAsset(req.params.asset);
  const paid = await isPaid(req.user!.sub);
  if (asset === 'ETH' && !paid) {
    return res.status(403).json({ success: false, error: 'Feature locked', feature: 'eth_log_regression', required_plan: ['mid'], message: 'ETH regression bands require a Mid or Premium plan.' });
  }
  let range = getQueryString(req.query, 'range') || 'all';
  if (!paid && range !== '1y') range = '1y'; // free preview is capped to 1Y

  const result = await computeLogRegression(asset);
  const points = sliceRange(result.points, range);
  return sendSuccess(res, 'Logarithmic regression computed successfully.', {
    asset: asset,
    asset_id: result.asset_id,
    source: result.source,
    fitting_method: result.fitting_method,
    start_date: result.start_date,
    fit_valid: result.fit_valid,
    fit_note: result.fit_note,
    history_years: result.history_years,
    range,
    is_paid: paid,
    points,
    latest: result.latest,
    takeaway: buildTakeaway(asset, result.latest, result.fit_valid, result.fit_note)
  });
});

// GET /api/v1/charts/log-regression/:asset/latest
export const getLogRegressionLatest = asyncHandler(async (req: Request, res: Response) => {
  const asset = parseAsset(req.params.asset);
  const paid = await isPaid(req.user!.sub);
  if (asset === 'ETH' && !paid) {
    return res.status(403).json({ success: false, error: 'Feature locked', feature: 'eth_log_regression', required_plan: ['mid'], message: 'ETH regression bands require a Mid or Premium plan.' });
  }
  const result = await computeLogRegression(asset);
  const l = result.latest;
  return sendSuccess(res, 'Latest regression read fetched successfully.', {
    asset,
    fit_valid: result.fit_valid,
    fit_note: result.fit_note,
    current_price: l?.price_usd ?? null,
    fit_price: l?.fit_price ?? null,
    lower_band: l?.lower_band ?? null,
    upper_band: l?.upper_band ?? null,
    bubble_lower_band: l?.bubble_lower_band ?? null,
    bubble_upper_band: l?.bubble_upper_band ?? null,
    distance_from_fit_percent: l?.distance_from_fit_percent ?? null,
    risk_score: l?.risk_score ?? null,
    zone_label: l?.zone_label ?? null,
    premium_takeaway: buildTakeaway(asset, l, result.fit_valid, result.fit_note)
  });
});
