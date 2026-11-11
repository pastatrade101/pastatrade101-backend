import { AppError } from '../../utils/api-response';
import { runRotation, type FilterKind, type SignalKind } from './engine';
import { loadPriceMatrix, type UniverseCoin } from './rotationData.service';

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

  const result = runRotation({
    dates: m.dates.slice(0, cut),
    prices,
    btc: btcAll.slice(0, cut),
    startIndex: startIdx,
    params: {
      signal: p.signal,
      filter: p.filter,
      lookbackDays: p.lookback_days,
      topN: p.top_n,
      worstRankHeld: p.worst_rank_held,
      rebalanceDays: p.rebalance_days,
      feePct: p.fee_pct,
      initialCash: p.initial_cash
    }
  });

  const byId = new Map(universe.map((c) => [c.id, c]));
  const sym = (id: string) => byId.get(id)?.symbol ?? id;
  // A coin is rankable once it has `lookback_days` of history.
  const late = universe.filter((c) => m.prices[c.id].findIndex((v) => v != null) + p.lookback_days > startIdx);
  if (late.length) {
    warnings.push(
      `${late.map((c) => c.symbol).join(', ')} only ${late.length === 1 ? 'has' : 'have'} data from partway through the test, so ${late.length === 1 ? 'it' : 'they'} could not be picked before then.`
    );
  }

  const roundMetrics = (x: typeof result.metrics.strategy) => ({
    final_equity: r2(x.finalEquity),
    total_return_pct: r2(x.totalReturnPct),
    cagr_pct: r2n(x.cagrPct),
    max_drawdown_pct: r2(x.maxDrawdownPct),
    volatility_pct: r2(x.volatilityPct),
    sharpe: r2n(x.sharpe),
    sortino: r2n(x.sortino)
  });
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
      'Daily closing prices from CoinGecko (00:00 UTC), read from Pastatrade’s saved price history.',
      `Signals use only data up to each rebalance day; trades fill at the NEXT day’s close.`,
      `Equal weight per slot at entry (1/${p.top_n} of equity); holdings drift between rebalances.`,
      ...(p.filter === 'none' ? [] : [`Filter: ${FILTERS[p.filter]}. Cash earns nothing.`]),
      `A ${p.fee_pct}% fee is charged on every buy and sell. Slippage and spreads are not modelled.`,
      'The universe is today’s top coins by market cap, so coins that collapsed and left the list are missing (survivorship bias). This makes results look better than they would have been in real time.',
      'Every position is closed on the final day so the trade statistics are complete.',
      'BTC benchmark: buy on the strategy’s first trading day, hold, sell on the final day, same fee.'
    ],
    disclaimer: DISCLAIMER
  };
};
