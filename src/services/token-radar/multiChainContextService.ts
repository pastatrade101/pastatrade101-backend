import { coingecko } from '../../config/env';
import { fetchJson } from '../sources/http';
import { pairsForTokens, type DsPair } from '../sources/dexscreener.client';
import { CHAINS, type ChainConfig } from './chainConfig';
import { resolveCoingeckoId } from './exchangeListing.service';

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Chain Token Context — a token can live on many chains. If a user pastes
// a contract from a low-liquidity chain, a single-chain read makes the token
// look weaker than it is globally. This service separates the SCANNED chain from
// the GLOBAL token: it finds the token's markets across every supported chain
// (same or bridged addresses via CoinGecko `platforms`), aggregates DEX + CEX
// activity, and flags when the scanned chain is a small slice of the whole.
//
// Cost-aware: at most one CoinGecko `/coins/{id}` call (reuses the cached id
// resolver shared with Exchange Listings + Chart Intelligence) + one batched
// DexScreener multi-address call (up to 30 addresses). Educational only.
// ─────────────────────────────────────────────────────────────────────────────

export type OtherChainSource = 'dexscreener' | 'coingecko' | 'geckoterminal' | 'coinmarketcap' | 'unknown';

export type MultiChainContextResult = {
  scannedChain: string;
  scannedTokenAddress: string;

  scannedChainMetrics: {
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    dexPairs: number;
    holders: number | null;
    chainActivityScore: number;
  };

  globalMetrics: {
    totalDexLiquidityUsd: number | null;
    totalDexVolume24hUsd: number | null;
    totalCexVolume24hUsd: number | null;
    totalGlobalVolume24hUsd: number | null;
    totalDexPairs: number;
    totalCexMarkets: number;
    globalMarketPresenceScore: number;
  };

  otherChains: {
    chain: string;
    tokenAddress: string | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    pairCount: number;
    topDex: string | null;
    source: OtherChainSource;
  }[];

  topMarkets: {
    exchangeName: string;
    exchangeType: 'DEX' | 'CEX';
    chain?: string;
    pair: string;
    volume24hUsd: number | null;
    liquidityUsd: number | null;
    url?: string;
    source: string;
  }[];

  biasDetected: boolean;
  biasType:
    | 'scanned_chain_low_liquidity'
    | 'scanned_chain_low_volume'
    | 'global_activity_much_stronger'
    | 'none';

  warning?: {
    label: string;
    message: string;
    severity: 'low' | 'medium' | 'high';
  };

  summary: string;
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));
// log-magnitude: ~$10M maps to ≈100, $10k ≈ 57, $100 ≈ 29.
const mag = (usd: number | null): number => (usd == null || usd <= 0 ? 0 : clamp((Math.log10(usd) / 7) * 100));

// DexScreener chainId (and CoinGecko platform id) → our configured chain.
const DS_TO_CHAIN = new Map<string, ChainConfig>();
const CG_PLATFORM_TO_CHAIN = new Map<string, ChainConfig>();
for (const c of Object.values(CHAINS)) {
  if (c.dexscreenerId) DS_TO_CHAIN.set(c.dexscreenerId.toLowerCase(), c);
  if (c.coingeckoPlatform) CG_PLATFORM_TO_CHAIN.set(c.coingeckoPlatform.toLowerCase(), c);
}
const titleCase = (s: string) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
const displayChain = (dsChainId: string): string => DS_TO_CHAIN.get(dsChainId.toLowerCase())?.name ?? titleCase(dsChainId);

// ── One chain's aggregated DEX activity, built from its pairs. ──
export interface ChainGroup {
  chainId: string; // DexScreener chain id (grouping key)
  name: string;
  tokenAddress: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  pairCount: number;
  topDex: string | null;
}

