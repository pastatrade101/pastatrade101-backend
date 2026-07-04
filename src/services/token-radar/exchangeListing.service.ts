import { coingecko } from '../../config/env';
import { fetchJson } from '../sources/http';
import { pairsForToken, type DsPair } from '../sources/dexscreener.client';
import type { ChainConfig } from './chainConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Exchange listings — where is this token actually traded? DEXScreener gives the
// DEX pairs (liquidity/volume/pair address); CoinGecko /coins/{id}/tickers adds
// CEX + DEX tickers with a trust score. Everything normalizes into one type,
// deduped and sorted. Listing strength IMPROVES analysis confidence but never
// overrides severe risk. Educational only — not financial advice.
// ─────────────────────────────────────────────────────────────────────────────

export type ExchangeType = 'DEX' | 'CEX';
export type ListingTrust = 'high' | 'medium' | 'low';
export type ListingSource = 'dexscreener' | 'coingecko' | 'coinmarketcap' | 'geckoterminal' | 'exchange_api';

export interface ExchangeListing {
  exchangeName: string;
  exchangeType: ExchangeType;
  pair: string;
  baseSymbol: string;
  quoteSymbol: string;
  priceUsd: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  trustScore?: ListingTrust;
  source: ListingSource;
  url?: string;
  logoUrl?: string; // exchange logo (DexScreener dex icon / CoinGecko market logo)
}

export type ListingStrengthLabel =
  | 'No reliable listings found' | 'Weak listing presence' | 'DEX-only presence'
  | 'Moderate listing presence' | 'Strong listing presence';

export interface ExchangeListingSummary {
  dexListings: ExchangeListing[];
  cexListings: ExchangeListing[];
  totalDexListings: number;
  totalCexListings: number;
  topExchangeNames: string[];
  listingStrengthScore: number;
  listingStrengthLabel: ListingStrengthLabel;
  warnings: string[];
}

// Known DEX identifiers → classify a CoinGecko ticker as DEX vs CEX.
const DEX_MARKETS = /uniswap|pancakeswap|sushiswap|curve|balancer|raydium|orca|trader.?joe|quickswap|camelot|aerodrome|velodrome|dodo|kyber|1inch|meteora|jupiter|shibaswap|baseswap|ramses|thena|biswap|apeswap|dex$/i;
// Major CEXs — a listing here is a meaningfully stronger signal.
const MAJOR_CEX = /binance|coinbase|okx|bybit|kraken|kucoin|gate|htx|huobi|bitget|mexc|crypto\.?com|upbit|bitfinex|gemini/i;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── DEXScreener → DEX listings ──
const fromDexscreener = (pairs: DsPair[], chain: ChainConfig): ExchangeListing[] =>
  pairs
    .filter((p) => p.chainId === chain.dexscreenerId)
    .map((p) => ({
      exchangeName: p.dexId ? p.dexId.charAt(0).toUpperCase() + p.dexId.slice(1) : 'DEX',
      exchangeType: 'DEX' as const,
      pair: `${p.baseToken?.symbol ?? '?'}/${p.quoteToken?.symbol ?? '?'}`,
      baseSymbol: p.baseToken?.symbol ?? '',
      quoteSymbol: p.quoteToken?.symbol ?? '',
      priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
      volume24h: p.volume?.h24 ?? null,
      liquidityUsd: p.liquidity?.usd ?? null,
      source: 'dexscreener' as const,
      url: p.url,
      logoUrl: p.dexId ? `https://dd.dexscreener.com/ds-data/dexes/${p.dexId}.png` : undefined
    }));

// ── CoinGecko: resolve coin id by contract, then tickers ──
const cgGet = async <T>(path: string): Promise<T | null> => {
  try {
    const headers = coingecko.hasKey ? { [coingecko.headerName]: coingecko.apiKey } : {};
    return await fetchJson<T>(`${coingecko.baseUrl}${path}`, { headers, label: 'coingecko-tickers', retries: 1 });
  } catch {
    return null;
  }
};

const trustOf = (score: unknown): ListingTrust | undefined =>
  score === 'green' ? 'high' : score === 'yellow' ? 'medium' : score === 'red' ? 'low' : undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** Resolve a contract address to its CoinGecko coin id (cached 10 min; shared
 * with Chart Intelligence so the lookup is never paid twice per scan). */
const cgIdCache = new Map<string, { at: number; id: string | null }>();
export const resolveCoingeckoId = async (chain: ChainConfig, address: string): Promise<string | null> => {
  if (!chain.coingeckoPlatform) return null;
  const key = `${chain.slug}:${address.toLowerCase()}`;
  const hit = cgIdCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coin = await cgGet<any>(`/coins/${chain.coingeckoPlatform}/contract/${address.toLowerCase()}`);
  const id = typeof coin?.id === 'string' ? coin.id : null;
  cgIdCache.set(key, { at: Date.now(), id });
  return id;
};

