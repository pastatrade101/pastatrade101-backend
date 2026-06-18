import { env } from '../../config/env';
import { cached } from '../../utils/cache';
import { fetchJson } from './http';

// DefiLlama is keyless. We use the open endpoints:
//   /v2/historicalChainTvl/{chain}  → daily TVL series for a chain
//   /overview/dexs/{chain}          → DEX volume (24h + change)
//   /overview/fees/{chain}          → fees & revenue (24h)
//   stablecoins.llama.fi/stablecoinchains → per-chain stablecoin market cap

export interface LlamaTvlPoint {
  date: number; // unix seconds
  tvl: number;
}

export interface LlamaOverview {
  total24h?: number;
  change_7dover7d?: number;
  totalDataChart?: [number, number][];
}

export interface LlamaStablecoinChain {
  name: string;
  totalCirculatingUSD?: { peggedUSD?: number } | number;
}

export const getChainTvlHistory = (defillamaSlug: string) =>
  cached(
    `llama:chaintvl:${defillamaSlug}`,
    () =>
      fetchJson<LlamaTvlPoint[]>(`${env.DEFILLAMA_BASE_URL}/v2/historicalChainTvl/${encodeURIComponent(defillamaSlug)}`, {
        label: `DefiLlama chainTvl/${defillamaSlug}`
      }),
    600
  );

export const getChainDexOverview = (defillamaSlug: string) =>
  cached(
    `llama:dex:${defillamaSlug}`,
    () =>
      fetchJson<LlamaOverview>(
        `${env.DEFILLAMA_BASE_URL}/overview/dexs/${encodeURIComponent(defillamaSlug)}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
        { label: `DefiLlama dexs/${defillamaSlug}` }
      ).catch(() => ({}) as LlamaOverview),
    600
  );

export const getChainFeesOverview = (defillamaSlug: string) =>
  cached(
    `llama:fees:${defillamaSlug}`,
    () =>
      fetchJson<LlamaOverview & { totalRevenue24h?: number }>(
        `${env.DEFILLAMA_BASE_URL}/overview/fees/${encodeURIComponent(defillamaSlug)}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
        { label: `DefiLlama fees/${defillamaSlug}` }
      ).catch(() => ({}) as LlamaOverview & { totalRevenue24h?: number }),
    600
  );

export const getStablecoinChains = () =>
  cached(
    'llama:stablecoinchains',
    () =>
      fetchJson<LlamaStablecoinChain[]>(`${env.STABLECOINS_BASE_URL}/stablecoinchains`, {
        label: 'DefiLlama stablecoinchains'
      }),
    600
  );
