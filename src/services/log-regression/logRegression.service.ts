import { supabase } from '../../config/supabase';
import { readSeries } from '../series/store';
import { ASSET_IDS, getSettings, type AssetSymbol, type LogRegressionSettings } from './logRegressionSettings.service';

// ─────────────────────────────────────────────────────────────────────────────
// Pastatrade Logarithmic Regression Bands — fits ln(price) = a + b·ln(days) over
// an asset's full daily history, then draws value / fair / elevated / bubble
// bands around the regression fit. Historical model — NOT a price prediction and
// NOT a reproduction of any proprietary external model.
// ─────────────────────────────────────────────────────────────────────────────

export interface RegressionPoint {
  date: string;
  price_usd: number;
  days_since_start: number;
  fit_price: number;
  lower_band: number;
  upper_band: number;
  bubble_lower_band: number;
  bubble_upper_band: number;
  distance_from_fit_percent: number;
  risk_score: number;
  zone_label: string;
}

export interface RegressionResult {
  asset_symbol: AssetSymbol;
  asset_id: string;
  fitting_method: string;
  source: 'csv' | 'series';
  start_date: string | null;
  // A long-term log regression is only meaningful with enough multi-cycle history
  // AND an upward slope. Short/downtrending windows invert the bands — we flag
  // that here so the UI shows the price only (never misleading decaying bands).
  fit_valid: boolean;
  fit_note: string;
  history_years: number;
  points: RegressionPoint[];
  latest: RegressionPoint | null;
}

// Minimum history span for a trustworthy long-term fit (~3 years).
const MIN_FIT_DAYS = 1095;
// A continuous daily history shouldn't have multi-month holes; a big internal gap
// (e.g. a partial CSV stitched to a recent series) makes the fit unreliable.
const MAX_GAP_DAYS = 120;

const DAY = 86_400_000;

// Price history MERGED from two sources so we always get the widest coverage:
//  • asset_daily_prices — CSV-imported history (often the early years), and
//  • the platform series store (btc-full / cg:ethereum) — typically the recent
//    window the platform syncs.
// Imported rows win on overlapping dates. A partial CSV (e.g. 2015–2018) is thus
// combined with the recent series rather than replacing it.
// Page through asset_daily_prices — Supabase caps a single select at 1000 rows,
// and a full history is several thousand days.
const loadCsvRows = async (asset: AssetSymbol): Promise<{ date: string; price_usd: number }[]> => {
  const out: { date: string; price_usd: number }[] = [];
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('asset_daily_prices')
      .select('date, price_usd')
      .eq('asset_symbol', asset)
      .order('date', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error || !data?.length) break;
    out.push(...(data as { date: string; price_usd: number }[]));
    if (data.length < CHUNK) break;
  }
  return out;
};

