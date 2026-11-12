import { env } from '../../config/env';
import { cacheGet, cacheSet } from '../../utils/cache';
import { fetchJson } from './http';
import type { DailyPoint } from './blockchaincom.client';

// BGeometrics / bitcoin-data.com — Bitcoin on-chain data API.
// Docs: https://api.bitcoin-data.com/scalar.html  ·  GET /v1/{slug} → daily
// history, each row { d: 'YYYY-MM-DD', unixTs, <camelField>: number }.
// Plans: the account is on Advanced (200 requests/hour, 300/day, at most 5
// distinct IPs a day, full history, real-time). A key on the Free plan gets
// 15 calls/day, only the last 4 years, and the "Market" and "Net" groups
// (MVRV, NUPL — and Puell in practice) 7 days late; the admin page flags that
// lag. Indicators update daily at 03:00 UTC. Every call degrades to [] on
// failure so the risk sync never breaks.

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

interface Row {
  d?: string;
  [field: string]: string | number | undefined;
}

// The docs: "Authorization: Bearer <token>" (or ?token=…).
const headers = (): Record<string, string> => {
  const key = env.BITCOIN_DATA_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
};

// The data changes once a day (03:00 UTC), so keep a good answer until shortly
// after the next update (one round of calls a day, well inside any plan). An empty
// answer (429, network) is NOT kept, so the next scheduled run tries again.
const secondsUntilNextUpdate = (now = new Date()): number => {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 15));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return Math.max(600, Math.round((next.getTime() - now.getTime()) / 1000));
};
// Callers that ask for the same key at the same moment share one request.
const inflight = new Map<string, Promise<unknown>>();
const shared = <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
};
const dailyCached = async <T>(key: string, load: () => Promise<T>, isEmpty: (v: T) => boolean): Promise<T> => {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  return shared(key, async () => {
    const value = await load();
    if (!isEmpty(value)) cacheSet(key, value, secondsUntilNextUpdate());
    return value;
  });
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

// ── Market data (Advanced plan): M2, dollar, stablecoins, correlations, derivatives ──
// Generic readers for any /v1/{slug}. Rows come back as-is (numbers are often
// strings, e.g. "0.00003453"), so callers pick fields with `num()`.

export type BgRow = Record<string, unknown> & { d: string };

/** Number from a BGeometrics field ("1.23" or 1.23); null when missing. */
export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const fetchRows = async (path: string): Promise<BgRow[]> => {
  try {
    const rows = await fetchJson<BgRow[]>(`${BASE}/${path}`, { headers: headers(), label: `bitcoin-data ${path.split('?')[0]}`, retries: 0 });
    return Array.isArray(rows) ? rows.filter((r) => typeof r?.d === 'string') : [];
  } catch (err) {
    console.warn(`[bgeometrics] ${path.split('?')[0]} fetch failed:`, err instanceof Error ? err.message : err);
    return [];
  }
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Daily history for a slug, kept until just after the provider's next 03:00 UTC
 * update. `days` limits the window (needed for the big hourly series, which
 * otherwise return every hour since 2020); omit it for the full history.
 */
export const getBgHistory = (slug: string, days?: number): Promise<BgRow[]> => {
  const path = days ? `${slug}?startday=${isoDay(Date.now() - days * 86_400_000)}&endday=${isoDay(Date.now() + 86_400_000)}` : slug;
  return dailyCached(`bgeo:hist:${path}`, () => fetchRows(path), (v) => v.length === 0);
};

/**
 * The last few days of an intraday series (hourly / 8-hourly), kept for an hour
 * — for "right now" readings that move during the day. One call per slug per
 * hour at most.
 */
export const getBgRecent = async (slug: string, days = 3): Promise<BgRow[]> => {
  const path = `${slug}?startday=${isoDay(Date.now() - days * 86_400_000)}&endday=${isoDay(Date.now() + 86_400_000)}`;
  const key = `bgeo:recent:${path}`;
  const hit = cacheGet<BgRow[]>(key);
  if (hit) return hit;
  return shared(key, async () => {
    const rows = await fetchRows(path);
    if (rows.length) cacheSet(key, rows, 3600);
    return rows;
  });
};

/** The latest reading of a slug (/v1/{slug}/last), kept for an hour. */
export const getBgLast = async (slug: string): Promise<BgRow | null> => {
  const key = `bgeo:last:${slug}`;
  const hit = cacheGet<BgRow>(key);
  if (hit) return hit;
  try {
    const row = await fetchJson<BgRow>(`${BASE}/${slug}/last`, { headers: headers(), label: `bitcoin-data ${slug}/last`, retries: 0 });
    if (row && typeof row.d === 'string') {
      cacheSet(key, row, 3600);
      return row;
    }
  } catch (err) {
    console.warn(`[bgeometrics] ${slug}/last fetch failed:`, err instanceof Error ? err.message : err);
  }
  return null;
};
