import { env } from '../../config/env';
import { cached } from '../../utils/cache';
import { fetchJson } from './http';
import type { DailyPoint } from './blockchaincom.client';

// BGeometrics / bitcoin-data.com — free Bitcoin on-chain data API.
// Docs: https://bitcoin-data.com  ·  GET /v1/{slug} → full daily history,
// each row { d: 'YYYY-MM-DD', unixTs, <camelField>: number }. The key is
// optional (endpoints work keyless at lower quota). Every call degrades to []
// on failure so the risk sync never breaks.

const BASE = 'https://bitcoin-data.com/v1';

// our risk_metric_defs.key → { url slug, response value field }
const METRICS: Record<string, { slug: string; field: string }> = {
  mvrv_zscore: { slug: 'mvrv-zscore', field: 'mvrvZscore' },
  puell_multiple: { slug: 'puell-multiple', field: 'puellMultiple' },
  nupl: { slug: 'nupl', field: 'nupl' },
  reserve_risk: { slug: 'reserve-risk', field: 'reserveRisk' }
};

export const ONCHAIN_KEYS = Object.keys(METRICS);

interface Row {
  d?: string;
  [field: string]: string | number | undefined;
}

// BGeometrics expects the key in a request header but doesn't publish the exact
// field name; send both common forms (the API honours whichever it recognizes).
const headers = (): Record<string, string> => {
  const key = env.BITCOIN_DATA_API_KEY;
  return key ? { Authorization: `Bearer ${key}`, 'x-api-key': key } : {};
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

/** Full daily history for one on-chain metric. [] on any failure. Cached 12h. */
const getSeries = (key: string): Promise<DailyPoint[]> =>
  cached(
    `bgeo:${key}`,
    () => {
      const def = METRICS[key];
      return def ? fetchSlug(def.slug, def.field) : Promise.resolve([]);
    },
    12 * 3600
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

/** BTC amounts in profit and in loss (full daily history). Cached 12h. */
export const getSupplyProfitLoss = (): Promise<{ profit: DailyPoint[]; loss: DailyPoint[] }> =>
  cached(
    'bgeo:supply-profit-loss',
    async () => {
      const [profit, loss] = await Promise.all([
        fetchSlug(SUPPLY.profit.slug, SUPPLY.profit.field),
        fetchSlug(SUPPLY.loss.slug, SUPPLY.loss.field)
      ]);
      return { profit, loss };
    },
    12 * 3600
  );
