import { supabase } from '../../config/supabase';
import { getMarkets, type CgMarketCoin } from '../sources/coingecko.client';

// Map a CoinGecko markets row onto our `coins` columns. The markets endpoint
// already returns 24h/7d/30d change, so we can populate momentum without a
// per-coin history call — history (for MA/RSI/drawdown) is fetched separately
// for BTC and any coins we explicitly track over time.
const toCoinRow = (c: CgMarketCoin) => ({
  coingecko_id: c.id,
  symbol: c.symbol?.toUpperCase() ?? '',
  name: c.name,
  image_url: c.image ?? null,
  current_price: c.current_price,
  market_cap: c.market_cap,
  market_cap_rank: c.market_cap_rank,
  total_volume: c.total_volume,
  circulating_supply: c.circulating_supply,
  total_supply: c.total_supply,
  ath: c.ath,
  ath_date: c.ath_date,
  price_change_pct_24h: c.price_change_percentage_24h_in_currency ?? null,
  price_change_pct_7d: c.price_change_percentage_7d_in_currency ?? null,
  price_change_pct_30d: c.price_change_percentage_30d_in_currency ?? null,
  return_7d: c.price_change_percentage_7d_in_currency ?? null,
  return_30d: c.price_change_percentage_30d_in_currency ?? null,
  distance_from_ath: c.ath && c.current_price ? ((c.current_price - c.ath) / c.ath) * 100 : null,
  last_synced_at: new Date().toISOString()
});

/**
 * Upsert the top `pages × 250` coins by market cap. Returns the number of coins
 * written. Conflict target is coingecko_id so this is safe to re-run.
 */
export const syncCoins = async (pages = 1): Promise<number> => {
  let total = 0;

  for (let page = 1; page <= pages; page += 1) {
    const markets = await getMarkets(page, 250);
    if (!markets.length) break;

    const rows = markets.map(toCoinRow);
    const { error } = await supabase.from('coins').upsert(rows, { onConflict: 'coingecko_id' });
    if (error) throw new Error(`Failed to upsert coins (page ${page}): ${error.message}`);

    total += rows.length;
  }

  return total;
};