const groupPairsByChain = (pairs: DsPair[]): ChainGroup[] => {
  const by = new Map<string, { liq: number; vol: number; count: number; address: string | null; dexLiq: Map<string, number> }>();
  for (const p of pairs) {
    if (!p.chainId) continue;
    const g = by.get(p.chainId) ?? { liq: 0, vol: 0, count: 0, address: null, dexLiq: new Map() };
    g.liq += p.liquidity?.usd ?? 0;
    g.vol += p.volume?.h24 ?? 0;
    g.count += 1;
    g.address = g.address ?? p.baseToken?.address ?? null;
    if (p.dexId) g.dexLiq.set(p.dexId, (g.dexLiq.get(p.dexId) ?? 0) + (p.liquidity?.usd ?? 0));
    by.set(p.chainId, g);
  }
  return [...by.entries()].map(([chainId, g]) => ({
    chainId,
    name: displayChain(chainId),
    tokenAddress: g.address,
    liquidityUsd: g.liq || null,
    volume24hUsd: g.vol || null,
    pairCount: g.count,
    topDex: [...g.dexLiq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }));
};

// ── Pure compute — deterministic, exported for tests. ──
export interface MultiChainComputeInput {
  scannedChain: ChainConfig;
  scannedTokenAddress: string;
  scannedHolders: number | null;
  groups: ChainGroup[]; // ALL chains incl. scanned
  cexMarkets: number;
  cexVolume24hUsd: number | null;
  cgTotalVolume24hUsd: number | null; // CoinGecko market_data.total_volume.usd
  platformsOnlyChains: MultiChainContextResult['otherChains']; // chains from CG platforms with no DEX pairs found
  topMarkets: MultiChainContextResult['topMarkets'];
}

export const computeMultiChainContext = (i: MultiChainComputeInput): MultiChainContextResult => {
  const scannedId = i.scannedChain.dexscreenerId?.toLowerCase() ?? i.scannedChain.slug.toLowerCase();
  const scannedGroup = i.groups.find((g) => g.chainId.toLowerCase() === scannedId) ?? null;
  const others = i.groups.filter((g) => g !== scannedGroup);

  const scannedLiq = scannedGroup?.liquidityUsd ?? null;
  const scannedVol = scannedGroup?.volume24hUsd ?? null;
  const scannedPairs = scannedGroup?.pairCount ?? 0;

  const totalDexLiq = i.groups.reduce((s, g) => s + (g.liquidityUsd ?? 0), 0) || null;
  const totalDexVol = i.groups.reduce((s, g) => s + (g.volume24hUsd ?? 0), 0) || null;
  const totalDexPairs = i.groups.reduce((s, g) => s + g.pairCount, 0);
  const totalCexVol = i.cexVolume24hUsd;
  const totalGlobalVol = i.cgTotalVolume24hUsd ?? ((totalDexVol ?? 0) + (totalCexVol ?? 0) || null);

  // scanned-chain activity: liquidity/volume magnitude + its share of global volume.
  const share = totalGlobalVol && scannedVol != null ? scannedVol / totalGlobalVol : totalGlobalVol ? 0 : 1;
  const chainActivityScore = clamp(0.4 * mag(scannedLiq) + 0.3 * mag(scannedVol) + 0.3 * share * 100);

  const chainsWithActivity = i.groups.filter((g) => (g.liquidityUsd ?? 0) > 0 || (g.volume24hUsd ?? 0) > 0).length + i.platformsOnlyChains.length;
  const globalMarketPresenceScore = clamp(
    12 + Math.min(48, chainsWithActivity * 12) + Math.min(20, i.cexMarkets * 4) + 0.2 * mag(totalGlobalVol)
  );

  const otherChains: MultiChainContextResult['otherChains'] = [
    ...others
      .map((g) => ({
        chain: g.name,
        tokenAddress: g.tokenAddress,
        liquidityUsd: g.liquidityUsd,
        volume24hUsd: g.volume24hUsd,
        pairCount: g.pairCount,
        topDex: g.topDex,
        source: 'dexscreener' as OtherChainSource
      }))
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)),
    ...i.platformsOnlyChains
  ];

  // ── Bias detection ──
  const otherLiq = (totalDexLiq ?? 0) - (scannedLiq ?? 0);
  const liqShare = totalDexLiq && scannedLiq != null ? scannedLiq / totalDexLiq : totalDexLiq ? 0 : 1;
  const volShare = share;
  const hasElsewhere = otherChains.length > 0 || i.cexMarkets > 0;
  const globalIsSubstantial = (totalGlobalVol ?? 0) >= 50_000 || (totalDexLiq ?? 0) >= 100_000 || i.cexMarkets >= 2;

  let biasType: MultiChainContextResult['biasType'] = 'none';
  if (hasElsewhere && globalIsSubstantial) {
    const thinLiq = liqShare < 0.3 && otherLiq >= 2 * Math.max(scannedLiq ?? 0, 1);
    const thinVol = volShare < 0.3 && (totalGlobalVol ?? 0) - (scannedVol ?? 0) >= 2 * Math.max(scannedVol ?? 0, 1);
    if (thinLiq && volShare < 0.15 && (otherChains.length >= 2 || i.cexMarkets >= 3)) biasType = 'global_activity_much_stronger';
    else if (thinLiq) biasType = 'scanned_chain_low_liquidity';
    else if (thinVol) biasType = 'scanned_chain_low_volume';
  }
  const biasDetected = biasType !== 'none';

  // Where the token is actually strongest (for the copy).
  const primary = [...i.groups].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] ?? null;
  const primaryIsScanned = !primary || primary === scannedGroup;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  let warning: MultiChainContextResult['warning'];
  if (biasType === 'global_activity_much_stronger') {
    warning = {
      label: 'Scanned chain is a small part of a larger token',
      message: `This token is far more active elsewhere. The scanned ${i.scannedChain.name} market holds about ${pct(liqShare)} of global liquidity${primaryIsScanned ? '' : ` — most activity is on ${primary?.name}`}${i.cexMarkets > 0 ? ` and it also trades on ${i.cexMarkets} CEX market${i.cexMarkets === 1 ? '' : 's'}` : ''}. A single-chain read here understates the token — weigh the global picture too.`,
      severity: 'high'
    };
  } else if (biasType === 'scanned_chain_low_liquidity') {
    warning = {
      label: 'Scanned chain has low liquidity',
      message: `The ${i.scannedChain.name} market holds only about ${pct(liqShare)} of this token's DEX liquidity${primaryIsScanned ? '' : `; ${primary?.name} is deeper`}. Liquidity-based signals on this chain may look weaker than the token is globally.`,
      severity: liqShare < 0.1 ? 'high' : 'medium'
    };
  } else if (biasType === 'scanned_chain_low_volume') {
    warning = {
      label: 'Scanned chain has low volume',
      message: `Most of this token's trading volume happens off ${i.scannedChain.name}. The scanned chain shows about ${pct(volShare)} of global volume, so momentum here can read lighter than the token's real activity.`,
      severity: volShare < 0.1 ? 'high' : 'medium'
    };
  }

  // ── Summary (adjusted interpretation) ──
  let summary: string;
  if (!hasElsewhere) {
    summary = `This token's activity is concentrated on ${i.scannedChain.name}; no meaningful market was found on other chains, so the single-chain read is representative.`;
  } else if (biasDetected) {
    const where = primaryIsScanned ? 'other markets' : `${primary?.name}`;
    summary = `Analysis was run on the ${i.scannedChain.name} market, but this token is more active on ${where}. Treat the scanned-chain liquidity and volume as a local view, not the token's full picture — the global market is stronger than this chain alone suggests.`;
  } else {
    const n = otherChains.length;
    summary = `This token also trades on ${n} other chain${n === 1 ? '' : 's'}${i.cexMarkets > 0 ? ` and ${i.cexMarkets} CEX market${i.cexMarkets === 1 ? '' : 's'}` : ''}, but the scanned ${i.scannedChain.name} market is a fair representation of its overall activity.`;
  }

  return {
    scannedChain: i.scannedChain.slug,
    scannedTokenAddress: i.scannedTokenAddress,
    scannedChainMetrics: {
      liquidityUsd: scannedLiq,
      volume24hUsd: scannedVol,
      dexPairs: scannedPairs,
      holders: i.scannedHolders,
      chainActivityScore
    },
    globalMetrics: {
      totalDexLiquidityUsd: totalDexLiq,
      totalDexVolume24hUsd: totalDexVol,
      totalCexVolume24hUsd: totalCexVol,
      totalGlobalVolume24hUsd: totalGlobalVol,
      totalDexPairs,
      totalCexMarkets: i.cexMarkets,
      globalMarketPresenceScore
    },
    otherChains: otherChains.slice(0, 12),
    topMarkets: i.topMarkets.slice(0, 10),
    biasDetected,
    biasType,
    warning,
    summary
  };
};

