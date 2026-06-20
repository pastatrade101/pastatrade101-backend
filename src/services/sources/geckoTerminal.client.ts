import { fetchJson } from './http';

// GeckoTerminal (CoinGecko Onchain) public API — no key required. Used for DEX
// pool discovery. Graceful: failure returns [] so the radar degrades cleanly.
const BASE = 'https://api.geckoterminal.com/api/v2';

const get = async <T>(path: string): Promise<T | null> => {
  try {
    return await fetchJson<T>(`${BASE}${path}`, { headers: { accept: 'application/json' }, label: 'geckoterminal', retries: 2 });
  } catch {
    return null;
  }
};

export interface GtPool {
  id: string; // "<network>_<poolAddress>"
  type: string;
  attributes: {
    name: string;
    address: string;
    base_token_price_usd: string | null;
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    volume_usd?: { h24?: string };
    transactions?: { h24?: { buys?: number; sells?: number } };
    price_change_percentage?: { h1?: string; h6?: string; h24?: string };
  };
  relationships?: {
    base_token?: { data?: { id?: string } }; // "<network>_<contract>"
    dex?: { data?: { id?: string } };
  };
}

const norm = (data: GtPool[] | undefined): GtPool[] => (Array.isArray(data) ? data : []);

/** Trending pools — global or per-network. */
export const getTrendingPools = async (network?: string, page = 1): Promise<GtPool[]> => {
  const path = network ? `/networks/${network}/trending_pools?page=${page}` : `/networks/trending_pools?page=${page}`;
  const d = await get<{ data: GtPool[] }>(path);
  return norm(d?.data);
};

/** New pools — global or per-network (Phase 2; included for completeness). */
export const getNewPools = async (network?: string, page = 1): Promise<GtPool[]> => {
  const path = network ? `/networks/${network}/new_pools?page=${page}` : `/networks/new_pools?page=${page}`;
  const d = await get<{ data: GtPool[] }>(path);
  return norm(d?.data);
};

/** Parse "<network>_<address>" → { network, address }. */
export const parseGtId = (id: string | undefined): { network: string | null; address: string | null } => {
  if (!id) return { network: null, address: null };
  const i = id.indexOf('_');
  if (i < 0) return { network: null, address: id };
  return { network: id.slice(0, i), address: id.slice(i + 1) };
};
