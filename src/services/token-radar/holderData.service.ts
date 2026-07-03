import { fetchJson } from '../sources/http';
import { tokenSecurityDetail } from '../sources/goplus.client';
import type { ChainConfig } from './chainConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Holder-data service — the "holder truth" layer, kept SEPARATE from market data.
// DEXScreener gives price/liquidity/volume; holder counts must come from an
// explorer/indexer. Every source carries a confidence + verified flag so the
// scoring engine only applies SEVERE holder penalties when the data is trusted.
//
// Provider order (first that returns wins). Paid providers activate only when
// their key is set; otherwise we fall back to GoPlus (a real holder indexer,
// classified medium) and finally to "unknown" (never crash).
// ─────────────────────────────────────────────────────────────────────────────

export type HolderDataSource =
  | 'etherscan' | 'bscscan' | 'polygonscan' | 'arbiscan' | 'basescan'
  | 'moralis' | 'covalent' | 'alchemy' | 'helius' | 'solscan' | 'birdeye'
  | 'goplus' | 'dexscreener' | 'unknown';

export type HolderDataConfidence = 'high' | 'medium' | 'low';

export interface HolderDataResult {
  holders: number | null;
  top10_percent: number | null;
  top20_percent: number | null;
  whale_concentration: number | null;
  source: HolderDataSource;
  confidence: HolderDataConfidence;
  verified: boolean;
  warning?: string;
}

const UNKNOWN: HolderDataResult = {
  holders: null, top10_percent: null, top20_percent: null, whale_concentration: null,
  source: 'unknown', confidence: 'low', verified: false, warning: 'Reliable holder data is unavailable for this token.'
};

const key = (name: string) => (process.env[name] || '').trim();

// ── Provider: Moralis (high) — EVM ERC-20 holder stats. Key-gated. ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moralisHolders = async (chain: ChainConfig, address: string): Promise<HolderDataResult | null> => {
  const k = key('MORALIS_API_KEY');
  if (!k || chain.addressKind !== 'evm' || chain.chainId == null) return null;
  const hex = `0x${chain.chainId.toString(16)}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await fetchJson<any>(`https://deep-index.moralis.io/api/v2.2/erc20/${address}/holders?chain=${hex}`, {
      headers: { 'X-API-Key': k, accept: 'application/json' }, label: 'moralis', retries: 1
    });
    const holders = Number(d?.totalHolders ?? d?.total ?? NaN);
    if (!Number.isFinite(holders)) return null;
    const top10 = d?.holderDistribution?.top10?.percentageOfTotalSupply ?? d?.top10SupplyPercent ?? null;
    const top20 = d?.holderDistribution?.top25?.percentageOfTotalSupply ?? null;
    return { holders, top10_percent: top10 != null ? Number(top10) : null, top20_percent: top20 != null ? Number(top20) : null, whale_concentration: top10 != null ? Number(top10) : null, source: 'moralis', confidence: 'high', verified: true };
  } catch {
    return null;
  }
};

// ── Provider: Covalent (high) — token holder count. Key-gated. ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const covalentHolders = async (chain: ChainConfig, address: string): Promise<HolderDataResult | null> => {
  const k = key('COVALENT_API_KEY');
  if (!k || chain.chainId == null) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await fetchJson<any>(`https://api.covalenthq.com/v1/${chain.chainId}/tokens/${address}/token_holders_v2/?page-size=1&key=${k}`, { label: 'covalent', retries: 1 });
    const total = d?.data?.pagination?.total_count;
    if (total == null) return null;
    return { holders: Number(total), top10_percent: null, top20_percent: null, whale_concentration: null, source: 'covalent', confidence: 'high', verified: true };
  } catch {
    return null;
  }
};

// Real-wallet top-N (excludes contracts/locked), from GoPlus. A real holder
// indexer, but it can be incomplete for wrapped/bridged tokens → classified
// MEDIUM, not high, so severe overrides stay conservative.
const goplusHolders = async (goplusNetwork: string, address: string): Promise<HolderDataResult | null> => {
  const sec = await tokenSecurityDetail(goplusNetwork, address);
  if (!sec.checked || (sec.holder_count == null && sec.top10_percent == null)) return null;
  return {
    holders: sec.holder_count,
    top10_percent: sec.top10_percent,
    top20_percent: null,
    whale_concentration: sec.top10_percent,
    source: 'goplus',
    confidence: 'medium',
    verified: sec.holder_count != null
  };
};

/**
 * Resolve holder data with graceful provider fallback. `liquidityUsd` /
 * `marketCap` are used for a sanity check: a very low holder count paired with
 * large liquidity/mcap is almost certainly incomplete/pair-based indexing, so we
 * demote it to low-confidence + unverified so it can't drive a severe override.
 */
export const getHolderData = async (
  chain: ChainConfig,
  address: string,
  context: { liquidityUsd: number | null; marketCap: number | null }
): Promise<HolderDataResult> => {
  let result: HolderDataResult | null = null;

  if (chain.addressKind === 'evm') {
    result = (await moralisHolders(chain, address)) ?? (await covalentHolders(chain, address)) ?? (chain.goplusNetwork ? await goplusHolders(chain.goplusNetwork, address) : null);
  } else {
    // Solana: (Helius/Solscan/Birdeye would slot here when keyed) → GoPlus → unknown.
    result = chain.goplusNetwork ? await goplusHolders(chain.goplusNetwork, address) : null;
  }
  if (!result) return { ...UNKNOWN };

  // Sanity: absurdly low holders vs large liquidity/mcap = incomplete indexing.
  const bigMarket = (context.liquidityUsd ?? 0) > 1_000_000 || (context.marketCap ?? 0) > 5_000_000;
  if (result.holders != null && result.holders < 100 && bigMarket) {
    return {
      ...result,
      confidence: 'low',
      verified: false,
      warning: 'Holder data looks inconsistent with liquidity and market cap — likely incomplete or pair-based indexing. Verify from a chain explorer before trusting it.'
    };
  }
  if (result.source === 'goplus' && result.confidence === 'medium') {
    result.warning = 'Holder data is from a security indexer (medium confidence). Verify from a chain explorer for exact holder counts.';
  }
  return result;
};
