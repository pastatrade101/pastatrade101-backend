import { AppError } from '../../utils/api-response';
import { runRotation, type EngineParams, type FilterKind, type Metrics, type SignalKind } from './engine';
import { binanceTradableIds } from '../rotation-index/rotationIndex.service';
import { loadCapMatrix, loadPriceMatrix, type PriceMatrix, type UniverseCoin } from './rotationData.service';

// Rotation Backtest Lab — picks the universe and test window, runs the engine and
// shapes a compact response. Results are educational backtests on saved daily
// closes, labelled "strength / rotation", never a forecast or a recommendation.

export type UniverseKey = 'top10' | 'top20' | 'top30' | 'top50' | 'all' | 'custom';

export interface RunParams {
  universe: UniverseKey;
  coins?: string[];
  signal: SignalKind;
  filter: FilterKind;
  lookback_days: number;
  top_n: number;
  worst_rank_held: number;
  rebalance_days: number;
  fee_pct: number;
  initial_cash: number;
  start_date?: string;
  end_date?: string;
}

const UNIVERSE_SIZE: Record<Exclude<UniverseKey, 'custom' | 'all'>, number> = { top10: 10, top20: 20, top30: 30, top50: 50 };

export const SIGNALS: Record<SignalKind, { label: string; unit: '%' | 'x' }> = {
  momentum: { label: 'Momentum (price change over the lookback)', unit: '%' },
  risk_adjusted: { label: 'Risk-adjusted momentum (return ÷ volatility)', unit: 'x' }
};

export const FILTERS: Record<FilterKind, string> = {
  none: 'Always invested — hold the top coins whatever the market does',
  positive: 'Only coins going up — empty slots sit in cash',
  beat_btc: 'Only coins beating BTC — empty slots sit in cash'
};

export const DEFAULT_PARAMS: RunParams = {
  universe: 'top20',
  signal: 'momentum',
  filter: 'none',
  lookback_days: 30,
  top_n: 3,
  worst_rank_held: 5,
  rebalance_days: 7,
  fee_pct: 0.1,
  initial_cash: 10000
};

const DISCLAIMER =
  'Educational backtest on historical data — not financial advice and not a forecast. Past results do not predict future returns. Always do your own research.';

const r2 = (v: number) => Math.round(v * 100) / 100;
const r2n = (v: number | null) => (v == null ? null : r2(v));

const roundMetrics = (x: Metrics) => ({
  final_equity: r2(x.finalEquity),
  total_return_pct: r2(x.totalReturnPct),
  cagr_pct: r2n(x.cagrPct),
  max_drawdown_pct: r2(x.maxDrawdownPct),
  volatility_pct: r2(x.volatilityPct),
  sharpe: r2n(x.sharpe),
  sortino: r2n(x.sortino)
});

/** A missing day's market cap falls back to the last one saved this many days before. */
const CAP_CARRY_DAYS = 7;

/**
 * The hindsight check: the same rule over the days with saved market caps, run twice —
 * on the Lab's list (today's top N, used for every past day) and on each review's own
 * top N by THAT day's market cap, which is all anyone could have known then. The gap
 * between the two is what knowing today's winners adds. Top-N lists only.
 */