// ── CoinGecko: platforms (other-chain addresses) + global volume + CEX tickers. ──
const DEX_MARKETS = /uniswap|pancakeswap|sushiswap|curve|balancer|raydium|orca|trader.?joe|quickswap|camelot|aerodrome|velodrome|dodo|kyber|1inch|meteora|jupiter|shibaswap|baseswap|ramses|thena|biswap|apeswap|dex$/i;

interface CgTokenInfo {
  platforms: Record<string, string>; // platform id → contract address
  totalVolumeUsd: number | null;
  cexMarkets: number;
  cexVolumeUsd: number | null;
  cexTop: MultiChainContextResult['topMarkets'];
}

const cgTokenInfo = async (chain: ChainConfig, address: string): Promise<CgTokenInfo | null> => {
  const id = await resolveCoingeckoId(chain, address).catch(() => null);
  if (!id) return null;
  try {
    const headers = coingecko.hasKey ? { [coingecko.headerName]: coingecko.apiKey } : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await fetchJson<any>(
      `${coingecko.baseUrl}/coins/${id}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=false&sparkline=false`,
      { headers, label: 'coingecko-multichain', retries: 1 }
    );
    if (!d) return null;
    const platforms: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.platforms ?? {})) if (typeof v === 'string' && v) platforms[k] = v;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tickers: any[] = Array.isArray(d.tickers) ? d.tickers : [];
    const cex = tickers.filter((t) => !DEX_MARKETS.test(String(t?.market?.identifier ?? t?.market?.name ?? '')));
    const cexNames = new Set(cex.map((t) => String(t?.market?.name ?? t?.market?.identifier ?? '')));
    const cexVolumeUsd = cex.reduce((s, t) => s + (num(t?.converted_volume?.usd) ?? 0), 0) || null;
    const cexTop: MultiChainContextResult['topMarkets'] = cex
      .map((t) => ({
        exchangeName: String(t?.market?.name ?? t?.market?.identifier ?? 'Exchange'),
        exchangeType: 'CEX' as const,
        pair: `${t?.base ?? '?'}/${t?.target ?? '?'}`,
        volume24hUsd: num(t?.converted_volume?.usd),
        liquidityUsd: null,
        url: typeof t?.trade_url === 'string' ? t.trade_url : undefined,
        source: 'coingecko'
      }))
      .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
    return {
      platforms,
      totalVolumeUsd: num(d?.market_data?.total_volume?.usd),
      cexMarkets: cexNames.size,
      cexVolumeUsd,
      cexTop
    };
  } catch {
    return null;
  }
};

