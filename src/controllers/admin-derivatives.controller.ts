import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { supabase } from '../config/supabase';
import { computeDerivatives, storeDerivativesDaily } from '../services/derivatives/derivatives.service';

// Read-only view of the rules the leverage model uses (handy for ops/tuning).
const THRESHOLDS = {
  funding_hot_per_8h: 0.0003,
  long_short_extreme_high: 1.8,
  long_short_extreme_low: 0.6,
  oi_rising_pct: 3,
  leverage_zones: { low: 0.35, normal: 0.55, elevated: 0.75 },
  funding_weight: 0.6,
  long_short_weight: 0.4
};

// POST /api/v1/admin/derivatives/sync — recompute + store today's row.
export const adminSyncDerivatives = asyncHandler(async (_req: Request, res: Response) => {
  const stored = await storeDerivativesDaily();
  const { data: latest } = await supabase.from('derivatives_daily').select('*').order('date', { ascending: false }).limit(1).maybeSingle();
  return sendSuccess(res, stored ? 'Derivatives synced.' : 'Bitget data unavailable — nothing stored.', { stored, latest });
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
