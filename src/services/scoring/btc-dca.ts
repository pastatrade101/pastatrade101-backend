import type { MarketCondition } from '../../types';
import {
  clamp01to100,
  drawdownFromAth,
  returnOverDays,
  rsi,
  simpleMovingAverage,
  volatility,
  volatilityLabel
} from './technicals';

export interface BtcSignals {
  price: number;
  ma20: number | null;
  ma50: number | null;
  ma100: number | null;
  ma200: number | null;
  rsi14: number | null;
  volatilityDaily: number | null;
  volatilityState: string;
  drawdownFromAth: number;
  return30d: number | null;
  dcaScore: number;
  dcaLabel: string;
  marketCondition: MarketCondition;
}

// ── Component sub-scores (each 0–100), per SRS §4.3 weighting ─────────────
const drawdownScore = (drawdown: number): number => clamp01to100((Math.abs(drawdown) / 80) * 100);

const volatilityCoolingScore = (dailyVol: number | null): number => {
  if (dailyVol === null) return 50;
  return clamp01to100((1 - dailyVol / 7) * 100); // calmer tape → higher accumulation score
};

const rsiCoolingScore = (rsiValue: number | null): number => {
  if (rsiValue === null) return 50;
  return clamp01to100(100 - rsiValue); // oversold (low RSI) → higher score
};

const maPositionScore = (price: number, ma200: number | null): number => {
  if (!ma200) return 50;
  const ratio = price / ma200;
  // ratio ≤ 0.7 (well below the 200MA) → 100; ratio ≥ 1.3 (extended) → 0.
  return clamp01to100(((1.3 - ratio) / 0.6) * 100);
};

const dominanceConditionScore = (dominanceChange: number | null): number => {
  if (dominanceChange === null) return 50;
  // Rising BTC dominance favors accumulating BTC over alts.
  return clamp01to100(50 + dominanceChange * 5);
};

export const dcaLabel = (score: number): string => {
  if (score <= 30) return 'Not attractive';
  if (score <= 50) return 'Watch zone';
  if (score <= 70) return 'Accumulation possible';
  if (score <= 85) return 'Strong DCA window';
  return 'Extreme accumulation zone';
};

// ── Market-cycle classifier (drives the overview label + summary) ────────
export const classifyMarketCondition = (input: {
  drawdown: number;
  rsiValue: number | null;
  dailyVol: number | null;
  return30d: number | null;
}): MarketCondition => {
  const { drawdown, rsiValue, return30d } = input;
  const r = rsiValue ?? 50;
  const mom = return30d ?? 0;

  if (drawdown < -55 && r < 35) return 'Capitulation';
  if (r >= 75 && drawdown > -15) return 'Overheated';
  if (drawdown > -15 && mom < 0 && r < 60) return 'Distribution';
  if (r < 45 && mom <= 5) return 'Accumulation';
  if (mom < 0 && r >= 45 && r < 60) return 'Cool-off';
  return 'Risk-on';
};

const CONDITION_SUMMARY: Record<MarketCondition, string> = {
  Accumulation:
    'BTC is in an accumulation phase. Prices are well off recent highs and momentum has cooled, historically a window disciplined investors use for steady DCA.',
  'Cool-off':
    'BTC is in a cool-off period. Volatility is lower than previous weeks, giving disciplined investors a possible DCA window while altcoins remain selective.',
  'Risk-on':
    'The market is risk-on. Momentum is positive and breadth is improving, though chasing strength carries more downside if conditions reverse.',
  Overheated:
    'The market looks overheated. Momentum is stretched and RSI is elevated, conditions where adding aggressively has historically carried elevated risk.',
  Distribution:
    'BTC is showing distribution characteristics near prior highs as momentum fades. Strength is being sold into rather than bought.',
  Capitulation:
    'BTC appears to be in capitulation. Drawdowns are deep and sentiment is fearful, historically a high-risk but high-interest accumulation zone for long-horizon investors.'
};

export const conditionSummary = (condition: MarketCondition): string => CONDITION_SUMMARY[condition];

// ── Top-level: turn a BTC daily series into the full dashboard payload ────
export const computeBtcSignals = (
  closes: number[],
  ath: number,
  dominanceChange: number | null = null
): BtcSignals => {
  const price = closes[closes.length - 1] ?? 0;
  const ma20 = simpleMovingAverage(closes, 20);
  const ma50 = simpleMovingAverage(closes, 50);
  const ma100 = simpleMovingAverage(closes, 100);
  const ma200 = simpleMovingAverage(closes, 200);
  const rsi14 = rsi(closes, 14);
  const volDaily = volatility(closes, 30);
  const drawdown = drawdownFromAth(price, ath || price);
  const return30d = returnOverDays(closes, 30);

  const dcaScore = Math.round(
    drawdownScore(drawdown) * 0.3 +
      volatilityCoolingScore(volDaily) * 0.2 +
      rsiCoolingScore(rsi14) * 0.2 +
      maPositionScore(price, ma200) * 0.15 +
      dominanceConditionScore(dominanceChange) * 0.15
  );

  const marketCondition = classifyMarketCondition({ drawdown, rsiValue: rsi14, dailyVol: volDaily, return30d });

  return {
    price,
    ma20,
    ma50,
    ma100,
    ma200,
    rsi14,
    volatilityDaily: volDaily,
    volatilityState: volatilityLabel(volDaily),
    drawdownFromAth: drawdown,
    return30d,
    dcaScore,
    dcaLabel: dcaLabel(dcaScore),
    marketCondition
  };
};