/**
 * Build the multi-chain context. `scannedHolders` is the holder count already
 * resolved by the orchestrator (so we don't refetch it).
 */
export const getMultiChainContext = async (
  chain: ChainConfig,
  address: string,
  scannedHolders: number | null
): Promise<MultiChainContextResult> => {
  const cg = await cgTokenInfo(chain, address).catch(() => null);

  // Every address the token is known at (scanned + all CoinGecko platform
  // addresses) → ONE batched DexScreener call spanning all chains.
  const addresses = [address, ...Object.values(cg?.platforms ?? {})];
  const pairs = await pairsForTokens(addresses).catch(() => [] as DsPair[]);
  const groups = groupPairsByChain(pairs);

  // Chains CoinGecko knows about but where no DEX pair was found — still worth
  // showing as "token exists here" context.
  const coveredIds = new Set(groups.map((g) => g.chainId.toLowerCase()));
  const platformsOnlyChains: MultiChainContextResult['otherChains'] = Object.entries(cg?.platforms ?? {})
    .map(([platform, addr]) => ({ platform, addr, chain: CG_PLATFORM_TO_CHAIN.get(platform.toLowerCase()) }))
    .filter(({ chain: c, platform }) => {
      const dsId = c?.dexscreenerId?.toLowerCase() ?? platform.toLowerCase();
      return !coveredIds.has(dsId);
    })
    .map(({ platform, addr, chain: c }) => ({
      chain: c?.name ?? titleCase(platform),
      tokenAddress: addr,
      liquidityUsd: null,
      volume24hUsd: null,
      pairCount: 0,
      topDex: null,
      source: 'coingecko' as OtherChainSource
    }));

  // Top markets: richest DEX pairs across all chains + CEX tickers.
  const dexTop: MultiChainContextResult['topMarkets'] = pairs
    .map((p) => ({
      exchangeName: p.dexId ? titleCase(p.dexId) : 'DEX',
      exchangeType: 'DEX' as const,
      chain: displayChain(p.chainId),
      pair: `${p.baseToken?.symbol ?? '?'}/${p.quoteToken?.symbol ?? '?'}`,
      volume24hUsd: p.volume?.h24 ?? null,
      liquidityUsd: p.liquidity?.usd ?? null,
      url: p.url,
      source: 'dexscreener'
    }))
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  const topMarkets = [...dexTop, ...(cg?.cexTop ?? [])].sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));

  return computeMultiChainContext({
    scannedChain: chain,
    scannedTokenAddress: address,
    scannedHolders,
    groups,
    cexMarkets: cg?.cexMarkets ?? 0,
    cexVolume24hUsd: cg?.cexVolumeUsd ?? null,
    cgTotalVolume24hUsd: cg?.totalVolumeUsd ?? null,
    platformsOnlyChains,
    topMarkets
  });
};
