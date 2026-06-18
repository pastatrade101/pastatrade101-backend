import type { DailyPoint } from '../sources/blockchaincom.client';
import { clamp01to100, relativeStrengthSignal } from '../scoring/technicals';
import { detectBreakout, type BreakoutResult } from './breakout';

// Pure Alt/BTC relative-strength compute. Both daily series come from the same
// source (CoinGecko), so dates align cleanly. Ratio = alt_usd / btc_usd.

export interface AltBtcPoint {
  date: string;
  alt_usd: number;
  btc_usd: number;
  ratio: number;
  ma20: number | null;
  ma50: number | null;
  ma100: number | null;
  ma200: number | null;
}

export interface AltBtcResult {
  points: AltBtcPoint[];
  latest_ratio: number;
  strength_7d: number | null; // % change of the ratio (relative strength vs BTC)
  strength_30d: number | null;
  strength_90d: number | null;
  signal: string;
  ma_signal: string;
  reaction_score: number;
  reaction_label: string;
  breakout_type: BreakoutResult['signal_type'];
  breakout_label: string;
  breakout_details: BreakoutResult['details'];
}

const maAt = (vals: number[], i: number, period: number): number | null => {
  if (i < period - 1) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j += 1) sum += vals[j];
  return sum / period;
};

const roc = (vals: number[], period: number): number | null => {
  if (vals.length < period + 1) return null;
  const cur = vals[vals.length - 1];
  const past = vals[vals.length - 1 - period];
  if (!past) return null;
  return ((cur - past) / past) * 100;
};

const reactionLabel = (score: number): string => {
  if (score <= 30) return 'Bleeding against BTC';
  if (score <= 45) return 'Weak';
  if (score <= 55) return 'Neutral';
  if (score <= 70) return 'Improving';
  if (score <= 85) return 'Strong vs BTC';
  return 'Leader vs BTC';
};

/**
 * Build the Alt/BTC ratio series (with MAs) plus headline strength + a reaction
 * score. `volumeBreakout` = the altcoin's current vol ÷ 30d avg vol (feeds the
 * score's volume component). Normalization + oscillator are derived client-side
 * per timeframe.
 */
export const computeAltBtc = (alt: DailyPoint[], btc: DailyPoint[], volumeBreakout: number | null): AltBtcResult => {
  // Align on shared dates.
  const btcByDate = new Map(btc.map((p) => [p.date, p.value]));
  const aligned = alt
    .filter((p) => btcByDate.has(p.date) && p.value > 0 && (btcByDate.get(p.date) as number) > 0)
    .map((p) => ({ date: p.date, alt_usd: p.value, btc_usd: btcByDate.get(p.date) as number }));

  const ratios = aligned.map((p) => p.alt_usd / p.btc_usd);

  const points: AltBtcPoint[] = aligned.map((p, i) => ({
    date: p.date,
    alt_usd: p.alt_usd,
    btc_usd: p.btc_usd,
    ratio: ratios[i],
    ma20: maAt(ratios, i, 20),
    ma50: maAt(ratios, i, 50),
    ma100: maAt(ratios, i, 100),
    ma200: maAt(ratios, i, 200)
  }));

  const latest = points[points.length - 1];
  const latestRatio = latest?.ratio ?? 0;
  const strength30 = roc(ratios, 30);

  // ── reaction score (free inputs; sideways & sector default to neutral 50) ──
  const ratioVsMa50 = latest?.ma50 ? (latestRatio / latest.ma50 - 1) * 100 : 0;
  const trendScore = clamp01to100(50 + ratioVsMa50 * 3);
  const rsScore = clamp01to100(50 + (strength30 ?? 0) * 1.5);
  const volScore = clamp01to100((volumeBreakout ?? 1) * 50);
  const reaction = Math.round(0.3 * trendScore + 0.25 * rsScore + 0.2 * volScore + 0.15 * 50 + 0.1 * 50);

  // ── MA signal ──
  const aboveMa200 = latest?.ma200 != null && latestRatio > latest.ma200;
  const aboveMa50 = latest?.ma50 != null && latestRatio > latest.ma50;
  const golden = latest?.ma50 != null && latest?.ma200 != null && latest.ma50 > latest.ma200;
  const maSignal = aboveMa200
    ? golden
      ? 'Long-term strength improving (above 200D MA, 50>200)'
      : 'Above the 200D MA'
    : aboveMa50
      ? 'Short-term strength, still below the 200D MA'
      : 'Weak vs BTC long-term (below 200D MA)';

  const breakout = detectBreakout(points, volumeBreakout);

  return {
    points,
    latest_ratio: latestRatio,
    strength_7d: roc(ratios, 7),
    strength_30d: strength30,
    strength_90d: roc(ratios, 90),
    signal: relativeStrengthSignal(strength30),
    ma_signal: maSignal,
    reaction_score: reaction,
    reaction_label: reactionLabel(reaction),
    breakout_type: breakout.signal_type,
    breakout_label: breakout.signal_label,
    breakout_details: breakout.details
  };
};
