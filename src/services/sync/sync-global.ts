import { supabase } from '../../config/supabase';
import { getGlobal } from '../sources/coingecko.client';
import { getStablecoinChains } from '../sources/defillama.client';
import { conditionSummary, classifyMarketCondition } from '../scoring/btc-dca';
import type { BtcSignals } from '../scoring/btc-dca';

const sumStablecoinMcap = async (): Promise<number | null> => {
  try {
    const chains = await getStablecoinChains();
    return chains.reduce((sum, chain) => {
      const raw = chain.totalCirculatingUSD;
      const value = typeof raw === 'number' ? raw : (raw?.peggedUSD ?? 0);
      return sum + (value || 0);
    }, 0);
  } catch {
    return null; // non-fatal: stablecoin mcap is a nice-to-have on the overview
  }
};

const priceOf = async (geckoId: string): Promise<number | null> => {
  const { data } = await supabase.from('coins').select('current_price').eq('coingecko_id', geckoId).maybeSingle();
  return data?.current_price ?? null;
};

/**
 * Capture a global market snapshot. BTC signals (if available) decide the
 * market-condition label + summary; otherwise we fall back to global momentum.
 */
export const syncGlobal = async (btcSignals: BtcSignals | null): Promise<number> => {
  const global = await getGlobal();
  const d = global.data;

  const [btcPrice, ethPrice, stablecoinMcap] = await Promise.all([
    priceOf('bitcoin'),
    priceOf('ethereum'),
    sumStablecoinMcap()
  ]);

  const condition =
    btcSignals?.marketCondition ??
    classifyMarketCondition({
      drawdown: 0,
      rsiValue: null,
      dailyVol: null,
      return30d: d.market_cap_change_percentage_24h_usd
    });

  const row = {
    btc_price: btcPrice,
    eth_price: ethPrice,
    total_market_cap: d.total_market_cap?.usd ?? null,
    total_volume: d.total_volume?.usd ?? null,
    btc_dominance: d.market_cap_percentage?.btc ?? null,
    eth_dominance: d.market_cap_percentage?.eth ?? null,
    stablecoin_market_cap: stablecoinMcap,
    market_cap_change_24h: d.market_cap_change_percentage_24h_usd ?? null,
    market_condition: condition,
    summary: conditionSummary(condition)
  };

  const { error } = await supabase.from('global_market_snapshots').insert(row);
  if (error) throw new Error(`Failed to insert global snapshot: ${error.message}`);
  return 1;
};
