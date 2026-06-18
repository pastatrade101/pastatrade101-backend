import { supabase } from '../config/supabase';
import { getAltBtc } from '../services/altcoin-btc/service';
import { buildComparisonVerdict, getCompare } from '../services/altcoin-btc/compare.service';
import { getMarketSnapshot } from '../services/altcoin-btc/market.service';
import {
  buildReasons,
  computeConfidence,
  computeQuality,
  isAbnormalSpike,
  isLiquid,
  type SignalMetrics
} from '../services/altcoin-btc/signal-quality';
import { buildAnalysis } from '../services/altcoin-btc/verdict';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryNumber, getQueryString } from '../utils/query';

// CoinGecko ids for the default comparison basket (ETH/SOL/SUI/INJ/LINK/JUP).
const DEFAULT_BASKET = ['ethereum', 'solana', 'sui', 'injective-protocol', 'chainlink', 'jupiter-exchange-solana'];

// GET /api/v1/altcoin-btc/coins?search=  → coin selector list (excludes BTC + stablecoins)
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'USDS']);

export const listCoins = asyncHandler(async (req, res) => {
  const search = getQueryString(req.query, 'search');
  let query = supabase
    .from('coins')
    .select('coingecko_id, symbol, name, image_url, market_cap_rank')
    .neq('coingecko_id', 'bitcoin')
    .not('market_cap_rank', 'is', null)
    .order('market_cap_rank', { ascending: true })
    .limit(100);

  if (search) query = query.or(`symbol.ilike.%${search}%,name.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) throw new AppError('Unable to load coins.', 500, [error]);

  const items = (data ?? []).filter((c) => !STABLES.has((c.symbol ?? '').toUpperCase()));
  return sendSuccess(res, 'Coins fetched successfully.', { items });
});

// GET /api/v1/altcoin-btc/ratio/:coinId   (coinId = CoinGecko id, e.g. "solana")
export const getRatio = asyncHandler(async (req, res) => {
  const coinId = req.params.coinId?.toLowerCase();
  if (!coinId || coinId === 'bitcoin') throw new AppError('Select an altcoin (not BTC).', 400);

  // Pull display metadata from our coins table when we have it.
  const { data: coin } = await supabase
    .from('coins')
    .select('id, symbol, name, image_url')
    .eq('coingecko_id', coinId)
    .maybeSingle();

  const result = await getAltBtc(coinId);
  if (!result.points.length) throw new AppError('No saved price series for this coin. Run a Lab price-series sync.', 503);

  const symbol = coin?.symbol ?? coinId.toUpperCase();
  const last = result.points[result.points.length - 1];
  const analysis = buildAnalysis({
    symbol,
    ratio: result.latest_ratio,
    ma50: last.ma50,
    ma200: last.ma200,
    strength7: result.strength_7d,
    strength30: result.strength_30d,
    strength90: result.strength_90d,
    reactionScore: result.reaction_score,
    volumeBreakout: result.breakout_details.volume_breakout
  });

  return sendSuccess(res, 'Alt/BTC ratio computed.', {
    coin: { id: coin?.id ?? null, coingecko_id: coinId, symbol, name: coin?.name ?? coinId, image_url: coin?.image_url ?? null },
    ...result,
    analysis
  });
});

// GET /api/v1/altcoin-btc/compare?coins=ethereum,solana,sui,...
export const compareCoins = asyncHandler(async (req, res) => {
  const raw = getQueryString(req.query, 'coins');
  let ids = raw
    ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_BASKET;
  ids = [...new Set(ids)].filter((id) => id !== 'bitcoin').slice(0, 8); // cap the batch

  const { data } = await supabase.from('coins').select('coingecko_id, symbol, name, market_cap_rank, total_volume').in('coingecko_id', ids);
  const meta = new Map(
    (data ?? []).map((c) => [c.coingecko_id, { symbol: c.symbol, name: c.name, market_cap_rank: c.market_cap_rank, total_volume: c.total_volume }])
  );

  const coins = await getCompare(ids, meta);
  if (!coins.length) throw new AppError('No comparison data available for those coins.', 503);

  return sendSuccess(res, 'Comparison computed.', { coins, verdict: buildComparisonVerdict(coins) });
});

// GET /api/v1/altcoin-btc/market-oscillator
// TOTAL2/TOTAL3 (majors-basket proxy) ÷ BTC ratio history + current dominance.
export const getMarketOscillator = asyncHandler(async (_req, res) => {
  const snapshot = await getMarketSnapshot();
  if (!snapshot.series.length) throw new AppError('Market data unavailable.', 503);
  return sendSuccess(res, 'Altcoin market vs BTC computed.', { proxy: 'majors-basket', ...snapshot });
});

// GET /api/v1/altcoin-btc/signals?scope=premium|all&signal=breakout|weakness&top=100
// Returns enriched signals (confidence, quality, reasons) + market breadth + top-3.
const LEADER_LABELS = ['Confirmed strength', 'Major BTC pair breakout'];

export const getSignals = asyncHandler(async (req, res) => {
  const scope = getQueryString(req.query, 'scope') === 'all' ? 'all' : 'premium';
  const filterType = getQueryString(req.query, 'signal');
  const top = getQueryNumber(req.query, 'top') ?? 100;

  const { data: latest } = await supabase
    .from('altcoin_btc_signals')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest) {
    return sendSuccess(res, 'No signals yet. Run a Lab price-series sync.', { items: [], breadth: null, top3: null, as_of: null, scope });
  }

  const { data, error } = await supabase
    .from('altcoin_btc_signals')
    .select('coin_id, signal_type, signal_label, strength_score, details, date, coin:coins(symbol, name, image_url)')
    .eq('date', latest.date);
  if (error) throw new AppError('Unable to load signals.', 500, [error]);

  const enriched = (data ?? []).map((r) => {
    const coin = Array.isArray(r.coin) ? (r.coin[0] ?? null) : r.coin;
    const d = (r.details ?? {}) as Record<string, number | boolean | null>;
    const metrics: SignalMetrics = {
      strength_7d: (d.strength_7d as number) ?? null,
      strength_30d: (d.strength_30d as number) ?? null,
      strength_90d: (d.strength_90d as number) ?? null,
      above_ma50: Boolean(d.above_ma50),
      above_ma200: Boolean(d.above_ma200),
      volume_breakout: (d.volume_breakout as number) ?? null,
      market_cap: (d.market_cap as number) ?? null,
      total_volume: (d.total_volume as number) ?? null,
      market_cap_rank: (d.market_cap_rank as number) ?? null,
      history_days: (d.history_days as number) ?? 0
    };
    return {
      coin,
      signal_type: r.signal_type as string,
      signal_label: r.signal_label as string,
      strength_score: r.strength_score as number | null,
      confidence: computeConfidence(metrics),
      quality: computeQuality(metrics),
      reasons: buildReasons(metrics),
      metrics
    };
  });
  type Enriched = (typeof enriched)[number];

  // Premium default view hides illiquid / abnormal / short-history coins.
  const passesPremium = (e: Enriched) =>
    isLiquid(e.metrics) && e.metrics.history_days >= 180 && !isAbnormalSpike(e.metrics) && (e.metrics.market_cap_rank ?? 9999) <= top;
  const universe: Enriched[] = scope === 'all' ? enriched : enriched.filter(passesPremium);

  const n = universe.length;
  const cnt = (f: (e: Enriched) => boolean) => universe.filter(f).length;
  const pct = (f: (e: Enriched) => boolean) => (n ? Math.round((cnt(f) / n) * 100) : 0);
  const breadth = {
    count: n,
    outperform_7d: cnt((e) => (e.metrics.strength_7d ?? 0) > 0),
    outperform_30d: cnt((e) => (e.metrics.strength_30d ?? 0) > 0),
    outperform_90d: cnt((e) => (e.metrics.strength_90d ?? 0) > 0),
    pct_outperform_30d: pct((e) => (e.metrics.strength_30d ?? 0) > 0),
    pct_above_50: pct((e) => e.metrics.above_ma50),
    pct_above_200: pct((e) => e.metrics.above_ma200),
    leaders: cnt((e) => LEADER_LABELS.includes(e.signal_label)),
    weak: cnt((e) => ['Still weak', 'Failed breakout'].includes(e.signal_label))
  };

  const byStrength = [...universe].sort((a, b) => (b.metrics.strength_90d ?? -1e9) - (a.metrics.strength_90d ?? -1e9));
  const slim = (e: Enriched) => ({ symbol: e.coin?.symbol ?? '—', signal_label: e.signal_label, strength_90d: e.metrics.strength_90d, confidence: e.confidence });
  const top3 = { strongest: byStrength.slice(0, 3).map(slim), weakest: byStrength.slice(-3).reverse().map(slim) };

  let items = universe;
  if (filterType === 'breakout' || filterType === 'weakness') items = items.filter((e) => e.signal_type === filterType);
  items = [...items].sort((a, b) => (b.strength_score ?? 0) - (a.strength_score ?? 0));

  return sendSuccess(res, 'Signals fetched successfully.', { items, breadth, top3, as_of: latest.date, scope, universe_count: enriched.length });
});
