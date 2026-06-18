import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';

const latestGlobal = async () => {
  const { data, error } = await supabase
    .from('global_market_snapshots')
    .select('*')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AppError('Unable to load market data.', 500, [error]);
  return data;
};

const moversList = async (ascending: boolean) => {
  const { data } = await supabase
    .from('coins')
    .select('coingecko_id, symbol, name, image_url, current_price, price_change_pct_24h, market_cap_rank')
    .lte('market_cap_rank', 150)
    .not('price_change_pct_24h', 'is', null)
    .order('price_change_pct_24h', { ascending })
    .limit(6);
  return data ?? [];
};

// GET /api/v1/market/overview
export const getOverview = asyncHandler(async (_req, res) => {
  const [global, gainers, losers] = await Promise.all([latestGlobal(), moversList(false), moversList(true)]);

  if (!global) {
    throw new AppError('Market data is not available yet. Run a sync first.', 503);
  }

  return sendSuccess(res, 'Market overview fetched successfully.', {
    btc_price: global.btc_price,
    eth_price: global.eth_price,
    total_market_cap: global.total_market_cap,
    total_volume: global.total_volume,
    btc_dominance: global.btc_dominance,
    eth_dominance: global.eth_dominance,
    stablecoin_market_cap: global.stablecoin_market_cap,
    market_cap_change_24h: global.market_cap_change_24h,
    market_condition: global.market_condition,
    summary: global.summary,
    top_gainers: gainers,
    top_losers: losers,
    as_of: global.captured_at
  });
});

// GET /api/v1/market/global
export const getGlobal = asyncHandler(async (_req, res) => {
  const global = await latestGlobal();
  if (!global) throw new AppError('Market data is not available yet. Run a sync first.', 503);
  return sendSuccess(res, 'Global market data fetched successfully.', global);
});

// GET /api/v1/market/coins — public, lightweight list for the landing marquee.
export const getCoins = asyncHandler(async (_req, res) => {
  const { data } = await supabase
    .from('coins')
    .select('coingecko_id, symbol, name, image_url, market_cap_rank')
    .not('image_url', 'is', null)
    .not('market_cap_rank', 'is', null)
    .order('market_cap_rank', { ascending: true })
    .limit(40);
  return sendSuccess(res, 'Coins fetched successfully.', { items: data ?? [] });
});

// GET /api/v1/market/condition
export const getCondition = asyncHandler(async (_req, res) => {
  const global = await latestGlobal();
  if (!global) throw new AppError('Market data is not available yet. Run a sync first.', 503);
  return sendSuccess(res, 'Market condition fetched successfully.', {
    market_condition: global.market_condition,
    summary: global.summary,
    as_of: global.captured_at
  });
});
