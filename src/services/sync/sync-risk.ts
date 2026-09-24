import { supabase } from '../../config/supabase';
import { getFearGreedHistory } from '../sources/alternativeme.client';
import { ONCHAIN_KEYS } from '../sources/bgeometrics.client';
import type { DailyPoint } from '../sources/blockchaincom.client';
import { getBtcPriceHistory } from '../sources/blockchaincom.client';
import { getBitcoinWikipediaViews } from '../sources/wikimedia.client';
import {
  alignToDates,
  buildMetricRows,
  carryForward,
  logRegressionResidual,
  mayerMultipleSeries,
  normalizeMinMaxFrom,
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
  // Scale on the published window only. Pre-STORE_FROM days are still computed
  // (the regression fit wants them) but must not set any metric's denominator:
  // 2010-2011 price action produced readings no modern value can approach, and
  // including them flattened those metrics to a constant ~0.
  const scaleFrom = dates.findIndex((d) => d >= STORE_FROM);
  const scaled = (series: Nullable[]) => normalizeMinMaxFrom(series, scaleFrom < 0 ? 0 : scaleFrom);

  const risk: Record<string, Nullable[]> = {
    log_regression: scaled(logResid),
    mayer_multiple: scaled(mayer),
    price_drawdown: scaled(athRatio), // near ATH → near 1 → high risk
    rsi_risk: rsi.map((v) => (v === null ? null : v / 100)),
    fear_greed: fngRaw.map((v) => (v === null ? null : v / 100)), // greed → high risk
    wikipedia_views: scaled(wikiRaw.map((v) => (v === null ? null : Math.log(v + 1)))),
    // Each on-chain metric: higher reading → higher cycle risk → min-max to 0..1.
    ...Object.fromEntries(Object.entries(onchainRaw).map(([k, series]) => [k, scaled(series)]))
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
  // Carry each metric's own last reading forward, rather than each category's.
  // Feeds go stale independently, so a metric routinely vanishes from a day: the
  // on-chain trio stopped reporting after 2026-09-16 while price kept updating.
  // Per-category carry never covered that, because the category still had one
  // live metric — so its value silently became "whatever is left", and the
  // composite lurched on the feed, not the market. (The 2026-09-17 dip to 0.177
  // was exactly this.) Stored metric rows stay untouched: only the aggregation
  // sees carried values, so the UI never displays a reading that never arrived.
  const CARRY_DAYS = 7;
  const carriedRisk: Record<string, Nullable[]> = Object.fromEntries(
    Object.keys(CATEGORY).map((key) => [key, carryForward(risk[key] ?? [], CARRY_DAYS)])
  );

  const emptyBucket = (): Record<Category, number[]> => ({ price: [], social: [], onchain: [] });
  const perDay = new Map<string, Record<Category, number[]>>();
  dates.forEach((date, i) => {
    if (date < STORE_FROM) return;
    const bucket = emptyBucket();
    let any = false;
    for (const key of Object.keys(CATEGORY)) {
      const value = carriedRisk[key]?.[i];
      if (value === null || value === undefined) continue;
      bucket[CATEGORY[key]].push(value);
      any = true;
    }
    if (any) perDay.set(date, bucket);
  });

  const categoryRows: Record<string, unknown>[] = [];
  const summaryRows: Record<string, unknown>[] = [];
  for (const date of [...perDay.keys()].sort()) {
    const b = perDay.get(date)!;
    // Weight each category by how many metrics stand behind it, rather than
    // giving all three an equal third. Equal thirds handed 33% of the headline
    // to `social` (one metric: Wikipedia pageviews, a series that has decayed
    // structurally and no longer rises) and another 33% to `onchain`, so a real
    // move across the five price metrics was diluted threefold against two
    // near-static readings. Count-weighting makes the composite the plain
    // average of the metrics that exist, and lets a category regain influence
    // automatically as its feeds come back.
    let weighted = 0;
    let totalWeight = 0;
    for (const category of CATEGORIES) {
      const value = mean(b[category]);
      if (value === null) continue;
      categoryRows.push({ snapshot_date: date, category, risk: value });
      weighted += value * b[category].length;
      totalWeight += b[category].length;
    }
    if (totalWeight > 0) summaryRows.push({ snapshot_date: date, summary_risk: weighted / totalWeight });
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