const fromCoingecko = async (chain: ChainConfig, address: string): Promise<ExchangeListing[]> => {
  const id = await resolveCoingeckoId(chain, address);
  if (!id) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = await cgGet<{ tickers: any[] }>(`/coins/${id}/tickers?depth=false&include_exchange_logo=true`);
  const tickers = t?.tickers ?? [];
  return tickers.slice(0, 50).map((tk) => {
    const marketName = tk?.market?.name ?? tk?.market?.identifier ?? 'Exchange';
    const isDex = DEX_MARKETS.test(String(tk?.market?.identifier ?? marketName));
    return {
      exchangeName: marketName,
      exchangeType: (isDex ? 'DEX' : 'CEX') as ExchangeType,
      pair: `${tk?.base ?? '?'}/${tk?.target ?? '?'}`,
      baseSymbol: String(tk?.base ?? ''),
      quoteSymbol: String(tk?.target ?? ''),
      priceUsd: num(tk?.converted_last?.usd),
      volume24h: num(tk?.converted_volume?.usd),
      liquidityUsd: null,
      trustScore: trustOf(tk?.trust_score),
      source: 'coingecko' as const,
      url: tk?.trade_url ?? undefined,
      logoUrl: typeof tk?.market?.logo === 'string' && tk.market.logo.startsWith('http') ? tk.market.logo : undefined
    };
  });
};

// ── Normalize: dedupe (same exchange + pair) keeping the richest row, then sort. ──
const dedupeSort = (rows: ExchangeListing[]): ExchangeListing[] => {
  const byKey = new Map<string, ExchangeListing>();
  for (const r of rows) {
    const key = `${r.exchangeType}:${r.exchangeName.toLowerCase()}:${r.pair.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, r);
    else {
      byKey.set(key, {
        ...existing,
        volume24h: Math.max(existing.volume24h ?? 0, r.volume24h ?? 0) || existing.volume24h || r.volume24h,
        liquidityUsd: existing.liquidityUsd ?? r.liquidityUsd,
        trustScore: existing.trustScore ?? r.trustScore,
        url: existing.url ?? r.url,
        logoUrl: existing.logoUrl ?? r.logoUrl
      });
    }
  }
  const trustRank = { high: 0, medium: 1, low: 2, undefined: 3 } as Record<string, number>;
  return [...byKey.values()].sort(
    (a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0) || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || trustRank[String(a.trustScore)] - trustRank[String(b.trustScore)]
  );
};

// ── Strength score + label ──
const strength = (dex: ExchangeListing[], cex: ExchangeListing[]): { score: number; label: ListingStrengthLabel; warnings: string[] } => {
  const warnings: string[] = [];
  const all = [...dex, ...cex];
  if (!all.length) return { score: 5, label: 'No reliable listings found', warnings: ['No reliable exchange listings were found for this token.'] };

  const totalVol = all.reduce((s, l) => s + (l.volume24h ?? 0), 0);
  const maxLiq = Math.max(0, ...dex.map((l) => l.liquidityUsd ?? 0));
  const hasMajorCex = cex.some((l) => MAJOR_CEX.test(l.exchangeName));
  const activeVol = totalVol >= 50_000;
  const deadVol = totalVol < 100;
  const strongLiq = maxLiq >= 250_000;

  let score: number;
  if (hasMajorCex && activeVol) score = 82 + Math.min(18, Math.log10(Math.max(totalVol, 1)) * 2);
  else if (cex.length > 0 && !deadVol) score = 66 + Math.min(13, cex.length * 3);
  else if (strongLiq && activeVol) score = 48 + Math.min(16, Math.log10(maxLiq) * 2);
  else if (dex.length > 1 && !strongLiq) score = 28 + Math.min(16, dex.length * 3);
  else if (dex.length >= 1 && (deadVol || !strongLiq)) score = 12 + Math.min(12, Math.log10(Math.max(maxLiq, 1)) * 1.5);
  else score = 30;
  score = Math.round(Math.max(0, Math.min(100, score)));

  if (deadVol) warnings.push('The token has exchange listings, but 24h trading volume is almost zero. Listing presence alone does not confirm real demand.');
  if (cex.length === 0 && dex.length > 0 && !deadVol) warnings.push('Listings are DEX-only. A DEX pair alone does not confirm a token is safe or in strong demand.');

  const label: ListingStrengthLabel = deadVol
    ? 'Weak listing presence'
    : hasMajorCex && activeVol
      ? 'Strong listing presence'
      : cex.length > 0
        ? 'Moderate listing presence'
        : 'DEX-only presence';

  return { score, label, warnings };
};

export const getExchangeListings = async (chain: ChainConfig, address: string): Promise<ExchangeListingSummary> => {
  const [dsPairs, cgListings] = await Promise.all([
    pairsForToken(address).catch(() => [] as DsPair[]),
    fromCoingecko(chain, address).catch(() => [] as ExchangeListing[])
  ]);
  // DexScreener owns DEX pairs (clean symbols/liquidity). CoinGecko contributes
  // CEX tickers (which DexScreener never has) — its DEX tickers are dropped to
  // avoid duplicate rows with unreadable contract-address symbols.
  const all = dedupeSort([...fromDexscreener(dsPairs, chain), ...cgListings.filter((l) => l.exchangeType === 'CEX')]);
  const dexListings = all.filter((l) => l.exchangeType === 'DEX');
  const cexListings = all.filter((l) => l.exchangeType === 'CEX');
  const { score, label, warnings } = strength(dexListings, cexListings);
  const topExchangeNames = [...new Set(all.map((l) => l.exchangeName))].slice(0, 6);
  return {
    dexListings: dexListings.slice(0, 15),
    cexListings: cexListings.slice(0, 15),
    totalDexListings: dexListings.length,
    totalCexListings: cexListings.length,
    topExchangeNames,
    listingStrengthScore: score,
    listingStrengthLabel: label,
    warnings
  };
};