const realtimeCheck = async (m: PriceMatrix, p: RunParams, universe: UniverseCoin[], startIdx: number, endIdx: number, params: EngineParams) => {
  if (p.universe === 'custom' || p.universe === 'all') {
    return { check: null, note: 'The real-time check needs a top-10, 20, 30 or 50 list: a custom list or every coin has no “top coins on that day” to compare with.' };
  }
  const size = UNIVERSE_SIZE[p.universe];
  const caps = await loadCapMatrix();
  const capAt = (coin: string, t: number) => {
    const row = caps[coin];
    if (!row) return 0;
    for (let k = t; k >= Math.max(0, t - CAP_CARRY_DAYS); k -= 1) if (row[k] != null) return row[k]!;
    return 0;
  };
  const withCaps = (t: number) => m.coins.reduce((n, c) => n + (caps[c.id]?.[t] != null ? 1 : 0), 0);
  let firstCap = -1;
  for (let t = 0; t < m.dates.length; t += 1) if (withCaps(t) >= size) { firstCap = t; break; }
  if (firstCap < 0) return { check: null, note: 'No saved market caps yet, so there is nothing to check against.' };
  const from = Math.max(startIdx, firstCap, p.lookback_days);
  if (endIdx - from < 14) {
    return { check: null, note: `Saved market caps start ${m.dates[firstCap]}. The real-time check needs the test to run at least 15 days past that.` };
  }

  const cut = endIdx + 1;
  const dates = m.dates.slice(0, cut);
  const btc = m.prices.bitcoin!.slice(0, cut);
  const all: Record<string, (number | null)[]> = {};
  for (const c of m.coins) all[c.id] = m.prices[c.id].slice(0, cut);
  const listed: Record<string, (number | null)[]> = {};
  for (const c of universe) listed[c.id] = all[c.id];
  const topOn = (coins: UniverseCoin[]) => (t: number) =>
    coins
      .map((c) => ({ id: c.id, cap: capAt(c.id, t), rank: c.rank }))
      .filter((x) => x.cap > 0)
      .sort((a, b) => b.cap - a.cap || a.rank - b.rank)
      .slice(0, size)
      .map((x) => x.id);

  const hindsight = runRotation({ dates, prices: listed, btc, startIndex: from, params });
  const live = runRotation({ dates, prices: all, btc, startIndex: from, params, universeAt: topOn(m.coins) });
  // The same, from coins Binance trades against USDT only — the Rotation Index's list.
  let tradable: Set<string> | null = null;
  let binanceNote: string | null = null;
  try {
    tradable = new Set(await binanceTradableIds());
  } catch (error) {
    binanceNote = `Binance could not be reached for its coin list: ${error instanceof Error ? error.message : String(error)}`;
  }
  const onBinance = tradable ? m.coins.filter((c) => tradable!.has(c.id)) : [];
  const binance = tradable && onBinance.length >= p.top_n
    ? runRotation({ dates, prices: all, btc, startIndex: from, params, universeAt: topOn(onBinance) })
    : null;
  const symbol = new Map(m.coins.map((c) => [c.id, c.symbol]));
  const sym = (id: string) => symbol.get(id) ?? id;
  const inList = new Set(universe.map((c) => c.id));
  const offList = [...new Set(live.trades.map((t) => t.coin))].filter((c) => !inList.has(c));

  return {
    check: {
      start: live.dates[0],
      end: live.dates[live.dates.length - 1],
      days: live.dates.length - 1,
      caps_from: m.dates[firstCap],
      top_n: size,
      hindsight: roundMetrics(hindsight.metrics.strategy),
      realtime: roundMetrics(live.metrics.strategy),
      binance: binance ? roundMetrics(binance.metrics.strategy) : null,
      binance_note: binanceNote,
      btc: roundMetrics(live.metrics.btc),
      /** Coins the real-time run traded that are not in today's list (they shrank or fell away since). */
      off_list: offList.map(sym),
      /** Coins in today's list that Binance does not trade against USDT. */
      not_on_binance: tradable ? universe.filter((c) => !tradable!.has(c.id)).map((c) => c.symbol) : [],
      realtime_holdings: live.finalHoldings.map((h) => sym(h.coin)),
      binance_holdings: binance ? binance.finalHoldings.map((h) => sym(h.coin)) : []
    },
    note: null
  };
};

const pickUniverse = (coins: UniverseCoin[], p: RunParams): UniverseCoin[] => {
  if (p.universe === 'custom') {
    const wanted = new Set(p.coins ?? []);
    const picked = coins.filter((c) => wanted.has(c.id));
    const unknown = [...wanted].filter((id) => !coins.some((c) => c.id === id));
    if (unknown.length) throw new AppError(`No saved price data for: ${unknown.join(', ')}.`, 422);
    return picked;
  }
  if (p.universe === 'all') return coins;
  return coins.slice(0, UNIVERSE_SIZE[p.universe]);
};