const loadPrices = async (asset: AssetSymbol): Promise<{ points: { date: string; price: number }[]; source: 'csv' | 'series' }> => {
  const key = asset === 'BTC' ? 'btc-full' : 'cg:ethereum';
  const [data, series] = await Promise.all([loadCsvRows(asset), readSeries(key)]);
  const csv = data.map((r) => ({ date: r.date, price: Number(r.price_usd) })).filter((p) => p.price > 0);
  const seriesPts = series.filter((p) => p.value > 0).map((p) => ({ date: p.date, price: p.value }));
  if (!csv.length) return { points: seriesPts, source: 'series' };

  const byDate = new Map<string, number>();
  for (const p of seriesPts) byDate.set(p.date, p.price);
  for (const p of csv) byDate.set(p.date, p.price); // imported data overrides on overlap
  const merged = [...byDate.entries()].map(([date, price]) => ({ date, price })).sort((a, b) => a.date.localeCompare(b.date));
  return { points: merged, source: 'csv' };
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
// Keep small positive values intact — early-history fit/bands can be sub-cent,
// and rounding them to 0.00 produces zeros that break a log price axis.
const round = (n: number, d = 2) => {
  if (!Number.isFinite(n)) return n;
  if (n !== 0 && Math.abs(n) < 1) return Number(n.toPrecision(4));
  return Number(n.toFixed(d));
};

const zoneFor = (price: number, fit: number, lower: number, upper: number, bubbleLo: number, bubbleHi: number): string => {
  if (price < lower) return 'Deep value';
  if (price < fit * 0.9) return 'Low-risk zone';
  if (price <= fit * 1.1) return 'Fair value';
  if (price <= upper) return 'Moderate risk';
  if (price < bubbleLo) return 'Elevated risk';
  if (price <= bubbleHi) return 'Bubble risk';
  return 'Extreme overheating';
};

// Continuous, monotonic 0–1 risk based on where price sits across the bands.
const riskFor = (price: number, fit: number, lower: number, upper: number, bubbleLo: number, bubbleHi: number): number => {
  const seg = (v: number, a: number, b: number, lo: number, hi: number) => lo + (hi - lo) * clamp01((v - a) / (b - a || 1));
  let r: number;
  if (price < lower) r = 0.2 * clamp01(price / (lower || 1));
  else if (price < fit) r = seg(price, lower, fit, 0.2, 0.45);
  else if (price <= upper) r = seg(price, fit, upper, 0.45, 0.65);
  else if (price < bubbleLo) r = seg(price, upper, bubbleLo, 0.65, 0.8);
  else if (price <= bubbleHi) r = seg(price, bubbleLo, bubbleHi, 0.8, 0.95);
  else r = 0.95 + 0.05 * clamp01((price - bubbleHi) / (bubbleHi || 1));
  return round(clamp01(r), 3);
};

export const computeLogRegression = async (asset: AssetSymbol, settingsOverride?: LogRegressionSettings): Promise<RegressionResult> => {
  const settings = settingsOverride ?? (await getSettings(asset));
  const { points: raw, source } = await loadPrices(asset);

  // Optional start-date floor (e.g. ignore illiquid pre-history).
  const startFloor = settings.start_date ? Date.parse(`${settings.start_date}T00:00:00Z`) : null;
  const prices = (startFloor ? raw.filter((p) => Date.parse(`${p.date}T00:00:00Z`) >= startFloor) : raw).filter((p) => p.price > 0);

  if (prices.length < 30) {
    return { asset_symbol: asset, asset_id: ASSET_IDS[asset], fitting_method: settings.fitting_method, source, start_date: prices[0]?.date ?? null, fit_valid: false, fit_note: 'Not enough price history to fit a regression.', history_years: 0, points: [], latest: null };
  }

  const t0 = Date.parse(`${prices[0].date}T00:00:00Z`);
  // Log-log least-squares fit: x = ln(days_since_start), y = ln(price).
  const xs: number[] = [];
  const ys: number[] = [];
  const days: number[] = [];
  let maxGapDays = 0;
  let gapFrom = '';
  let gapTo = '';
  for (let idx = 0; idx < prices.length; idx += 1) {
    const p = prices[idx];
    const d = Math.max(1, Math.round((Date.parse(`${p.date}T00:00:00Z`) - t0) / DAY) + 1);
    if (idx > 0) {
      const gap = d - days[idx - 1];
      if (gap > maxGapDays) {
        maxGapDays = gap;
        gapFrom = prices[idx - 1].date;
        gapTo = p.date;
      }
    }
    days.push(d);
    xs.push(Math.log(d));
    ys.push(Math.log(p.price));
  }
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) ** 2;
  }
  const b = varx === 0 ? 0 : cov / varx;
  const a = my - b * mx;

  const spanDays = days[days.length - 1];
  const historyYears = Number((spanDays / 365).toFixed(1));
  const gapYears = Number((maxGapDays / 365).toFixed(1));
  const hasBigGap = maxGapDays > MAX_GAP_DAYS;
  const fit_valid = b > 0 && spanDays >= MIN_FIT_DAYS && !hasBigGap;
  const fit_note = fit_valid
    ? ''
    : hasBigGap
      ? `Your imported history has a ${gapYears}-year gap (${gapFrom} → ${gapTo}). The platform only syncs the recent year on its own, so a partial CSV leaves a hole. Upload a continuous ${asset} CSV from 2015 to today (the gap years included) to enable the value and bubble bands.`
      : spanDays < MIN_FIT_DAYS
        ? `Only ${historyYears}y of price history is available — too short for a reliable long-term regression. Import full history (e.g. ${asset === 'ETH' ? 'ETH from 2015' : 'a longer dataset'}) in the admin panel to enable the value and bubble bands.`
        : 'The available history trends down, so the regression slope is not positive. Long-term bands need full multi-cycle history.';

  const { lower_multiplier: lm, upper_multiplier: um, bubble_lower_multiplier: blm, bubble_upper_multiplier: bum } = settings;

  const out: RegressionPoint[] = prices.map((p, i) => {
    const fit = Math.exp(a + b * Math.log(days[i]));
    const lower = fit * lm;
    const upper = fit * um;
    const bubbleLo = fit * blm;
    const bubbleHi = fit * bum;
    return {
      date: p.date,
      price_usd: round(p.price, 2),
      days_since_start: days[i],
      fit_price: round(fit, 2),
      lower_band: round(lower, 2),
      upper_band: round(upper, 2),
      bubble_lower_band: round(bubbleLo, 2),
      bubble_upper_band: round(bubbleHi, 2),
      distance_from_fit_percent: round(((p.price - fit) / fit) * 100, 1),
      risk_score: riskFor(p.price, fit, lower, upper, bubbleLo, bubbleHi),
      zone_label: zoneFor(p.price, fit, lower, upper, bubbleLo, bubbleHi)
    };
  });

  return { asset_symbol: asset, asset_id: ASSET_IDS[asset], fitting_method: settings.fitting_method, source, start_date: prices[0].date, fit_valid, fit_note, history_years: historyYears, points: out, latest: out[out.length - 1] ?? null };
};

