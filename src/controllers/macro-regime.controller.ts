import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

// GET /api/v1/macro-regime — latest stored macro regime (populated by the sync).
// Reads stored data (not live) to stay within Twelve Data's free-tier limits.
// Also returns the prior snapshot so the UI can show a trend (improving/worsening).
export const getMacroRegime = asyncHandler(async (_req: Request, res: Response) => {
  const { data: rows } = await supabase.from('macro_regime_daily').select('*').order('date', { ascending: false }).limit(2);
  const data = rows?.[0];
  if (!data || data.regime_score == null) {
    return sendSuccess(res, 'Macro regime unavailable.', { available: false, interpretation: (data?.interpretation as string) ?? 'Macro regime has not been synced yet.' });
  }
  // Trend vs the previous stored reading. Null when there's no prior row yet — the
  // UI degrades gracefully to "Trend data unavailable".
  const prev = rows?.[1];
  const prevScore = prev && prev.regime_score != null ? Number(prev.regime_score) : null;
  const score_change = prevScore == null ? null : Number(data.regime_score) - prevScore;
  return sendSuccess(res, 'Macro regime loaded.', {
    available: true,
    ...data,
    as_of: data.date,
    score_change,
    previous_score: prevScore,
    previous_date: prev?.date ?? null
  });
});
