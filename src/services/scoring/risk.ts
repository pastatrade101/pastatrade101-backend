import type { DailyPoint } from '../sources/blockchaincom.client';

// Pure functions for the Pastatrade Risk model. Risk ∈ [0,1]: 0 = historically low
// risk (attractive accumulation), 1 = high risk (attractive distribution).
//
// Normalization note: we min-max each metric over its FULL history. That uses
// hindsight (a future ATH rescales past risk), which is fine for a descriptive
// dashboard but must NOT be read as a backtested signal. Flagged here on purpose.

export type Nullable = number | null;

/** Min-max scale to [0,1] over non-null values. Flat series → 0.5. */
export const normalizeMinMax = (values: Nullable[]): Nullable[] => {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!finite.length) return values.map(() => null);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min;
  return values.map((v) => (v === null || !Number.isFinite(v) ? null : range === 0 ? 0.5 : (v - min) / range));
};

/** Residual of ln(price) vs a ln(time) least-squares regression — the "log regression" metric. */
export const logRegressionResidual = (closes: number[]): Nullable[] => {
  const xs: number[] = [];
  const ys: number[] = [];
  closes.forEach((price, i) => {
    if (price > 0) {
      xs.push(Math.log(i + 1));
      ys.push(Math.log(price));
    }
  });
  if (xs.length < 2) return closes.map(() => null);

  const n = xs.length;
  const sx = xs.reduce((s, v) => s + v, 0);
  const sy = ys.reduce((s, v) => s + v, 0);
  const sxy = xs.reduce((s, v, i) => s + v * ys[i], 0);
  const sxx = xs.reduce((s, v) => s + v * v, 0);
  const denom = n * sxx - sx * sx;
  const m = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;

  return closes.map((price, i) => (price > 0 ? Math.log(price) - (m * Math.log(i + 1) + b) : null));
};

/** Price ÷ trailing 200-day simple moving average (null until enough history). */
export const mayerMultipleSeries = (closes: number[], period = 200): Nullable[] =>
  closes.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += closes[j];
    const sma = sum / period;
    return sma > 0 ? closes[i] / sma : null;
  });

/** Price ÷ running all-time-high (point-in-time; near 1 = near ATH = higher risk). */
export const runningAthRatio = (closes: number[]): Nullable[] => {
  let peak = -Infinity;
  return closes.map((price) => {
    if (price > peak) peak = price;
    return peak > 0 ? price / peak : null;
  });
};

/** Wilder RSI as a per-day series (null during warmup). */
export const rsiSeries = (closes: number[], period = 14): Nullable[] => {
  const out: Nullable[] = closes.map(() => null);
  if (closes.length < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
};

export interface RiskMetricRow {
  date: string;
  metric_key: string;
  raw_value: Nullable;
  risk: Nullable;
}

/** Build risk_metric_daily rows for one metric from aligned date + raw + risk arrays. */
export const buildMetricRows = (
  metricKey: string,
  dates: string[],
  raw: Nullable[],
  risk: Nullable[]
): RiskMetricRow[] =>
  dates
    .map((date, i) => ({ date, metric_key: metricKey, raw_value: raw[i], risk: risk[i] }))
    .filter((r) => r.risk !== null);

/** Map a DailyPoint[] (its own dates) into a value array aligned to `dates`. */
export const alignToDates = (dates: string[], points: DailyPoint[]): Nullable[] => {
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  return dates.map((d) => (byDate.has(d) ? (byDate.get(d) as number) : null));
};
