import { supabase } from '../../config/supabase';
import { getMarketChart } from '../sources/coingecko.client';
import { computeBtcSignals, type BtcSignals } from '../scoring/btc-dca';
import {
  closesFromChart,
  returnOverDays,
  volumeBreakoutRatio,
  volumesFromChart
} from '../scoring/technicals';

const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Look up a coin row by CoinGecko id. Returns null if it hasn't been synced yet. */
export const getCoinByGeckoId = async (geckoId: string) => {
  const { data } = await supabase
    .from('coins')
    .select('id, ath, current_price')
    .eq('coingecko_id', geckoId)
    .maybeSingle();
  return data;
};

/** Persist a CoinGecko market_chart series into coin_price_history (idempotent per day). */
export const storeDailyHistory = async (
  coinId: string,
  prices: [number, number][],
  marketCaps: [number, number][],
  volumes: [number, number][]
): Promise<number> => {
  const byDate = new Map<string, { price: number; market_cap: number | null; volume: number | null }>();
  prices.forEach(([ts, price], i) => {
    byDate.set(toDate(ts), {
      price,
      market_cap: marketCaps[i]?.[1] ?? null,
      volume: volumes[i]?.[1] ?? null
    });
  });

  const rows = [...byDate.entries()].map(([snapshot_date, v]) => ({
    coin_id: coinId,
    snapshot_date,
    price: v.price,
    market_cap: v.market_cap,
    volume: v.volume
  }));

  if (!rows.length) return 0;
  const { error } = await supabase.from('coin_price_history').upsert(rows, { onConflict: 'coin_id,snapshot_date' });
  if (error) throw new Error(`Failed to store price history: ${error.message}`);
  return rows.length;
};

/**
 * Fetch ~1y of BTC daily history, persist it, compute the full BTC dashboard
 * signal set, and write the derived indicators back onto the bitcoin coin row.
 * Returns the signals so the global sync can reuse the market-condition label.
 */
export const syncBtc = async (dominanceChange: number | null = null): Promise<BtcSignals | null> => {
  const coin = await getCoinByGeckoId('bitcoin');
  if (!coin) return null; // coins sync must run first

  const chart = await getMarketChart('bitcoin', 365);
  await storeDailyHistory(coin.id, chart.prices, chart.market_caps, chart.total_volumes);

  const closes = closesFromChart(chart.prices);
  const volumes = volumesFromChart(chart.total_volumes);
  const ath = coin.ath ?? Math.max(...closes);
  const signals = computeBtcSignals(closes, ath, dominanceChange);

  await supabase
    .from('coins')
    .update({
      ma_50: signals.ma50,
      ma_200: signals.ma200,
      rsi_14: signals.rsi14,
      distance_from_ath: signals.drawdownFromAth,
      return_7d: returnOverDays(closes, 7),
      return_30d: signals.return30d,
      return_90d: returnOverDays(closes, 90),
      volume_breakout: volumeBreakoutRatio(volumes, 30),
      strength_score: signals.dcaScore,
      signal: signals.dcaLabel,
      last_synced_at: new Date().toISOString()
    })
    .eq('id', coin.id);

  return signals;
};
