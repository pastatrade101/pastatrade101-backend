import { supabase } from '../config/supabase';
import { readSeries } from '../services/series/store';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';

// Resolve the effective snapshot date: the most recent date with data that is
// on or before the requested date (so the slider can land anywhere).
const resolveDate = async (requested: string): Promise<string | null> => {
  const { data } = await supabase
    .from('risk_summary_daily')
    .select('snapshot_date')
    .lte('snapshot_date', requested || '9999-12-31')
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.snapshot_date ?? null;
};

// GET /api/v1/risk/summary?date=YYYY-MM-DD
export const getSummary = asyncHandler(async (req, res) => {
  const date = await resolveDate(getQueryString(req.query, 'date'));
  if (!date) throw new AppError('Risk data is not available yet. Run a risk sync first.', 503);

  const [{ data: summary }, { data: categories }] = await Promise.all([
    supabase.from('risk_summary_daily').select('summary_risk').eq('snapshot_date', date).maybeSingle(),
    supabase.from('risk_category_daily').select('category, risk').eq('snapshot_date', date)
  ]);

  const byCategory = Object.fromEntries((categories ?? []).map((c) => [c.category, c.risk]));

  return sendSuccess(res, 'Risk summary fetched successfully.', {
    as_of: date,
    summary_risk: summary?.summary_risk ?? null,
    categories: {
      price: byCategory.price ?? null,
      onchain: byCategory.onchain ?? null,
      social: byCategory.social ?? null
    }
  });
});

// GET /api/v1/risk/metrics?date=YYYY-MM-DD  → all metric defs merged with that day's risk
export const getMetrics = asyncHandler(async (req, res) => {
  const date = await resolveDate(getQueryString(req.query, 'date'));

  const { data: defs, error } = await supabase
    .from('risk_metric_defs')
    .select('key, label, category, is_weightless, is_premium, sort_order, description')
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true });
  if (error) throw new AppError('Unable to load risk metrics.', 500, [error]);

  const valuesByKey = new Map<string, { raw_value: number | null; risk: number | null }>();
  if (date) {
    const { data: rows } = await supabase
      .from('risk_metric_daily')
      .select('metric_key, raw_value, risk')
      .eq('snapshot_date', date);
    (rows ?? []).forEach((r) => valuesByKey.set(r.metric_key, { raw_value: r.raw_value, risk: r.risk }));
  }

  const merged = (defs ?? []).map((d) => ({
    ...d,
    raw_value: valuesByKey.get(d.key)?.raw_value ?? null,
    risk: valuesByKey.get(d.key)?.risk ?? null
  }));

  // Group into the three table columns the UI renders.
  const group = (category: string) => merged.filter((m) => m.category === category);

  return sendSuccess(res, 'Risk metrics fetched successfully.', {
    as_of: date,
    price: group('price'),
    onchain: group('onchain'),
    social: group('social')
  });
});

// GET /api/v1/risk/metrics/:key/history  → full series for the drill-down chart
export const getMetricHistory = asyncHandler(async (req, res) => {
  const { key } = req.params;
  const { data, error } = await supabase
    .from('risk_metric_daily')
    .select('snapshot_date, raw_value, risk')
    .eq('metric_key', key)
    .order('snapshot_date', { ascending: true });
  if (error) throw new AppError('Unable to load metric history.', 500, [error]);
  return sendSuccess(res, 'Metric history fetched successfully.', { metric_key: key, series: data ?? [] });
});

// ── Risk-vs-price history (for the overlay chart + DCA zone analysis) ──
interface RiskPricePoint {
  date: string;
  risk: number;
  price: number;
}

const readSummarySeries = async (): Promise<{ date: string; risk: number | null }[]> => {
  const out: { date: string; risk: number | null }[] = [];
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('risk_summary_daily')
      .select('snapshot_date, summary_risk')
      .order('snapshot_date', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error) throw new AppError('Unable to load risk history.', 500, [error]);
    if (!data?.length) break;
    out.push(...data.map((r) => ({ date: r.snapshot_date, risk: r.summary_risk })));
    if (data.length < CHUNK) break;
  }
  return out;
};

const getRiskPriceSeries = async (): Promise<RiskPricePoint[]> => {
  const [riskRows, btc] = await Promise.all([readSummarySeries(), readSeries('btc-full')]);
  const priceByDate = new Map(btc.map((p) => [p.date, p.value]));
  return riskRows
    .filter((r) => r.risk != null && priceByDate.has(r.date))
    .map((r) => ({ date: r.date, risk: Number(r.risk), price: priceByDate.get(r.date) as number }));
};

// GET /api/v1/risk/history  → daily { date, risk, btc_price } for the overlay chart
export const getHistory = asyncHandler(async (_req, res) => {
  const series = await getRiskPriceSeries();
  if (!series.length) throw new AppError('Risk history not available. Run a risk sync first.', 503);
  return sendSuccess(res, 'Risk history fetched successfully.', {
    series: series.map((p) => ({ date: p.date, risk: p.risk, btc_price: p.price }))
  });
});

// GET /api/v1/risk/onchain-history  → daily on-chain component risks + composite + BTC price.
// Premium-gated in the route. Values are the normalized 0–1 risk per metric.
const ONCHAIN_KEYS = ['mvrv_zscore', 'puell_multiple', 'nupl', 'reserve_risk'];

