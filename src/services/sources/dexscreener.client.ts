import { fetchJson } from './http';

// DexScreener public API — keyless, free. Primary DEX/market source for the
// Token Position Radar (price, liquidity, volume, buys/sells, FDV, pair age)
// across every chain we support. Graceful: failures return null/[].
// Base overridable via DEXSCREENER_API_URL (no key needed).
const BASE = (process.env.DEXSCREENER_API_URL || 'https://api.dexscreener.com').replace(/\/+$/, '');

export interface DsToken {
  address: string;
  name: string;
  symbol: string;
}
export interface DsPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: DsToken;
  quoteToken: DsToken;
  priceUsd?: string;
  txns?: { h24?: { buys?: number; sells?: number }; h6?: { buys?: number; sells?: number } };
  volume?: { h24?: number; h6?: number };
  priceChange?: { h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number; // ms epoch
  info?: { imageUrl?: string; header?: string; openGraph?: string }; // curated token logo/branding
}

const get = async <T>(path: string): Promise<T | null> => {
  try {
    return await fetchJson<T>(`${BASE}${path}`, { label: 'dexscreener', retries: 1 });
  } catch {
    return null;
  }
};

/** All pairs for a token address (any chain — caller filters by chainId). */
export const pairsForToken = async (address: string): Promise<DsPair[]> => {
  const d = await get<{ pairs: DsPair[] | null }>(`/latest/dex/tokens/${encodeURIComponent(address.trim())}`);
  return d?.pairs ?? [];
};

/**
 * All pairs for up to 30 token addresses in ONE call — used by Multi-Chain
 * Context to fetch a token's markets across every chain it's deployed on
 * (same or bridged addresses) without N separate requests.
 */
export const pairsForTokens = async (addresses: string[]): Promise<DsPair[]> => {
  const list = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))].slice(0, 30);
  if (!list.length) return [];
  const d = await get<{ pairs: DsPair[] | null }>(`/latest/dex/tokens/${list.map(encodeURIComponent).join(',')}`);
  return d?.pairs ?? [];
};

/** Free-text search (ticker/name) — caller filters by chainId. */
export const searchPairs = async (query: string): Promise<DsPair[]> => {
  const d = await get<{ pairs: DsPair[] | null }>(`/latest/dex/search?q=${encodeURIComponent(query.trim())}`);
  return d?.pairs ?? [];
};

/** Pick the most liquid pair where `address` is the BASE token on `chainId`. */
export const bestPair = (pairs: DsPair[], chainId: string, address?: string): DsPair | null => {
  const norm = (s: string) => s.toLowerCase();
  const candidates = pairs.filter(
    (p) => p.chainId === chainId && (!address || norm(p.baseToken?.address ?? '') === norm(address))
  );
  return candidates.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
};
