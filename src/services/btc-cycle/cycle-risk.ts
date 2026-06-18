import type { DailyPoint } from '../sources/blockchaincom.client';
import { dcaLabel } from '../scoring/btc-dca';
import { clamp01to100, drawdownFromAth, rsi, simpleMovingAverage } from '../scoring/technicals';

export interface CycleRisk {
  btc_price: number;
  risk_score: number; // 0..100, higher = more risk / overheated
  risk_label: string;
  reason: string;
  distance_from_200ma: number | null; // %
  drawdown_from_ath: number; // %
  rsi: number | null;
  ytd_roi: number | null; // %
  dca_window: string;
}

const riskLabel = (score: number): string => {
  if (score <= 20) return 'Deep value / accumulation';
  if (score <= 40) return 'Low risk';
  if (score <= 60) return 'Neutral';
  if (score <= 80) return 'High risk';
  return 'Extreme risk / overheated';
};

/**
 * Current BTC cycle risk score (0–100) from free price-derived inputs: position
 * vs the 200-day MA, RSI, and proximity to the all-time high. This is a market-
 * context score, not a prediction. (SD-band position is added once SD bands ship.)
 */
export const computeCycleRisk = (series: DailyPoint[]): CycleRisk => {
  const closes = series.map((p) => p.value);
  const price = closes[closes.length - 1];
  const ma200 = simpleMovingAverage(closes, 200);
  const rsi14 = rsi(closes, 14);
  const ath = Math.max(...closes);
  const drawdown = drawdownFromAth(price, ath);

  // Year-to-date ROI from the current year's first close.
  const year = series[series.length - 1].date.slice(0, 4);
  const yearOpen = series.find((p) => p.date.slice(0, 4) === year)?.value ?? null;
  const ytd = yearOpen && yearOpen > 0 ? ((price - yearOpen) / yearOpen) * 100 : null;

  // Risk components (0–100, higher = riskier).
  const maRisk = ma200 ? clamp01to100(((price / ma200 - 0.8) / (2.2 - 0.8)) * 100) : 50;
  const rsiRisk = rsi14 ?? 50;
  const athRisk = clamp01to100((price / ath) * 100); // near ATH → high risk

  const score = Math.round(0.34 * maRisk + 0.33 * rsiRisk + 0.33 * athRisk);
  const distance200 = ma200 ? Number((((price - ma200) / ma200) * 100).toFixed(1)) : null;

  const reason = [
    rsi14 != null ? `RSI ${rsi14.toFixed(0)}` : null,
    distance200 != null ? `${distance200 >= 0 ? '+' : ''}${distance200}% vs 200D MA` : null,
    `${drawdown.toFixed(0)}% from ATH`
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    btc_price: price,
    risk_score: score,
    risk_label: riskLabel(score),
    reason,
    distance_from_200ma: distance200,
    drawdown_from_ath: Number(drawdown.toFixed(1)),
    rsi: rsi14 != null ? Number(rsi14.toFixed(0)) : null,
    ytd_roi: ytd != null ? Number(ytd.toFixed(1)) : null,
    // DCA window is the inverse stance of risk (low risk → favourable accumulation).
    dca_window: dcaLabel(100 - score)
  };
};
