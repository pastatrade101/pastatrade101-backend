import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { supabase } from '../config/supabase';
import { computeDerivatives, storeDerivativesDaily, WEIGHTS } from '../services/derivatives/derivatives.service';

// Read-only view of the rules the leverage model uses (handy for ops/tuning).
const THRESHOLDS = {
  source: 'BGeometrics (bitcoin-data.com)',
  funding_hot_per_8h: 0.0003,
  funding_risk: '(24h avg funding + 0.0002) / 0.0012, clamped 0–1',
  open_interest_risk: 'percentile of open interest in BTC over the past 365 days',
  positioning_risk: 'percentile of the top-trader long/short account ratio (24h avg) over the past 365 days',
  oi_rising_7d_pct: 5,
  positioning_extreme_percentile: { high: 0.9, low: 0.1 },
  leverage_zones: { low: 0.35, normal: 0.55, elevated: 0.75 },
  weights: WEIGHTS
};

// POST /api/v1/admin/derivatives/sync — recompute + store today's row.
export const adminSyncDerivatives = asyncHandler(async (_req: Request, res: Response) => {
  const stored = await storeDerivativesDaily();
  const { data: latest } = await supabase.from('derivatives_daily').select('*').order('date', { ascending: false }).limit(1).maybeSingle();
  return sendSuccess(res, stored ? 'Derivatives synced.' : 'Derivatives data unavailable — nothing stored.', { stored, latest });
});

// GET /api/v1/admin/derivatives/diagnostics — stored row + live read + thresholds.
export const adminDerivativesDiagnostics = asyncHandler(async (_req: Request, res: Response) => {
  const [{ data: latest }, live, { count }] = await Promise.all([
    supabase.from('derivatives_daily').select('*').order('date', { ascending: false }).limit(1).maybeSingle(),
    computeDerivatives(),
    supabase.from('derivatives_daily').select('*', { count: 'exact', head: true })
  ]);
  return sendSuccess(res, 'Derivatives diagnostics.', { latest, live, row_count: count ?? 0, thresholds: THRESHOLDS });
});
