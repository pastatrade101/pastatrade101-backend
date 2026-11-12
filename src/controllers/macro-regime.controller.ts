import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { buildMacroMarket } from '../services/macro-regime/macroMarket.service';
import { computeMacroRegime, type MacroRegimeResult } from '../services/macro-regime/macroRegime.service';

// When the stored score is older than this, compute a fresh one for the page
// (kept 6 hours in memory; one computation shared by concurrent requests). The
// daily sync stays the only writer — this never stores anything.
const STALE_DAYS = 2;
let live: { at: number; p: Promise<MacroRegimeResult> } | null = null;
const liveRegime = (): Promise<MacroRegimeResult> => {
  if (!live || Date.now() - live.at > 6 * 3600_000) {
    const p = computeMacroRegime();
    live = { at: Date.now(), p };
    p.catch(() => (live = null));
  }
  return live.p;
};

// GET /api/v1/macro-regime — latest stored macro regime (populated by the sync).
// Reads stored data (not live) to stay within Twelve Data's free-tier limits.
// Also returns the prior snapshot so the UI can show a trend (improving/worsening).
export const getMacroRegime = asyncHandler(async (_req: Request, res: Response) => {
  const { data: rows } = await supabase.from('macro_regime_daily').select('*').order('date', { ascending: false }).limit(2);
  const stored = rows?.[0];
  const ageDays = stored?.date ? (Date.now() - Date.parse(`${stored.date}T00:00:00Z`)) / 86_400_000 : Infinity;
  if (ageDays > STALE_DAYS) {
    const fresh = await liveRegime().catch(() => null);
    if (fresh && fresh.regime_score != null) {
      const prevScore = stored && stored.regime_score != null ? Number(stored.regime_score) : null;
      return sendSuccess(res, 'Macro regime computed live (stored score is stale).', {
        available: true,
        ...fresh,
        live: true,
        updated_at: fresh.as_of,
        stored_date: stored?.date ?? null,
        score_change: prevScore == null ? null : fresh.regime_score - prevScore,
        previous_score: prevScore,
        previous_date: stored?.date ?? null
      });
    }
  }
  const data = stored;
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

// GET /api/v1/macro-regime/market — the analyst page's data: global M2, the
// dollar index, gold, stablecoin supply and BTC correlations (BGeometrics),
// with history for the charts. Cached server-side; one upstream fetch a day.
export const getMacroMarket = asyncHandler(async (_req: Request, res: Response) => {
  return sendSuccess(res, 'Macro market data loaded.', await buildMacroMarket());
});
