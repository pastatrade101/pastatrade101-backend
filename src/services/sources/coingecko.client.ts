import { coingecko, env } from '../../config/env';
import { cached } from '../../utils/cache';
import { fetchJson } from './http';

// ── Shared header + URL builder ──────────────────────────────────────────
const headers = (): Record<string, string> =>
  coingecko.hasKey ? { [coingecko.headerName]: coingecko.apiKey } : {};

const url = (path: string, params: Record<string, string | number | boolean> = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  const query = search.toString();
  return `${coingecko.baseUrl}${path}${query ? `?${query}` : ''}`;
};

// ── Response shapes (only the fields we use) ─────────────────────────────
export interface CgGlobal {
  data: {
    total_market_cap: Record<string, number>;
    total_volume: Record<string, number>;
    market_cap_percentage: Record<string, number>;
    market_cap_change_percentage_24h_usd: number;
  };
}

export interface CgMarketCoin {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  total_volume: number | null;
  circulating_supply: number | null;
  total_supply: number | null;
  ath: number | null;
  ath_date: string | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_30d_in_currency?: number | null;
}

export interface CgMarketChart {
  prices: [number, number][];
  market_caps: [number, number][];
  total_volumes: [number, number][];
}

// ── Endpoints ────────────────────────────────────────────────────────────
export const getGlobal = () =>
  cached('cg:global', () => fetchJson<CgGlobal>(url('/global'), { headers: headers(), label: 'CoinGecko /global' }));

/** Top coins by market cap, with 24h/7d/30d change baked in. `page` is 1-based, ≤250 per page. */
export const getMarkets = (page = 1, perPage = 250) =>
  cached(
    `cg:markets:${page}:${perPage}`,
    () =>
      fetchJson<CgMarketCoin[]>(
        url('/coins/markets', {
          vs_currency: 'usd',
          order: 'market_cap_desc',
          per_page: perPage,
          page,
          sparkline: false,
          price_change_percentage: '24h,7d,30d'
        }),
        { headers: headers(), label: 'CoinGecko /coins/markets' }
      ),
    60
  );

/** Daily OHLC-ish market chart for one coin. `days` up to 365 on the free tier. */
export const getMarketChart = (coingeckoId: string, days = 90) =>
  cached(
    `cg:chart:${coingeckoId}:${days}`,
    () =>
      fetchJson<CgMarketChart>(
        url(`/coins/${coingeckoId}/market_chart`, { vs_currency: 'usd', days, interval: 'daily' }),
        { headers: headers(), label: `CoinGecko /market_chart/${coingeckoId}` }
      ),
    600
  );

export const coingeckoThrottleMs = env.COINGECKO_THROTTLE_MS;
