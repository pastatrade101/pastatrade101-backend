// Pure functions over daily series. No I/O — easy to unit test and reuse.
// Series are assumed chronological (oldest → newest).

export const simpleMovingAverage = (closes: number[], period: number): number | null => {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  return window.reduce((sum, v) => sum + v, 0) / period;
};

/** Wilder's RSI over `period` (default 14). Returns 0–100, or null if too little data. */
export const rsi = (closes: number[], period = 14): number | null => {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

/** % return over the last `days` (compares newest close to the one `days` ago). */
export const returnOverDays = (closes: number[], days: number): number | null => {
  if (closes.length < days + 1) return null;
  const latest = closes[closes.length - 1];
  const past = closes[closes.length - 1 - days];
  if (!past) return null;
  return ((latest - past) / past) * 100;
};

/** Drawdown from all-time high in the series (negative number). SRS §4.3 formula. */
export const drawdownFromAth = (currentPrice: number, ath: number): number => {
  if (!ath) return 0;
  return ((currentPrice - ath) / ath) * 100;
};

/** current 24h volume ÷ average daily volume over the trailing window. SRS §4.8. */
export const volumeBreakoutRatio = (volumes: number[], window = 30): number | null => {
  if (volumes.length < 2) return null;
  const current = volumes[volumes.length - 1];
  const past = volumes.slice(-1 - window, -1);
  if (past.length === 0) return null;
  const avg = past.reduce((sum, v) => sum + v, 0) / past.length;
  if (!avg) return null;
  return current / avg;
};

/** Annualized-ish volatility: stdev of daily returns over the trailing window, as %. */
export const volatility = (closes: number[], window = 30): number | null => {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-window - 1);
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i += 1) rets.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
};

// ── Label helpers (SRS) ──────────────────────────────────────────────────
export const volatilityLabel = (dailyVolPct: number | null): string => {
  if (dailyVolPct === null) return 'Unknown';
  if (dailyVolPct < 2) return 'Low volatility';
  if (dailyVolPct < 4) return 'Normal volatility';
  if (dailyVolPct < 7) return 'High volatility';
  return 'Extreme volatility';
};

export const volumeSignal = (ratio: number | null): string => {
  if (ratio === null) return 'Unknown';
  if (ratio < 1.0) return 'Normal';
  if (ratio < 1.5) return 'Mild increase';
  if (ratio < 2.5) return 'Strong increase';
  if (ratio < 5.0) return 'Breakout volume';
  return 'Extreme volume';
};

/** Alt/BTC relative-strength signal from a relative return spread (%). SRS §4.7. */
export const relativeStrengthSignal = (spreadPct: number | null): string => {
  if (spreadPct === null) return 'Unknown';
  if (spreadPct < -20) return 'Very weak vs BTC';
  if (spreadPct < -5) return 'Weak vs BTC';
  if (spreadPct <= 5) return 'Neutral';
  if (spreadPct <= 20) return 'Strong vs BTC';
  return 'Very strong vs BTC';
};

/** Convert a CoinGecko market_chart `prices` array to a plain close series. */
export const closesFromChart = (prices: [number, number][]): number[] => prices.map(([, price]) => price);
export const volumesFromChart = (vols: [number, number][]): number[] => vols.map(([, v]) => v);

/** Clamp any raw value into 0–100 for use as a score component. */
export const clamp01to100 = (value: number): number => Math.max(0, Math.min(100, value));