const readOnchainMetricRows = async (): Promise<{ snapshot_date: string; metric_key: string; raw_value: number | null; risk: number | null }[]> => {
  const out: { snapshot_date: string; metric_key: string; raw_value: number | null; risk: number | null }[] = [];
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('risk_metric_daily')
      .select('snapshot_date, metric_key, raw_value, risk')
      .in('metric_key', ONCHAIN_KEYS)
      .order('snapshot_date', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error) throw new AppError('Unable to load on-chain history.', 500, [error]);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < CHUNK) break;
  }
  return out;
};

const readOnchainCategoryRows = async (): Promise<{ snapshot_date: string; risk: number | null }[]> => {
  const out: { snapshot_date: string; risk: number | null }[] = [];
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('risk_category_daily')
      .select('snapshot_date, risk')
      .eq('category', 'onchain')
      .order('snapshot_date', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error) throw new AppError('Unable to load on-chain history.', 500, [error]);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < CHUNK) break;
  }
  return out;
};

export const getOnchainHistory = asyncHandler(async (_req, res) => {
  const [metricRows, catRows, btc] = await Promise.all([readOnchainMetricRows(), readOnchainCategoryRows(), readSeries('btc-full')]);

  const priceByDate = new Map(btc.map((p) => [p.date, p.value]));
  const onchainByDate = new Map(catRows.map((r) => [r.snapshot_date, r.risk]));
  const byDate = new Map<string, Record<string, number | null>>();
  for (const r of metricRows) {
    const row = byDate.get(r.snapshot_date) ?? {};
    row[r.metric_key] = r.risk;
    byDate.set(r.snapshot_date, row);
  }

  const series = [...byDate.keys()]
    .sort()
    .map((date) => ({
      date,
      mvrv_zscore: byDate.get(date)?.mvrv_zscore ?? null,
      puell_multiple: byDate.get(date)?.puell_multiple ?? null,
      nupl: byDate.get(date)?.nupl ?? null,
      reserve_risk: byDate.get(date)?.reserve_risk ?? null,
      onchain_risk: onchainByDate.get(date) ?? null,
      btc_price: priceByDate.get(date) ?? null
    }));

  // Latest per-metric raw+risk (date-independent — on-chain lags price by a day,
  // so the cards must not be tied to "today").
  const latestDate = metricRows.length ? metricRows[metricRows.length - 1].snapshot_date : null;
  const latest: Record<string, { raw: number | null; risk: number | null }> = {};
  if (latestDate) for (const r of metricRows) if (r.snapshot_date === latestDate) latest[r.metric_key] = { raw: r.raw_value, risk: r.risk };

  return sendSuccess(res, 'On-chain history fetched successfully.', { series, latest, latest_date: latestDate });
});

// GET /api/v1/risk/dca-zones  → historical periods in the key risk bands + forward returns
const ADD_DAYS = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const bandOf = (r: number): 'aggressive' | 'good' | 'distribution' | null =>
  r < 0.2 ? 'aggressive' : r < 0.4 ? 'good' : r >= 0.8 ? 'distribution' : null;

export const getDcaZones = asyncHandler(async (_req, res) => {
  const series = await getRiskPriceSeries();
  if (series.length < 30) throw new AppError('Not enough history for DCA zones.', 503);

  const priceByDate = new Map(series.map((p) => [p.date, p.price]));
  const priceAt = (d: string): number | null => {
    for (let i = 0; i <= 10; i += 1) {
      const k = ADD_DAYS(d, i);
      if (priceByDate.has(k)) return priceByDate.get(k) as number;
    }
    return null;
  };
  const fwd = (start: string, startPrice: number, days: number): number | null => {
    const p = priceAt(ADD_DAYS(start, days));
    return p ? Number((((p - startPrice) / startPrice) * 100).toFixed(1)) : null;
  };

  const result: Record<'aggressive' | 'good' | 'distribution', unknown[]> = { aggressive: [], good: [], distribution: [] };
  let curBand: 'aggressive' | 'good' | 'distribution' | null = null;
  let seg: RiskPricePoint[] = [];
  const flush = () => {
    if (curBand && seg.length >= 7) {
      const prices = seg.map((s) => s.price);
      const risks = seg.map((s) => s.risk);
      const start = seg[0].date;
      result[curBand].push({
        start,
        end: seg[seg.length - 1].date,
        days: seg.length,
        avg_price: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        risk_min: Number(Math.min(...risks).toFixed(3)),
        risk_max: Number(Math.max(...risks).toFixed(3)),
        fwd_6m: fwd(start, seg[0].price, 180),
        fwd_12m: fwd(start, seg[0].price, 365)
      });
    }
    seg = [];
  };
  for (const p of series) {
    const b = bandOf(p.risk);
    if (b !== curBand) {
      flush();
      curBand = b;
    }
    if (curBand) seg.push(p);
  }
  flush();

  (Object.keys(result) as (keyof typeof result)[]).forEach((k) => (result[k] = result[k].reverse().slice(0, 8)));
  return sendSuccess(res, 'DCA zones fetched successfully.', result);
});

// GET /api/v1/risk/timeline  → min/max dates for the slider bounds
export const getTimeline = asyncHandler(async (_req, res) => {
  const [{ data: first }, { data: last }] = await Promise.all([
    supabase.from('risk_summary_daily').select('snapshot_date').order('snapshot_date', { ascending: true }).limit(1).maybeSingle(),
    supabase.from('risk_summary_daily').select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1).maybeSingle()
  ]);
  return sendSuccess(res, 'Risk timeline fetched successfully.', {
    start: first?.snapshot_date ?? null,
    end: last?.snapshot_date ?? null
  });
});
