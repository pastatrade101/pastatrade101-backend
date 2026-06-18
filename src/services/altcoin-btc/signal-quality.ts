// Signal confidence + quality from liquidity, trend structure and data quality.
// Keeps low-liquidity / abnormal-spike tickers from masquerading as clean signals.

export interface SignalMetrics {
  strength_7d: number | null;
  strength_30d: number | null;
  strength_90d: number | null;
  above_ma50: boolean;
  above_ma200: boolean;
  volume_breakout: number | null;
  market_cap: number | null;
  total_volume: number | null;
  market_cap_rank: number | null;
  history_days: number;
}

export type Confidence = 'High confidence' | 'Medium confidence' | 'Low confidence';
export type Quality = 'Clean signal' | 'Mixed signal' | 'Low-liquidity risk' | 'Abnormal spike' | 'Short history' | 'Needs confirmation';

const MIN_VOLUME = 10_000_000;

export const isLiquid = (m: SignalMetrics): boolean =>
  (m.total_volume ?? 0) >= MIN_VOLUME && (m.market_cap_rank ?? 9999) <= 150;

// A huge short-term move on an illiquid / thin-history asset = likely data/spike noise.
export const isAbnormalSpike = (m: SignalMetrics): boolean =>
  Math.abs(m.strength_7d ?? 0) > 60 && (!isLiquid(m) || m.history_days < 180);

// Confidence = how RELIABLE the read is (data quality + signal consistency),
// independent of direction. A clean, liquid, long-history *weak* coin is a
// high-confidence weakness call — not low confidence.
export const computeConfidence = (m: SignalMetrics): Confidence => {
  if (!isLiquid(m) || m.history_days < 90 || isAbnormalSpike(m)) return 'Low confidence';
  const s30 = m.strength_30d ?? 0;
  const s90 = m.strength_90d ?? 0;
  const consistentBull = m.above_ma200 && s30 > 0 && s90 > 0;
  const consistentBear = !m.above_ma200 && s30 < 0 && s90 < 0;
  if ((consistentBull || consistentBear) && m.history_days >= 180) return 'High confidence';
  return 'Medium confidence'; // liquid but transitional / mixed signals
};

export const computeQuality = (m: SignalMetrics): Quality => {
  if (m.history_days < 180) return 'Short history';
  if (!isLiquid(m)) return 'Low-liquidity risk';
  if (isAbnormalSpike(m)) return 'Abnormal spike';
  if (!m.above_ma200 && (m.strength_30d ?? 0) > 0) return 'Needs confirmation'; // early recovery
  if (m.above_ma200 && (m.strength_90d ?? 0) < 0) return 'Mixed signal';
  return 'Clean signal';
};

export const buildReasons = (m: SignalMetrics): string[] => {
  const r: string[] = [];
  r.push(m.above_ma200 ? 'Above the 200-day Alt/BTC MA' : 'Below the 200-day Alt/BTC MA');
  r.push(m.above_ma50 ? 'Above the 50-day MA' : 'Below the 50-day MA');
  if (m.strength_30d != null) r.push(`30d strength ${m.strength_30d >= 0 ? 'positive' : 'negative'} (${m.strength_30d.toFixed(0)}%)`);
  if (m.strength_90d != null) r.push(`90d strength ${m.strength_90d >= 0 ? 'positive' : 'negative'} (${m.strength_90d.toFixed(0)}%)`);
  if (m.volume_breakout != null) r.push(`Volume support ${m.volume_breakout > 1.2 ? 'positive' : 'soft'}`);
  if (isAbnormalSpike(m)) r.push('⚠ Abnormal short-term spike — treat as low confidence');
  if (m.history_days < 180) r.push('⚠ Limited price history — confidence reduced');
  return r;
};
