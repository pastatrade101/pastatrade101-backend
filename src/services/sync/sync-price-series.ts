import { supabase } from '../../config/supabase';
import { cacheClear } from '../../utils/cache';
import { getBtcPriceHistory } from '../sources/blockchaincom.client';
import { coingeckoThrottleMs, getMarketChart, type CgMarketChart } from '../sources/coingecko.client';
import { upsertSeries, type SeriesRow } from '../series/store';
import { syncAltBtcSignals } from './sync-altbtc-signals';

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'USDS', 'GUSD']);

// Always include BTC + the Lab baskets so default selections always have data,
// even if one drifts out of the top 100.
const ALWAYS = [
  'bitcoin',
  'ethereum',
  'binancecoin',
  'solana',
  'ripple',
  'dogecoin',
  'cardano',
  'tron',
  'chainlink',
  'avalanche-2',
  'sui',
  'injective-protocol',
  'jupiter-exchange-solana',
  'matic-network',
  'litecoin'
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// CoinGecko market_chart → daily rows (prices/mcaps/volumes share timestamps).
const chartToRows = (chart: CgMarketChart): SeriesRow[] => {
  const byDate = new Map<string, SeriesRow>();
  const put = (pairs: [number, number][], field: 'price' | 'market_cap' | 'volume') => {
    for (const [ms, v] of pairs) {
      const date = new Date(ms).toISOString().slice(0, 10);
      const row = byDate.get(date) ?? { date, price: null, market_cap: null, volume: null };
      if (Number.isFinite(v)) row[field] = v;
      byDate.set(date, row);
    }
  };
  put(chart.prices, 'price');
  put(chart.market_caps, 'market_cap');
  put(chart.total_volumes, 'volume');
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
};

/**
 * Populate daily_prices so the Labs read SAVED data:
 *  • 'btc-full'  — full BTC history (blockchain.com)
 *  • 'cg:<id>'   — CoinGecko daily for BTC + top ~100 alts (+ Lab baskets)
 * Sequential + throttled to respect CoinGecko's rate limit. This is the only
 * place those upstreams are called once the conversion is complete.
 */
export const syncPriceSeries = async (): Promise<number> => {
  // 1) Full BTC history for Charts + Cycle Lab.
  const btcFull = await getBtcPriceHistory();
  await upsertSeries(
    'btc-full',
    btcFull.map((p) => ({ date: p.date, price: p.value, market_cap: null, volume: null }))
  );

  // 2) Resolve the CoinGecko coin set: top 100 by market cap (ex-stables) + ALWAYS.
  const { data: top } = await supabase
    .from('coins')
    .select('coingecko_id, symbol, market_cap_rank')
    .lte('market_cap_rank', 100)
    .not('market_cap_rank', 'is', null)
    .order('market_cap_rank', { ascending: true });

  const ids = new Set<string>(ALWAYS);
  for (const c of top ?? []) {
    if (c.coingecko_id && !STABLES.has((c.symbol ?? '').toUpperCase())) ids.add(c.coingecko_id);
  }

  // 3) Fetch + persist each (throttled).
  let processed = 1; // btc-full
  for (const id of ids) {
    try {
      const chart = await getMarketChart(id, 365);
      const rows = chartToRows(chart);
      if (rows.length) {
        await upsertSeries(`cg:${id}`, rows);
        processed += 1;
      }
    } catch (error) {
      console.warn(`Price-series sync skipped ${id}: ${error instanceof Error ? error.message : error}`);
    }
    await sleep(coingeckoThrottleMs);
  }

  // Drop in-memory caches so the signal pass + Labs read the fresh series.
  cacheClear();

  // Compute & persist Alt/BTC breakout/weakness signals from the fresh series.
  // Non-fatal: if the signals table isn't migrated yet, log and continue.
  try {
    const signals = await syncAltBtcSignals();
    console.log(`[price-series] computed ${signals} Alt/BTC signals`);
  } catch (error) {
    console.warn(`[price-series] signal pass skipped: ${error instanceof Error ? error.message : error}`);
  }

  return processed;
};
