import { supabase } from '../../config/supabase';
import { env } from '../../config/env';
import { AppError } from '../../utils/api-response';
import { getOnchainSeries, ONCHAIN_KEYS } from '../sources/bgeometrics.client';
import { syncRisk } from './sync-risk';
import { syncSupplyProfitLoss } from './supply-profit-loss.service';

const STORE_FROM = '2012-01-01';

// The ONLY place that calls the BGeometrics API. It stores the raw on-chain
// values, then recomputes the composite via syncRisk (which reads those stored
// values — so risk rebuilds never spend the API quota). Graceful + transparent:
// a rate-limited fetch with no prior data fails loudly so the admin panel shows
// why; otherwise it falls back to the stored values.
export const syncOnchain = async (): Promise<number> => {
  const series = await getOnchainSeries();
  const fetched = Object.values(series).reduce((s, arr) => s + arr.length, 0);

  if (fetched > 0) {
    const rows: { snapshot_date: string; metric_key: string; raw_value: number }[] = [];
    for (const key of ONCHAIN_KEYS) {
      for (const p of series[key] ?? []) {
        if (p.date >= STORE_FROM && Number.isFinite(p.value)) rows.push({ snapshot_date: p.date, metric_key: key, raw_value: p.value });
      }
    }
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await supabase.from('risk_metric_daily').upsert(rows.slice(i, i + 1000), { onConflict: 'snapshot_date,metric_key' });
      if (error) throw new AppError('Failed to store on-chain raw values.', 500, [error]);
    }
  } else {
    // Nothing fetched — only acceptable if we already have stored data to reuse.
    const { count } = await supabase.from('risk_metric_daily').select('metric_key', { count: 'exact', head: true }).in('metric_key', ONCHAIN_KEYS);
    if (!count) {
      throw new AppError(
        'BGeometrics returned no data — likely the keyless rate limit (10 req/hour). Add BITCOIN_DATA_API_KEY or retry next hour.',
        502
      );
    }
  }

  // Supply in Profit/Loss shares this sync (2 more BGeometrics calls). Failure
  // here must not break the core on-chain composite, so it's best-effort.
  await syncSupplyProfitLoss().catch((err) =>
    console.warn('[onchain] supply profit/loss sync failed:', err instanceof Error ? err.message : err)
  );

  // Recompute the composite from the stored on-chain raw values.
  await syncRisk();
  const { count } = await supabase
    .from('risk_metric_daily')
    .select('metric_key', { count: 'exact', head: true })
    .in('metric_key', ONCHAIN_KEYS)
    .not('risk', 'is', null);
  return count ?? 0;
};

interface OnchainStatus {
  provider: string;
  base_url: string;
  key_mode: 'keyed' | 'keyless';
  last_synced: string | null;
  days_covered: number;
  metrics: string[];
  latest: Record<string, { raw: number | null; risk: number | null }>;
  last_job: Record<string, unknown> | null;
  supply_profit_loss: { last_synced: string | null; days_covered: number; profit_percent: number | null; loss_percent: number | null } | null;
}

// Provider + freshness status for the admin panel — all read from the DB, so it
// adds zero upstream requests.
export const getOnchainStatus = async (): Promise<OnchainStatus> => {
  const { data: latestDate } = await supabase
    .from('risk_metric_daily')
    .select('snapshot_date')
    .in('metric_key', ONCHAIN_KEYS)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastSynced = latestDate?.snapshot_date ?? null;

  const latest: OnchainStatus['latest'] = {};
  if (lastSynced) {
    const { data: rows } = await supabase.from('risk_metric_daily').select('metric_key, raw_value, risk').eq('snapshot_date', lastSynced).in('metric_key', ONCHAIN_KEYS);
    for (const r of rows ?? []) latest[r.metric_key] = { raw: r.raw_value, risk: r.risk };
  }

  const [{ count: covered }, { data: job }, { count: splCovered }, { data: splLatest }] = await Promise.all([
    supabase.from('risk_category_daily').select('snapshot_date', { count: 'exact', head: true }).eq('category', 'onchain'),
    supabase.from('sync_jobs').select('status, error, records_processed, started_at, finished_at').eq('job_type', 'onchain').order('started_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('btc_supply_profit_loss').select('id', { count: 'exact', head: true }),
    supabase.from('btc_supply_profit_loss').select('date, supply_in_profit_percent, supply_in_loss_percent').order('date', { ascending: false }).limit(1).maybeSingle()
  ]);

  return {
    provider: 'BGeometrics',
    base_url: 'https://bitcoin-data.com',
    key_mode: env.BITCOIN_DATA_API_KEY ? 'keyed' : 'keyless',
    last_synced: lastSynced,
    days_covered: covered ?? 0,
    metrics: ONCHAIN_KEYS,
    latest,
    last_job: job ?? null,
    supply_profit_loss: splCovered
      ? {
          last_synced: splLatest?.date ?? null,
          days_covered: splCovered,
          profit_percent: splLatest?.supply_in_profit_percent ?? null,
          loss_percent: splLatest?.supply_in_loss_percent ?? null
        }
      : null
  };
};
