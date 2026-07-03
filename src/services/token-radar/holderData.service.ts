import { fetchJson } from '../sources/http';
import type { TokenSecurityDetail } from '../sources/goplus.client';
import type { ChainConfig } from './chainConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Holder-data service — the "holder truth" layer, kept SEPARATE from market data.
// Every source carries a confidence + verified flag so the scoring engine only
// applies SEVERE holder penalties when the data is trusted.
//
// Cost-aware provider strategy (Moralis free tier = 40K CU/day):
//   1. FREE baseline: GoPlus (already fetched for the contract-risk check, reused
//      here for its contract-EXCLUDED top-holder concentration) → medium.
//   2. Escalate to a HIGH-confidence COUNT (Moralis → Covalent) ONLY when the
//      GoPlus count is missing/low/suspicious — i.e. the exact cases where a
//      verified count changes the rating. Obviously-healthy tokens (large holder
//      counts) never spend a Moralis call.
//   3. Concentration always comes from GoPlus (Moralis/Covalent aggregate percents
//      include contracts, so they're not used for whale-concentration overrides).
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
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── High-confidence COUNT providers (key-gated; count only, concentration from GoPlus) ──
const moralisCount = async (chain: ChainConfig, address: string): Promise<{ holders: number; source: HolderDataSource } | null> => {
  const k = key('MORALIS_API_KEY');
  if (!k || chain.addressKind !== 'evm' || chain.chainId == null) return null;
  const hex = `0x${chain.chainId.toString(16)}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await fetchJson<any>(`https://deep-index.moralis.io/api/v2.2/erc20/${address}/holders?chain=${hex}`, {
      headers: { 'X-API-Key': k, accept: 'application/json' }, label: 'moralis', retries: 1
    });
    const h = num(d?.totalHolders);
    return h != null ? { holders: h, source: 'moralis' } : null;
  } catch {
    return null;
  }
};

const covalentCount = async (chain: ChainConfig, address: string): Promise<{ holders: number; source: HolderDataSource } | null> => {
  const k = key('COVALENT_API_KEY');
  if (!k || chain.chainId == null) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await fetchJson<any>(`https://api.covalenthq.com/v1/${chain.chainId}/tokens/${address}/token_holders_v2/?page-size=1&key=${k}`, { label: 'covalent', retries: 1 });
    const h = num(d?.data?.pagination?.total_count);
    return h != null ? { holders: h, source: 'covalent' } : null;
  } catch {
    return null;
  }
};

// GoPlus baseline from the already-fetched security detail (no extra network call).
// top10_percent here is contract-EXCLUDED (computed in goplus.client).
const goplusBaseline = (sec: TokenSecurityDetail | null): HolderDataResult | null => {
  if (!sec || !sec.checked || (sec.holder_count == null && sec.top10_percent == null)) return null;
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
 * Resolve holder data. `security` is the GoPlus contract-risk detail already
 * fetched by the orchestrator (reused as the free baseline — no double call).
 */
export const getHolderData = async (
  chain: ChainConfig,
  address: string,
  context: { liquidityUsd: number | null; marketCap: number | null },
  security: TokenSecurityDetail | null
): Promise<HolderDataResult> => {
  const gp = goplusBaseline(security);
  const bigMarket = (context.liquidityUsd ?? 0) > 1_000_000 || (context.marketCap ?? 0) > 5_000_000;

  // Escalate to a verified COUNT only when it can change the outcome — GoPlus
  // count missing, very low, or low-but-inside-a-large-market (likely incomplete).
  const suspicious = !gp || gp.holders == null || gp.holders < 500 || (gp.holders < 100 && bigMarket);
  if (suspicious && chain.addressKind === 'evm') {
    const verified = (await moralisCount(chain, address)) ?? (await covalentCount(chain, address));
    if (verified) {
      return {
        holders: verified.holders,
        top10_percent: gp?.top10_percent ?? null, // contract-excluded, from GoPlus
        top20_percent: null,
        whale_concentration: gp?.top10_percent ?? null,
        source: verified.source,
        confidence: 'high',
        verified: true
      };
    }
  }

  if (!gp) return { ...UNKNOWN };

  // Non-verified source + absurd low count in a large market → demote (can't drive
  // a severe override; only a verified provider is allowed to confirm that).
  if (gp.holders != null && gp.holders < 100 && bigMarket) {
    return { ...gp, confidence: 'low', verified: false, warning: 'Holder count looks inconsistent with liquidity and market cap — likely incomplete or pair-based. Verify from a chain explorer or add a holder-indexer key.' };
  }
  gp.warning = 'Holder data is from a security indexer (medium confidence). A holder-indexer key raises this to verified high confidence.';
  return gp;
};