export const getRotationMeta = async () => {
  const m = await loadPriceMatrix();
  return {
    coins: m.coins,
    data_from: m.dates[0] ?? null,
    data_to: m.dates[m.dates.length - 1] ?? null,
    bars: m.dates.length,
    signals: Object.entries(SIGNALS).map(([key, v]) => ({ key, ...v })),
    filters: Object.entries(FILTERS).map(([key, label]) => ({ key, label })),
    defaults: DEFAULT_PARAMS
  };
};

export const runRotationBacktest = async (p: RunParams) => {
  const m = await loadPriceMatrix();
  const btcAll = m.prices.bitcoin;
  if (!btcAll) throw new AppError('BTC price history is not available yet — run the price-series sync.', 503);

  const universe = pickUniverse(m.coins, p);
  if (universe.length < p.top_n) {
    throw new AppError(`The universe has ${universe.length} coin(s) with data — fewer than the ${p.top_n} slots requested.`, 422);
  }

  const warnings: string[] = [];
  const lastIdx = m.dates.length - 1;
  let endIdx = lastIdx;
  if (p.end_date) {
    endIdx = -1;
    for (let i = lastIdx; i >= 0; i -= 1) if (m.dates[i] <= p.end_date) { endIdx = i; break; }
    if (endIdx < 0) throw new AppError(`No data on or before ${p.end_date}. Data starts ${m.dates[0]}.`, 422);
  }
  const earliest = p.lookback_days;
  let startIdx = earliest;
  if (p.start_date) {
    const i = m.dates.findIndex((d) => d >= p.start_date!);
    startIdx = i < 0 ? endIdx : i;
    if (startIdx < earliest) {
      warnings.push(
        `Start moved to ${m.dates[earliest]} — the first ${p.lookback_days} days of data are needed to warm up the ${p.lookback_days}-day signal.`
      );
      startIdx = earliest;
    }
  }
  if (endIdx - startIdx < 14) {
    throw new AppError('The test window is too short — choose at least 15 days between the start and end dates.', 422);
  }

  const cut = endIdx + 1;
  const prices: Record<string, (number | null)[]> = {};
  for (const c of universe) prices[c.id] = m.prices[c.id].slice(0, cut);

  const params: EngineParams = {
    signal: p.signal,
    filter: p.filter,
    lookbackDays: p.lookback_days,
    topN: p.top_n,
    worstRankHeld: p.worst_rank_held,
    rebalanceDays: p.rebalance_days,
    feePct: p.fee_pct,
    initialCash: p.initial_cash
  };
  const result = runRotation({ dates: m.dates.slice(0, cut), prices, btc: btcAll.slice(0, cut), startIndex: startIdx, params });
  // The check is extra: if the market caps can't be read, the backtest still answers.
  const realtime = await realtimeCheck(m, p, universe, startIdx, endIdx, params).catch((error: unknown) => ({
    check: null,
    note: `The real-time check could not run: ${error instanceof Error ? error.message : String(error)}`
  }));

  const byId = new Map(universe.map((c) => [c.id, c]));
  const sym = (id: string) => byId.get(id)?.symbol ?? id;
  // A coin is rankable once it has `lookback_days` of history.
  const late = universe.filter((c) => m.prices[c.id].findIndex((v) => v != null) + p.lookback_days > startIdx);
  if (late.length) {
    warnings.push(
      `${late.map((c) => c.symbol).join(', ')} only ${late.length === 1 ? 'has' : 'have'} data from partway through the test, so ${late.length === 1 ? 'it' : 'they'} could not be picked before then.`
    );
  }

  const s = result.stats;

  return {
    params: p,
    window: { start: result.dates[0], end: result.dates[result.dates.length - 1], days: result.dates.length - 1 },
    data_as_of: m.dates[lastIdx],
    universe: universe.map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, image: c.image, rank: c.rank })),
    series: {
      dates: result.dates,
      strategy: result.equity.strategy.map(r2),
      btc: result.equity.btc.map(r2),
      drawdown_strategy: result.drawdownPct.strategy.map(r2),
      drawdown_btc: result.drawdownPct.btc.map(r2)
    },
    metrics: { strategy: roundMetrics(result.metrics.strategy), btc: roundMetrics(result.metrics.btc) },
    realtime: realtime.check,
    realtime_note: realtime.note,
    stats: {
      trades: s.trades,
      win_rate_pct: r2n(s.winRatePct),
      avg_trade_pct: r2n(s.avgTradePct),
      best_trade_pct: r2n(s.bestTradePct),
      worst_trade_pct: r2n(s.worstTradePct),
      avg_hold_days: r2n(s.avgHoldDays),
      total_fees: r2(s.totalFees),
      exposure_pct: r2(s.exposurePct),
      rebalances: s.rebalances
    },
    trades: result.trades
      .slice()
      .reverse()
      .slice(0, 300)
      .map((t) => ({
        coin: t.coin,
        symbol: sym(t.coin),
        entry_date: t.entryDate,
        exit_date: t.exitDate,
        entry_price: t.entryPrice,
        exit_price: t.exitPrice,
        return_pct: r2(t.returnPct),
        hold_days: t.holdDays,
        exit_reason: t.exitReason
      })),
    events: result.events
      .slice()
      .reverse()
      .slice(0, 200)
      .map((e) => ({ date: e.date, bought: e.bought.map(sym), sold: e.sold.map(sym), held: e.held.map(sym) })),
    final_holdings: result.finalHoldings.map((h) => ({
      coin: h.coin,
      symbol: sym(h.coin),
      entry_date: h.entryDate,
      return_pct: r2(h.returnPct),
      weight_pct: r2(h.weightPct)
    })),
    final_ranking: result.finalRanking.slice(0, 15).map((r) => ({
      coin: r.coin,
      symbol: sym(r.coin),
      name: byId.get(r.coin)?.name ?? r.coin,
      rank: r.rank,
      score: SIGNALS[p.signal].unit === '%' ? r2(r.score * 100) : r2(r.score),
      in_hold_band: r.rank <= p.worst_rank_held
    })),
    // What a review on the last day of data would do, by the same rule as the backtest.
    // Framed as the rule's output ("the rule would…"), never as advice to a person.
    rule_plan: {
      as_of: result.plan.asOf,
      last_review: result.plan.lastReview,
      next_review: result.plan.nextReview,
      review_due_today: result.plan.reviewDueToday,
      keep: result.plan.keep.map(sym),
      drop: result.plan.drop.map((d) => ({
        symbol: sym(d.coin),
        reason:
          d.reason === 'unrankable'
            ? p.filter === 'positive'
              ? 'no longer rising'
              : p.filter === 'beat_btc'
                ? 'no longer beating BTC'
                : 'no ranking data'
            : `fell below #${p.worst_rank_held}`
      })),
      add: result.plan.add.map(sym),
      cash_slots: result.plan.cashSlots,
      slots: p.top_n,
      slot_weight_pct: r2(100 / p.top_n)
    },
    score_unit: SIGNALS[p.signal].unit,
    warnings,
    assumptions: [
      m.coingeckoFrom && result.dates[0] < m.coingeckoFrom
        ? `Daily prices at 00:00 UTC from Pastatrade’s saved price history: Binance USDT prices before ${m.coingeckoFrom}, CoinGecko from then on. Coins Binance does not list only have data from ${m.coingeckoFrom}.`
        : 'Daily closing prices from CoinGecko (00:00 UTC), read from Pastatrade’s saved price history.',
      `Signals use only data up to each rebalance day; trades fill at the NEXT day’s close.`,
      `Equal weight per slot at entry (1/${p.top_n} of equity); holdings drift between rebalances.`,
      ...(p.filter === 'none' ? [] : [`Filter: ${FILTERS[p.filter]}. Cash earns nothing.`]),
      `A ${p.fee_pct}% fee is charged on every buy and sell. Slippage and spreads are not modelled.`,
      'The universe is today’s top coins by market cap, so coins that collapsed and left the list are missing (survivorship bias). This makes results look better than they would have been in real time. The real-time check picks each review’s top coins by that day’s market cap instead.',
      'Every position is closed on the final day so the trade statistics are complete.',
      'BTC benchmark: buy on the strategy’s first trading day, hold, sell on the final day, same fee.'
    ],
    disclaimer: DISCLAIMER
  };
};
