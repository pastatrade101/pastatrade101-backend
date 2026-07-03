import { pairsForToken, searchPairs, bestPair, type DsPair } from '../sources/dexscreener.client';
import { type ChainConfig, isValidAddress, looksLikeAddress } from './chainConfig';

// ─────────────────────────────────────────────────────────────────────────────
// tokenResolver — turns user input (contract address OR ticker) into an exact
// token. Addresses are validated per chain and resolved directly; tickers are
// NEVER trusted: we return candidate matches and the user must pick one.
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenMatch {
  address: string;
  name: string;
  symbol: string;
  dex: string;
  price_usd: number | null;
  liquidity_usd: number | null;
  volume_24h: number | null;
  pair_url: string;
}

export type ResolveResult =
  | { kind: 'token'; pair: DsPair; input_type: 'address' | 'ticker' }
  | { kind: 'matches'; matches: TokenMatch[] }
  | { kind: 'error'; code: 'invalid-address' | 'wrong-chain-address' | 'not-found' | 'no-matches'; message: string };

const toMatch = (p: DsPair): TokenMatch => ({
  address: p.baseToken.address,
  name: p.baseToken.name,
  symbol: p.baseToken.symbol,
  dex: p.dexId,
  price_usd: p.priceUsd != null ? Number(p.priceUsd) : null,
  liquidity_usd: p.liquidity?.usd ?? null,
  volume_24h: p.volume?.h24 ?? null,
  pair_url: p.url
});

export const resolveToken = async (chain: ChainConfig, rawInput: string): Promise<ResolveResult> => {
  const input = rawInput.trim();

  // ── Address path (preferred) ──
  if (looksLikeAddress(input)) {
    if (!isValidAddress(chain, input)) {
      return { kind: 'error', code: 'wrong-chain-address', message: `This address does not look valid for ${chain.name}. Check the selected network.` };
    }
    const pairs = await pairsForToken(input);
    const pair = bestPair(pairs, chain.dexscreenerId, input);
    if (!pair) return { kind: 'error', code: 'not-found', message: `No DEX market found for this token on ${chain.name}. It may be unlisted, delisted, or on a different chain.` };
    return { kind: 'token', pair, input_type: 'address' };
  }

  // ── Ticker path (untrusted — always return matches for the user to pick) ──
  if (input.length < 2 || input.length > 24) {
    return { kind: 'error', code: 'invalid-address', message: 'Enter a token contract address (preferred) or a ticker of 2–24 characters.' };
  }
  const found = await searchPairs(input);
  const onChain = found.filter((p) => p.chainId === chain.dexscreenerId);
  // Dedupe by base token address, keep the most liquid pair per token.
  const byToken = new Map<string, DsPair>();
  for (const p of onChain) {
    const key = p.baseToken.address.toLowerCase();
    const existing = byToken.get(key);
    if (!existing || (p.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) byToken.set(key, p);
  }
  const matches = [...byToken.values()]
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
    .slice(0, 8)
    .map(toMatch);
  if (!matches.length) return { kind: 'error', code: 'no-matches', message: `No tokens matching "${input}" found on ${chain.name}. Paste the contract address for an exact lookup.` };
  return { kind: 'matches', matches };
};
