import { supabase } from '../config/supabase';
import { computeBtcSignals } from '../services/scoring/btc-dca';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';

interface HistoryRow {
  snapshot_date: string;
  price: number | null;
  volume: number | null;
}

// Recompute the BTC dashboard from stored daily history on each request — no
// upstream call, just a single indexed DB read. Sync keeps the history fresh.
const loadBtc = async () => {
  const { data: coin } = await supabase
    .from('coins')
    .select('id, current_price, ath, image_url')
    .eq('coingecko_id', 'bitcoin')
    .maybeSingle();

  if (!coin) throw new AppError('BTC data is not available yet. Run a sync first.', 503);

  const { data: history } = await supabase
    .from('coin_price_history')
    .select('snapshot_date, price, volume')
    .eq('coin_id', coin.id)
    .order('snapshot_date', { ascending: true });

  const rows = (history ?? []) as HistoryRow[];
  if (rows.length < 30) throw new AppError('Not enough BTC history yet. Run a sync first.', 503);

  const closes = rows.map((r) => Number(r.price)).filter((n) => Number.isFinite(n));
  const ath = coin.ath ?? Math.max(...closes);

  const { data: latestGlobal } = await supabase
    .from('global_market_snapshots')
    .select('btc_dominance')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const signals = computeBtcSignals(closes, ath, null);
  return { coin, rows, signals, btcDominance: latestGlobal?.btc_dominance ?? null };
};

// GET /api/v1/btc/dashboard
export const getDashboard = asyncHandler(async (_req, res) => {
  const { coin, rows, signals, btcDominance } = await loadBtc();

  return sendSuccess(res, 'BTC dashboard fetched successfully.', {
    price: coin.current_price ?? signals.price,
    ath: coin.ath,
    image_url: coin.image_url,
    btc_dominance: btcDominance,
    moving_averages: { ma20: signals.ma20, ma50: signals.ma50, ma100: signals.ma100, ma200: signals.ma200 },
    rsi_14: signals.rsi14,
    volatility: { daily_pct: signals.volatilityDaily, state: signals.volatilityState },
    drawdown_from_ath: signals.drawdownFromAth,
    return_30d: signals.return30d,
    dca: { score: signals.dcaScore, label: signals.dcaLabel },
    market_condition: signals.marketCondition,
    // trailing 180 days for the chart
    series: rows.slice(-180).map((r) => ({ date: r.snapshot_date, price: r.price, volume: r.volume }))
  });
});

// GET /api/v1/btc/dca-score
export const getDcaScore = asyncHandler(async (_req, res) => {
  const { signals } = await loadBtc();
  return sendSuccess(res, 'BTC DCA score fetched successfully.', {
    score: signals.dcaScore,
    label: signals.dcaLabel
  });
});

// GET /api/v1/btc/drawdown
export const getDrawdown = asyncHandler(async (_req, res) => {
  const { signals, coin } = await loadBtc();
  return sendSuccess(res, 'BTC drawdown fetched successfully.', {
    drawdown_from_ath: signals.drawdownFromAth,
    price: coin.current_price ?? signals.price,
    ath: coin.ath
  });
});

// GET /api/v1/btc/volatility
export const getVolatility = asyncHandler(async (_req, res) => {
  const { signals } = await loadBtc();
  return sendSuccess(res, 'BTC volatility fetched successfully.', {
    daily_pct: signals.volatilityDaily,
    state: signals.volatilityState
  });
});