const RANGE_DAYS: Record<string, number> = { '1y': 365, '3y': 365 * 3, '5y': 365 * 5, '10y': 365 * 10 };

export const sliceRange = (points: RegressionPoint[], range?: string): RegressionPoint[] => {
  if (!range || range === 'all') return points;
  const days = RANGE_DAYS[range];
  if (!days || !points.length) return points;
  const cutoff = Date.now() - days * DAY;
  return points.filter((p) => Date.parse(`${p.date}T00:00:00Z`) >= cutoff);
};

// Plain-language read for the latest point (probability-style, never a prediction).
export const buildTakeaway = (asset: AssetSymbol, latest: RegressionPoint | null, fitValid = true, fitNote = ''): string => {
  if (!latest) return `No ${asset} price history is available yet for the regression model. Import data in the admin panel.`;
  if (!fitValid) return `The long-term ${asset} regression is not reliable yet. ${fitNote} Until then, only the price line is shown — the value and bubble bands are hidden to avoid a misleading read.`;
  const z = latest.zone_label;
  const dist = latest.distance_from_fit_percent;
  const confirm =
    asset === 'ETH'
      ? 'Because ETH has a shorter history and higher volatility than BTC, confirmation should come from ETH/BTC strength, market trend and broader risk conditions.'
      : 'Confirmation should still come from BTC risk, on-chain metrics and the overall market trend.';
  let body: string;
  if (z === 'Deep value' || z === 'Low-risk zone') {
    body = `${asset} is trading below its regression fair-value line${z === 'Deep value' ? ' and lower value band' : ''}, placing it in a ${z} zone on this model. This suggests ${asset} is not overheated from a long-term perspective and supports a low-to-moderate risk reading. However, this is not a timing signal and does not guarantee short-term upside.`;
  } else if (z === 'Fair value') {
    body = `${asset} is trading close to its regression fair-value line (Fair value, ${dist}% from fit), so the model sees it as roughly neutral on a long-term basis — neither cheap nor overheated.`;
  } else if (z === 'Moderate risk') {
    body = `${asset} is trading above its regression fair-value line (Moderate risk, ${dist}% from fit), so long-term risk is starting to rise. This is not a top, but aggressive buying becomes a little less attractive.`;
  } else if (z === 'Elevated risk') {
    body = `${asset} is trading near its upper regression bands (Elevated risk, ${dist}% from fit), meaning long-term risk is elevated. This does not call an exact top, but it suggests risk management becomes more important.`;
  } else {
    body = `${asset} is inside the model's overheated zone (${z}, ${dist}% from fit). Historically this type of zone has carried higher downside risk. This does not call an exact top, but caution and risk management are more important here.`;
  }
  return `${body} ${confirm}`;
};

/** Persist computed bands (for fast latest reads in reports / exit strategy). */
export const storeLogRegression = async (asset: AssetSymbol): Promise<number> => {
  const r = await computeLogRegression(asset);
  if (!r.points.length) return 0;
  const rows = r.points.map((p) => ({ asset_symbol: asset, asset_id: r.asset_id, ...p, updated_at: new Date().toISOString() }));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase.from('asset_log_regression_bands').upsert(rows.slice(i, i + 1000), { onConflict: 'asset_symbol,date' });
    if (error) throw error;
  }
  return rows.length;
};

/** Latest regression read for an asset — used by reports + exit strategy. Best-effort. */
export const getLatestLogRegression = async (asset: AssetSymbol): Promise<RegressionPoint | null> => {
  try {
    const r = await computeLogRegression(asset);
    return r.latest;
  } catch {
    return null;
  }
};
