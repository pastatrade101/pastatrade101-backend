import { coingecko } from '../../config/env';
import { fetchJson } from './http';

// CoinGecko discovery client for Early Opportunity Radar. Reuses the shared
// Demo/Pro key config (flips to pro-api automatically when COINGECKO_PRO is set).
// Every call is graceful: failure returns null/[] so one source can't break sync.

const headers = (): Record<string, string> => (coingecko.hasKey ? { [coingecko.headerName]: coingecko.apiKey } : {});
const url = (path: string, params: Record<string, string | number | boolean> = {}) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) s.set(k, String(v));
  const q = s.toString();
  return `${coingecko.baseUrl}${path}${q ? `?${q}` : ''}`;
};
const get = async <T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T | null> => {
  try {
    return await fetchJson<T>(url(path, params), { headers: headers(), label: 'coingecko-radar', retries: 2 });
  } catch {
    return null;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CgTrendingItem {
  id: string;
  coin_id?: number;
  name: string;
  symbol: string;
  market_cap_rank: number | null;
  thumb?: string;
  small?: string;
  large?: string;
  data?: {
    price?: number;
    market_cap?: string;
    total_volume?: string;
    price_change_percentage_24h?: { usd?: number };
  };
}

export interface CgCategory {
  id: string;
  name: string;
  market_cap: number | null;
  market_cap_change_24h: number | null;
  volume_24h: number | null;
  top_3_coins?: string[];
}

export interface CgMarketCoin {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  fully_diluted_valuation: number | null;
  total_volume: number | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
}

/** ~15 trending searched coins. */
export const getTrendingCoins = async (): Promise<CgTrendingItem[]> => {
  const d = await get<{ coins: { item: CgTrendingItem }[] }>('/search/trending');
  return (d?.coins ?? []).map((c) => c.item);
};

/** Categories with market data (narrative radar). Free tier OK. */
export const getCategories = async (): Promise<CgCategory[]> => {
  const d = await get<CgCategory[]>('/coins/categories', { order: 'market_cap_change_24h_desc' });
  return d ?? [];
};

/** Top markets — used for context + deriving gainers/losers on the free tier. */
export const getMarkets = async (perPage = 250, page = 1): Promise<CgMarketCoin[]> => {
  const d = await get<CgMarketCoin[]>('/coins/markets', {
    vs_currency: 'usd',
    order: 'market_cap_desc',
    per_page: perPage,
    page,
    price_change_percentage: '1h,24h'
  });
  return d ?? [];
};
