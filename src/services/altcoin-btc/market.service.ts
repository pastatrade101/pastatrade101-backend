import { supabase } from '../../config/supabase';
import { cached } from '../../utils/cache';
import { readSeriesFull } from '../series/store';

// True TOTAL2/TOTAL3 history needs a paid global-market-cap feed. As a free,
// honest proxy we sum the market caps of the major altcoins (a basket that
// dominates TOTAL2/TOTAL3) and ratio them against BTC's market cap. All market
// caps come from the SAVED series (daily_prices), so no upstream call.
const BASKET = [
  'ethereum',
  'binancecoin',
  'solana',
  'ripple',
  'dogecoin',
  'cardano',
  'tron',
  'chainlink',
  'avalanche-2'
];

export interface MarketRatioPoint {
  date: string;
  total2_ratio: number;
  total3_ratio: number;
  dominance_proxy: number; // BTC ÷ (BTC + basket) — a dominance trend proxy
}

const mcapMap = async (coingeckoId: string): Promise<Map<string, number>> => {
  const rows = await readSeriesFull(`cg:${coingeckoId}`);
  const m = new Map<string, number>();
  for (const r of rows) if (r.market_cap != null) m.set(r.date, r.market_cap);
  return m;
};

/** Daily TOTAL2/TOTAL3-proxy ÷ BTC ratios from the saved series. Cached 30 min. */
export const getMarketRatios = () =>
  cached(
    'altmarket:ratios',
    async (): Promise<MarketRatioPoint[]> => {
      const ids = ['bitcoin', ...BASKET];
      const maps = await Promise.all(ids.map(mcapMap));
      const btcMap = maps[0];

      const points: MarketRatioPoint[] = [];
      for (const date of [...btcMap.keys()].sort()) {
        const btc = btcMap.get(date);
        if (!btc || btc <= 0) continue;
        let total2 = 0;
        let total3 = 0;
        BASKET.forEach((id, k) => {
          const m = maps[k + 1].get(date);
          if (m) {
            total2 += m;
            if (id !== 'ethereum') total3 += m;
          }
        });
        if (total2 <= 0) continue;
        points.push({
          date,
          total2_ratio: total2 / btc,
          total3_ratio: total3 / btc,
          dominance_proxy: btc / (btc + total2)
        });
      }
      return points;
    },
    1800
  );

export interface MarketSnapshot {
  series: MarketRatioPoint[];
  current_btc_dominance: number | null;
  current_eth_dominance: number | null;
  percent_outperforming_30d: number | null; // % of basket majors beating BTC over 30d
}

// % of basket majors whose USD price gained more than BTC over the last 30 days.
const percentOutperforming = async (): Promise<number | null> => {
  const roc30 = async (id: string): Promise<number | null> => {
    const rows = await readSeriesFull(`cg:${id}`);
    const prices = rows.filter((r) => r.price != null).map((r) => r.price as number);
    if (prices.length < 31) return null;
    const past = prices[prices.length - 31];
    return past ? ((prices[prices.length - 1] - past) / past) * 100 : null;
  };

  const btc = await roc30('bitcoin');
  if (btc == null) return null;
  const rocs = await Promise.all(BASKET.map(roc30));
  const valid = rocs.filter((r): r is number => r != null);
  if (!valid.length) return null;
  return (valid.filter((r) => r > btc).length / valid.length) * 100;
};

// Current dominance comes from the latest synced global snapshot (DB), not a live call.
const latestDominance = async (): Promise<{ btc: number | null; eth: number | null }> => {
  const { data } = await supabase
    .from('global_market_snapshots')
    .select('btc_dominance, eth_dominance')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { btc: data?.btc_dominance ?? null, eth: data?.eth_dominance ?? null };
};

export const getMarketSnapshot = async (): Promise<MarketSnapshot> => {
  const [series, dom, pct] = await Promise.all([getMarketRatios(), latestDominance(), percentOutperforming()]);
  return { series, current_btc_dominance: dom.btc, current_eth_dominance: dom.eth, percent_outperforming_30d: pct };
};
