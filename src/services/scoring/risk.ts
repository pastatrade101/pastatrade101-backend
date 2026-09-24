import type { DailyPoint } from '../sources/blockchaincom.client';

// Pure functions for the Pastatrade Risk model. Risk ∈ [0,1]: 0 = historically low
// risk (attractive accumulation), 1 = high risk (attractive distribution).
//
// Normalization note: we min-max each metric over its PUBLISHED history (see
// normalizeMinMaxFrom). That still uses hindsight — a future ATH rescales past
// risk — which is fine for a descriptive dashboard but must NOT be read as a
// backtested signal. Flagged here on purpose.

export type Nullable = number | null;

/** Min/max of the finite entries, by loop — the series is long enough that
 *  Math.min(...arr) risks a call-stack overflow as history grows. */
const extent = (values: Nullable[], startIndex = 0): { min: number; max: number } | null => {
  let min = Infinity;
  let max = -Infinity;
  for (let i = Math.max(0, startIndex); i < values.length; i += 1) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : { min, max };
};

/** Min-max scale to [0,1] over non-null values. Flat series → 0.5. */
export const normalizeMinMax = (values: Nullable[]): Nullable[] => normalizeMinMaxFrom(values, 0);

/**
 * Min-max scale to [0,1], deriving the scale from `startIndex` onward only.
 *
 * Why the window: the pipeline computes over the FULL price series (the log
 * regression fit needs it) but only publishes rows from STORE_FROM. Scaling on
 * the full series let pre-publication history set the denominator forever — a
 * single 2010-08-18 reading pinned the Mayer multiple's max at 200x (the real
 * post-2012 max is 8.2), which squashed every modern value to ~0 and made the
 * metric contribute "maximum safety" no matter what price did. Values before
 * the window are still scaled, and clamped, so they can't escape [0,1].
 */
export const normalizeMinMaxFrom = (values: Nullable[], startIndex: number): Nullable[] => {
  const span = extent(values, startIndex) ?? extent(values, 0);
  if (!span) return values.map(() => null);
  const range = span.max - span.min;
  return values.map((v) =>
    v === null || !Number.isFinite(v)
      ? null
      : range === 0
        ? 0.5
        : Math.min(1, Math.max(0, (v - span.min) / range))
  );
};

/**
 * Hold each non-null reading forward over up to `maxGap` following nulls.
 *
 * Feeds land on different schedules — price is daily, BGeometrics on-chain can
 * lag several days, Wikipedia by one — so a metric routinely just vanishes from
 * a day. Left alone that silently changes the shape of any composite built on
 * top, making it lurch when a feed goes stale rather than when the market moves.
 * Gaps longer than `maxGap` stay null so a dead feed drops out honestly.
 */
export const carryForward = (values: Nullable[], maxGap: number): Nullable[] => {
  const out = values.slice();
  let last: number | null = null;
  let age = 0;
  for (let i = 0; i < out.length; i += 1) {
    const v = out[i];
    if (v !== null && Number.isFinite(v)) {
      last = v;
      age = 0;
      continue;
    }
    if (last === null) continue;
    age += 1;
    if (age <= maxGap) out[i] = last;
  }
  return out;
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
