import { supabase } from '../../config/supabase';

// The BTC risk anyone sees is the mean of the last 7 daily scores — the value the
// Risk page gauge, the Overview and Exit Strategy show. Read it here so other
// pages don't print today's raw score (0.26) beside everyone else's 0.27.
export const RISK_SMOOTH_DAYS = 7;

export const readSmoothedBtcRisk = async (): Promise<number | null> => {
  const { data } = await supabase.from('risk_summary_daily').select('summary_risk').order('snapshot_date', { ascending: false }).limit(RISK_SMOOTH_DAYS);
  const vals = (data ?? []).map((r) => (r.summary_risk == null ? NaN : Number(r.summary_risk))).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};
