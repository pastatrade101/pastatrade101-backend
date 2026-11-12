import { env } from '../../config/env';
import { cacheGet, cacheSet } from '../../utils/cache';
import { fetchJson } from './http';
import type { DailyPoint } from './blockchaincom.client';

// BGeometrics / bitcoin-data.com — Bitcoin on-chain data API.
// Docs: https://api.bitcoin-data.com/scalar.html  ·  GET /v1/{slug} → daily
// history, each row { d: 'YYYY-MM-DD', unixTs, <camelField>: number }.
// Free plan (what the key is on): 10 requests/hour, 15/day, last 4 years only,
// and the "Market" and "Net" groups (MVRV, NUPL — and Puell in practice) hold
// back the latest 7 days. That lag is the plan, not a broken feed. Indicators
// update daily at 03:00 UTC. Every call degrades to [] on failure so the risk
// sync never breaks.

const BASE = 'https://api.bitcoin-data.com/v1';

// our risk_metric_defs.key → { url slug, response value field }
const METRICS: Record<string, { slug: string; field: string }> = {
  mvrv_zscore: { slug: 'mvrv-zscore', field: 'mvrvZscore' },
  puell_multiple: { slug: 'puell-multiple', field: 'puellMultiple' },
  nupl: { slug: 'nupl', field: 'nupl' },
  reserve_risk: { slug: 'reserve-risk', field: 'reserveRisk' },
  rhodl_ratio: { slug: 'rhodl-ratio', field: 'rhodlRatio' }
};

export const ONCHAIN_KEYS = Object.keys(METRICS);

/** Metrics the free plan publishes 7 days late (seen on 2026-11-12: last value = today − 7). */
export const ONCHAIN_DELAYED_KEYS = ['mvrv_zscore', 'puell_multiple', 'nupl'];

interface Row {
  d?: string;
  [field: string]: string | number | undefined;
}

// The docs: "Authorization: Bearer <token>" (or ?token=…).
const headers = (): Record<string, string> => {
  const key = env.BITCOIN_DATA_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
};

// The data changes once a day (03:00 UTC), and the free quota is 15 calls a
// day, so keep a good answer until shortly after the next update. An empty
// answer (429, network) is NOT kept, so the next scheduled run tries again.
const secondsUntilNextUpdate = (now = new Date()): number => {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 15));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return Math.max(600, Math.round((next.getTime() - now.getTime()) / 1000));
};
const dailyCached = async <T>(key: string, load: () => Promise<T>, isEmpty: (v: T) => boolean): Promise<T> => {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await load();
  if (!isEmpty(value)) cacheSet(key, value, secondsUntilNextUpdate());
  return value;
};

/** Full daily history for one bitcoin-data.com slug. [] on any failure. */
const fetchSlug = async (slug: string, field: string): Promise<DailyPoint[]> => {
  try {
    // No retries: a 429 is a quota window, not a transient blip — retrying
    // just burns more of the free hourly/daily allowance.
    const rows = await fetchJson<Row[]>(`${BASE}/${slug}`, { headers: headers(), label: `bitcoin-data ${slug}`, retries: 0 });
    return (rows ?? [])
      .map((r) => ({ date: String(r.d ?? ''), value: Number(r[field]) }))
      .filter((p) => p.date.length === 10 && Number.isFinite(p.value));
  } catch (err) {
    console.warn(`[bgeometrics] ${slug} fetch failed (rate limit / network?):`, err instanceof Error ? err.message : err);
    return [];
  }
};

/** Daily history for one on-chain metric. [] on any failure. Kept until the next daily update. */
const getSeries = (key: string): Promise<DailyPoint[]> =>
  dailyCached(
    `bgeo:${key}`,
    () => {
      const def = METRICS[key];
      return def ? fetchSlug(def.slug, def.field) : Promise.resolve([]);
    },
    (v) => v.length === 0
  );

/** All configured on-chain metrics keyed by our metric key. */
export const getOnchainSeries = async (): Promise<Record<string, DailyPoint[]>> => {
  const entries = await Promise.all(ONCHAIN_KEYS.map(async (k) => [k, await getSeries(k)] as const));
  return Object.fromEntries(entries);
};

// ── Supply in Profit / Loss (BTC last-moved-price profitability) ──
// supply-profit → supplyProfitBtc, supply-loss → supplyLossBtc (both in BTC).
const SUPPLY = {
  profit: { slug: 'supply-profit', field: 'supplyProfitBtc' },
  loss: { slug: 'supply-loss', field: 'supplyLossBtc' }
} as const;

/** BTC amounts in profit and in loss (daily history). Kept until the next daily update. */
export const getSupplyProfitLoss = (): Promise<{ profit: DailyPoint[]; loss: DailyPoint[] }> =>
  dailyCached(
    'bgeo:supply-profit-loss',
    async () => {
      const [profit, loss] = await Promise.all([
        fetchSlug(SUPPLY.profit.slug, SUPPLY.profit.field),
        fetchSlug(SUPPLY.loss.slug, SUPPLY.loss.field)
      ]);
      return { profit, loss };
    },
    (v) => v.profit.length === 0 || v.loss.length === 0
  );
