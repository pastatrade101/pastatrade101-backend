import { supabase } from '../../config/supabase';
import { getFearGreedHistory } from '../sources/alternativeme.client';
import { ONCHAIN_KEYS } from '../sources/bgeometrics.client';
import type { DailyPoint } from '../sources/blockchaincom.client';
import { getBtcPriceHistory } from '../sources/blockchaincom.client';
import { getBitcoinWikipediaViews } from '../sources/wikimedia.client';
import {
  alignToDates,
  buildMetricRows,
  logRegressionResidual,
  mayerMultipleSeries,
  normalizeMinMax,
  runningAthRatio,
  rsiSeries,
  type Nullable,
  type RiskMetricRow
} from '../scoring/risk';

type Category = 'price' | 'social' | 'onchain';

// Persist rows from this date on (the regression FIT still uses full history).
// Keeps the table rich for the slider without storing sub-dollar 2010 noise.
const STORE_FROM = '2012-01-01';

const CATEGORY: Record<string, Category> = {
  log_regression: 'price',
  mayer_multiple: 'price',
  price_drawdown: 'price',
  rsi_risk: 'price',
  fear_greed: 'price',
  wikipedia_views: 'social',
  // On-chain (BGeometrics) — higher value = closer to a cycle top = higher risk.
  mvrv_zscore: 'onchain',
  puell_multiple: 'onchain',
  nupl: 'onchain',
  reserve_risk: 'onchain'
};
const CATEGORIES: Category[] = ['price', 'social', 'onchain'];

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

// On-chain raw values live in risk_metric_daily (written by the dedicated
// on-chain sync). Risk rebuilds read them from the DB instead of hitting
// BGeometrics, so the quota is only spent by the explicit on-chain sync.
const readStoredOnchainRaw = async (): Promise<Record<string, DailyPoint[]>> => {
  const out: Record<string, DailyPoint[]> = Object.fromEntries(ONCHAIN_KEYS.map((k) => [k, [] as DailyPoint[]]));
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('risk_metric_daily')
      .select('snapshot_date, metric_key, raw_value')
      .in('metric_key', ONCHAIN_KEYS)
      .order('snapshot_date', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error || !data?.length) break;
    for (const r of data) {
      if (r.raw_value == null) continue;
      out[r.metric_key]?.push({ date: r.snapshot_date as string, value: Number(r.raw_value) });
    }
    if (data.length < CHUNK) break;
  }
  return out;
};

const upsertChunked = async (
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  size = 1000
): Promise<void> => {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (error) throw new Error(`Failed upserting ${table}: ${error.message}`);
  }
};

/**
 * Recompute the full risk history from free sources and persist metric/category/
 * summary rows. Returns the number of metric rows written.
 */
export const syncRisk = async (): Promise<number> => {
  const [btc, fng, wiki, onchain] = await Promise.all([
    getBtcPriceHistory(),
    getFearGreedHistory().catch(() => []),
    getBitcoinWikipediaViews().catch(() => []),
    readStoredOnchainRaw().catch(() => ({}) as Record<string, DailyPoint[]>)
  ]);

  if (btc.length < 250) throw new Error('Insufficient BTC history from blockchain.com.');

  const dates = btc.map((p) => p.date);
  const closes = btc.map((p) => p.value);

  // ── raw series per metric ──
  const logResid = logRegressionResidual(closes);
  const mayer = mayerMultipleSeries(closes, 200);
  const athRatio = runningAthRatio(closes);
  const rsi = rsiSeries(closes, 14);
  const fngRaw = alignToDates(dates, fng); // 0..100
  const wikiRaw = alignToDates(dates, wiki); // pageviews
  // On-chain raw series aligned to the BTC date axis (missing → null).
  const onchainRaw: Record<string, Nullable[]> = Object.fromEntries(
    Object.keys(CATEGORY)
      .filter((k) => CATEGORY[k] === 'onchain')
      .map((k) => [k, alignToDates(dates, onchain[k] ?? [])])
  );

  // ── normalize each into 0..1 risk ──
  const risk: Record<string, Nullable[]> = {
    log_regression: normalizeMinMax(logResid),
    mayer_multiple: normalizeMinMax(mayer),
    price_drawdown: normalizeMinMax(athRatio), // near ATH → near 1 → high risk
    rsi_risk: rsi.map((v) => (v === null ? null : v / 100)),
    fear_greed: fngRaw.map((v) => (v === null ? null : v / 100)), // greed → high risk
    wikipedia_views: normalizeMinMax(wikiRaw.map((v) => (v === null ? null : Math.log(v + 1)))),
    // Each on-chain metric: higher reading → higher cycle risk → min-max to 0..1.
    ...Object.fromEntries(Object.entries(onchainRaw).map(([k, series]) => [k, normalizeMinMax(series)]))
  };
  const rawByMetric: Record<string, Nullable[]> = {
    log_regression: logResid,
    mayer_multiple: mayer,
    price_drawdown: athRatio,
    rsi_risk: rsi,
    fear_greed: fngRaw,
    wikipedia_views: wikiRaw,
    ...onchainRaw
  };

  // ── flatten into metric rows (filtered to STORE_FROM) ──
  const metricRows: RiskMetricRow[] = [];
  for (const key of Object.keys(CATEGORY)) {
    metricRows.push(
      ...buildMetricRows(key, dates, rawByMetric[key], risk[key]).filter((r) => r.date >= STORE_FROM)
    );
  }

  // ── aggregate category + summary per day ──
  const emptyBucket = (): Record<Category, number[]> => ({ price: [], social: [], onchain: [] });
  const perDay = new Map<string, Record<Category, number[]>>();
  for (const row of metricRows) {
    if (row.risk === null) continue;
    const bucket = perDay.get(row.date) ?? emptyBucket();
    bucket[CATEGORY[row.metric_key]].push(row.risk);
    perDay.set(row.date, bucket);
  }

  // Daily on-chain/social sources lag price by ~1 day, which would leave the most
  // recent days price-only. Carry each category's last value forward up to 7 days
  // so the headline composite keeps blending all available categories.
  const CARRY_DAYS = 7;
  const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
  const lastSeen: Partial<Record<Category, { date: string; value: number }>> = {};

  const categoryRows: Record<string, unknown>[] = [];
  const summaryRows: Record<string, unknown>[] = [];
  for (const date of [...perDay.keys()].sort()) {
    const b = perDay.get(date)!;
    const catAverages: number[] = [];
    for (const category of CATEGORIES) {
      const today = mean(b[category]);
      if (today !== null) lastSeen[category] = { date, value: today };
      const carried = lastSeen[category];
      const value = today !== null ? today : carried && daysBetween(carried.date, date) <= CARRY_DAYS ? carried.value : null;
      if (value !== null) {
        categoryRows.push({ snapshot_date: date, category, risk: value });
        catAverages.push(value);
      }
    }
    const summary = mean(catAverages);
    if (summary !== null) summaryRows.push({ snapshot_date: date, summary_risk: summary });
  }

  // ── persist ──
  const metricDbRows = metricRows.map((r) => ({
    snapshot_date: r.date,
    metric_key: r.metric_key,
    raw_value: r.raw_value,
    risk: r.risk
  }));

  await upsertChunked('risk_metric_daily', metricDbRows, 'snapshot_date,metric_key');
  await upsertChunked('risk_category_daily', categoryRows, 'snapshot_date,category');
  await upsertChunked('risk_summary_daily', summaryRows, 'snapshot_date');

  return metricDbRows.length;
};
