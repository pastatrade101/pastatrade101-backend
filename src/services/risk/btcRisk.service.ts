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

// The Risk Dashboard's zones (0.2 / 0.4 / 0.6 / 0.8) with the Overview's wording,
// so every page that shows BTC risk names the same zone.
export interface BtcRiskZone {
  label: string;
  meaning: string;
  dca: string;
}

export const btcRiskZone = (r: number): BtcRiskZone => {
  if (r < 0.2) return { label: 'Aggressive DCA zone', meaning: 'BTC risk is very low on the current risk model.', dca: 'Aggressive DCA' };
  if (r < 0.4) return { label: 'Good DCA zone', meaning: 'BTC is not overheated on the current risk model.', dca: 'Good DCA' };
  if (r < 0.6) return { label: 'Neutral', meaning: 'BTC risk is moderate — neither cheap nor stretched.', dca: 'Neutral — DCA steadily' };
  if (r < 0.8) return { label: 'Caution', meaning: 'BTC risk is rising — be more selective.', dca: 'Caution — slow down' };
  return { label: 'Distribution risk', meaning: 'BTC risk is high on this model.', dca: 'Distribution — no aggressive buying' };
};
