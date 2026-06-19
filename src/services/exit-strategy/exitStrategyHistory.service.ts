import { supabase } from '../../config/supabase';
import { readSeries } from '../series/store';
import { getProfile } from './exitStrategySettings.service';

// History backfilled from the stored daily risk components (BTC risk + on-chain +
// social categories) — enough to show when Exit Risk was historically high. The
// live score also blends altcoin breadth + cycle extension, which aren't kept as
// dense daily series, so history is a faithful approximation of the regime.

export interface ExitHistoryPoint {
  date: string;
  exit_risk: number;
  btc_price: number | null;
  btc_risk: number | null;
  onchain_risk: number | null;
  social_risk: number | null;
}
export interface PastZone {
  threshold: number;
  start: string;
  end: string;
  peak_risk: number;
  price_min: number | null;
  price_max: number | null;
  days: number;
}

const chunkedRead = async <T>(table: string, select: string, filter?: { col: string; val: string }): Promise<T[]> => {
  const out: T[] = [];
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    let q = supabase.from(table).select(select).order('snapshot_date', { ascending: true }).range(from, from + CHUNK - 1);
    if (filter) q = q.eq(filter.col, filter.val);
    const { data, error } = await q;
    if (error || !data?.length) break;
    out.push(...(data as T[]));
    if (data.length < CHUNK) break;
  }
  return out;
};

export const computeExitHistory = async (): Promise<{ series: ExitHistoryPoint[]; zones: PastZone[] }> => {
  const profile = await getProfile();
  const w = profile.weights;
  // Renormalise over the daily-available components.
  const wb = w.btc;
  const wo = w.onchain;
  const ws = w.social;

  const [summary, onchainCat, social, btc] = await Promise.all([
    chunkedRead<{ snapshot_date: string; summary_risk: number | null }>('risk_summary_daily', 'snapshot_date, summary_risk'),
    chunkedRead<{ snapshot_date: string; risk: number | null }>('risk_category_daily', 'snapshot_date, risk', { col: 'category', val: 'onchain' }),
    // Social Risk comes from the Social Metrics module (its own daily table).
    supabase
      .from('btc_social_metrics')
      .select('date, social_risk_score')
      .order('date', { ascending: true })
      .then(({ data }) => (data ?? []) as { date: string; social_risk_score: number | null }[]),
    readSeries('btc-full')
  ]);

  const onMap = new Map(onchainCat.map((r) => [r.snapshot_date, r.risk == null ? null : Number(r.risk)]));
  const soMap = new Map(social.map((r) => [r.date, r.social_risk_score == null ? null : Number(r.social_risk_score)]));
  const priceMap = new Map(btc.map((p) => [p.date, p.value]));

  const series: ExitHistoryPoint[] = [];
  for (const row of summary) {
    if (row.summary_risk == null) continue;
    const btcRisk = Number(row.summary_risk);
    const oc = onMap.get(row.snapshot_date) ?? null;
    const so = soMap.get(row.snapshot_date) ?? null;
    const parts: { w: number; v: number }[] = [{ w: wb, v: btcRisk }];
    if (oc != null) parts.push({ w: wo, v: oc });
    if (so != null) parts.push({ w: ws, v: so });
    const tot = parts.reduce((s, p) => s + p.w, 0) || 1;
    const exit = parts.reduce((s, p) => s + p.w * p.v, 0) / tot;
    series.push({
      date: row.snapshot_date,
      exit_risk: Number(Math.max(0, Math.min(1, exit)).toFixed(3)),
      btc_price: priceMap.get(row.snapshot_date) ?? null,
      btc_risk: btcRisk,
      onchain_risk: oc,
      social_risk: so
    });
  }

  // Past high-risk zones (contiguous runs above each threshold).
  const zones: PastZone[] = [];
  for (const threshold of [0.7, 0.8, 0.9]) {
    let run: ExitHistoryPoint[] = [];
    const flush = () => {
      if (run.length >= 3) {
        const prices = run.map((r) => r.btc_price).filter((p): p is number => p != null);
        zones.push({
          threshold,
          start: run[0].date,
          end: run[run.length - 1].date,
          peak_risk: Number(Math.max(...run.map((r) => r.exit_risk)).toFixed(3)),
          price_min: prices.length ? Math.round(Math.min(...prices)) : null,
          price_max: prices.length ? Math.round(Math.max(...prices)) : null,
          days: run.length
        });
      }
      run = [];
    };
    for (const p of series) {
      if (p.exit_risk >= threshold) run.push(p);
      else flush();
    }
    flush();
  }
  // Newest first, cap the table.
  zones.sort((a, b) => (a.start < b.start ? 1 : -1));

  return { series, zones: zones.slice(0, 20) };
};
