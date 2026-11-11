/**
 * Rotation Backtest engine — a TypeScript port of PyBroker's hold-band rotation
 * (`Strategy.enable_rotation(worst_rank_held=…)`) for daily crypto closes.
 * Pure: no I/O, deterministic, lookahead-free.
 *
 * On every rebalance bar t:
 *   1. score each coin from prices at t and EARLIER only
 *   2. rank scores descending (coin id breaks ties); a missing/NaN score is unrankable
 *   3. queue a sell for every holding ranked worse than `worstRankHeld`, or unrankable
 *   4. fill the free slots (topN − holdings kept) from the best-ranked coins not held,
 *      never entering a coin ranked outside the hold band
 * Orders fill at the NEXT bar's close (PyBroker's default buy/sell delay of 1), sized
 * at equal weight — 1/topN of equity at the fill — with a percentage fee on every
 * fill. Held positions drift between rebalances (rotation never trims winners).
 * Every position is closed on the last bar (PyBroker's `exit_on_last_bar`) so the
 * trade statistics include all of them. Metrics annualise over 365 bars (crypto
 * trades every day).
 */

export type SignalKind = 'momentum' | 'risk_adjusted';
/**
 * Entry/hold filter. A coin failing it gets no score (PyBroker: a NaN score is
 * unrankable → never entered, and liquidated if held), so the slot sits in cash.
 *  • none      — always fully invested
 *  • positive  — only coins whose lookback return is above zero (absolute momentum)
 *  • beat_btc  — only coins whose lookback return beats BTC's
 * Ranking by "strength vs BTC" alone would change nothing: dividing every coin by the
 * same BTC move keeps their order. As a filter it does change what gets held.
 */
export type FilterKind = 'none' | 'positive' | 'beat_btc';
export type ExitReason = 'rank' | 'unrankable' | 'end';

export interface EngineParams {
  signal: SignalKind;
  filter: FilterKind;
  /** Bars the score looks back over. */
  lookbackDays: number;
  /** Position slots. */
  topN: number;
  /** Hold band: keep a holding while it ranks this well or better (>= topN). */
  worstRankHeld: number;
  /** Rebalance every N bars (1 = daily, 7 = weekly …). */
  rebalanceDays: number;
  /** Fee per fill in percent of notional (0.1 = 0.1 %). */
  feePct: number;
  initialCash: number;
}

export interface EngineInput {
  /** Ascending daily dates (YYYY-MM-DD). */
  dates: string[];
  /** Close per coin id, aligned to `dates` (null = no bar that day). */
  prices: Record<string, (number | null)[]>;
  /** BTC close aligned to `dates` — the benchmark and the `vs_btc` denominator. */
  btc: (number | null)[];
  /** First bar of the test window. Bars before it are warm-up for the score. */
  startIndex: number;
  params: EngineParams;
}

export interface Trade {
  coin: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  /** Net of both fees. */
  returnPct: number;
  holdDays: number;
  exitReason: ExitReason;
}

export interface RebalanceEvent {
  date: string;
  bought: string[];
  sold: string[];
  held: string[];
}

export interface Metrics {
  finalEquity: number;
  totalReturnPct: number;
  cagrPct: number | null;
  maxDrawdownPct: number;
  volatilityPct: number;
  sharpe: number | null;
  sortino: number | null;
}

export interface StrategyStats {
  trades: number;
  winRatePct: number | null;
  avgTradePct: number | null;
  bestTradePct: number | null;
  worstTradePct: number | null;
  avgHoldDays: number | null;
  totalFees: number;
  /** Average share of equity invested (not in cash), per bar. */
  exposurePct: number;
  rebalances: number;
}

export interface RankRow {
  coin: string;
  rank: number;
  score: number;
}

export interface OpenPosition {
  coin: string;
  entryDate: string;
  entryPrice: number;
  lastPrice: number;
  returnPct: number;
  weightPct: number;
}

export interface EngineResult {
  dates: string[];
  equity: { strategy: number[]; btc: number[] };
  drawdownPct: { strategy: number[]; btc: number[] };
  metrics: { strategy: Metrics; btc: Metrics };
  stats: StrategyStats;
  trades: Trade[];
  events: RebalanceEvent[];
  /** What the strategy held on the final bar, before the closing exit. */
  finalHoldings: OpenPosition[];
  /** Ranking computed on the final bar (current strength, not a forecast). */
  finalRanking: RankRow[];
}

const BARS_PER_YEAR = 365;

const valid = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;

/** L-day return at bar i (NaN when either bar is missing). */
const lookbackReturn = (p: (number | null)[], i: number, lookback: number): number => {
  const j = i - lookback;
  if (j < 0) return NaN;
  const now = p[i];
  const then = p[j];
  return valid(now) && valid(then) ? now / then - 1 : NaN;
};

/**
 * Score of one coin at bar i using bars i − lookback … i only. NaN = unrankable.
 *  • momentum       — L-day return
 *  • risk_adjusted  — L-day return divided by the volatility of its daily returns
 *                     over the same window (rewards steady trends over spikes)
 * Then the filter: a coin failing it is unrankable.
 */
export const scoreAt = (
  signal: SignalKind,
  p: (number | null)[],
  btc: (number | null)[],
  i: number,
  lookback: number,
  filter: FilterKind = 'none'
): number => {
  const ret = lookbackReturn(p, i, lookback);
  if (!Number.isFinite(ret)) return NaN;
  if (filter === 'positive' && !(ret > 0)) return NaN;
  if (filter === 'beat_btc') {
    const btcRet = lookbackReturn(btc, i, lookback);
    if (!Number.isFinite(btcRet) || !(ret > btcRet)) return NaN;
  }
  if (signal === 'momentum') return ret;
  const j = i - lookback;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let k = j + 1; k <= i; k += 1) {
    const a = p[k - 1];
    const b = p[k];
    if (!valid(a) || !valid(b)) return NaN;
    const r = b / a - 1;
    sum += r;
    sumSq += r * r;
    n += 1;
  }
  const mean = sum / n;
  const vol = Math.sqrt(Math.max(0, sumSq / n - mean * mean)) * Math.sqrt(n);
  if (!(vol > 0)) return NaN;
  return ret / vol;
};

/** Rank every coin with a finite score at bar i: best first, coin id breaks ties. */
export const rankAt = (
  input: Pick<EngineInput, 'prices' | 'btc'>,
  signal: SignalKind,
  lookback: number,
  i: number,
  filter: FilterKind = 'none'
): RankRow[] => {
  const rows: { coin: string; score: number }[] = [];
  for (const coin of Object.keys(input.prices)) {
    const score = scoreAt(signal, input.prices[coin], input.btc, i, lookback, filter);
    if (Number.isFinite(score)) rows.push({ coin, score });
  }
  rows.sort((a, b) => b.score - a.score || (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));
  return rows.map((r, k) => ({ coin: r.coin, rank: k + 1, score: r.score }));
};

const drawdownSeries = (equity: number[]): number[] => {
  let peak = -Infinity;
  return equity.map((v) => {
    peak = Math.max(peak, v);
    return peak > 0 ? (v / peak - 1) * 100 : 0;
  });
};

export const computeMetrics = (equity: number[], initial: number): Metrics => {
  const last = equity[equity.length - 1] ?? initial;
  const days = equity.length - 1;
  const rets: number[] = [];
  for (let k = 1; k < equity.length; k += 1) rets.push(equity[k] / equity[k - 1] - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const downs = rets.map((r) => Math.min(0, r));
  const dsd = rets.length > 1 ? Math.sqrt(downs.reduce((a, r) => a + r * r, 0) / (rets.length - 1)) : 0;
  const dd = drawdownSeries(equity);
  return {
    finalEquity: last,
    totalReturnPct: (last / initial - 1) * 100,
    // Annualising under ~3 months of data mostly reports noise.
    cagrPct: days >= 90 && last > 0 ? ((last / initial) ** (BARS_PER_YEAR / days) - 1) * 100 : null,
    maxDrawdownPct: Math.min(0, ...dd),
    volatilityPct: sd * Math.sqrt(BARS_PER_YEAR) * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(BARS_PER_YEAR) : null,
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(BARS_PER_YEAR) : null
  };
};

interface Position {
  units: number;
  entryIndex: number;
  entryPrice: number;
  /** Cash spent including the entry fee. */
  cost: number;
}

export const runRotation = (input: EngineInput): EngineResult => {
  const { dates, prices, btc, startIndex: s, params: P } = input;
  const end = dates.length - 1;
  if (!Number.isInteger(s) || s < P.lookbackDays) throw new Error('startIndex must leave at least lookbackDays bars of warm-up.');
  if (s >= end) throw new Error('The test window needs at least two bars.');
  if (P.topN < 1 || P.worstRankHeld < P.topN) throw new Error('worstRankHeld must be >= topN >= 1.');
  if (P.rebalanceDays < 1) throw new Error('rebalanceDays must be >= 1.');
  for (const coin of Object.keys(prices)) {
    if (prices[coin].length !== dates.length) throw new Error(`Series ${coin} is not aligned to dates.`);
  }
  if (btc.length !== dates.length) throw new Error('BTC series is not aligned to dates.');

  const fee = P.feePct / 100;
  const lastPrice = new Map<string, number>();
  const positions = new Map<string, Position>();
  const pendingSells = new Map<string, ExitReason>();
  let pendingBuys: string[] = [];
  let cash = P.initialCash;
  let totalFees = 0;
  let investedSum = 0; // Σ invested share of equity per bar → average exposure
  let rebalances = 0;
  const trades: Trade[] = [];
  const events: RebalanceEvent[] = [];
  const equity: number[] = [];
  let finalHoldings: OpenPosition[] = [];

  const equityNow = (): number => {
    let v = cash;
    for (const [coin, pos] of positions) v += pos.units * (lastPrice.get(coin) ?? pos.entryPrice);
    return v;
  };

  const sell = (coin: string, px: number, t: number, reason: ExitReason) => {
    const pos = positions.get(coin)!;
    const gross = pos.units * px;
    const f = gross * fee;
    cash += gross - f;
    totalFees += f;
    trades.push({
      coin,
      entryDate: dates[pos.entryIndex],
      exitDate: dates[t],
      entryPrice: pos.entryPrice,
      exitPrice: px,
      returnPct: ((gross - f) / pos.cost - 1) * 100,
      holdDays: t - pos.entryIndex,
      exitReason: reason
    });
    positions.delete(coin);
  };

  for (let t = s; t <= end; t += 1) {
    for (const coin of Object.keys(prices)) {
      const v = prices[coin][t];
      if (valid(v)) lastPrice.set(coin, v);
    }

    // 1) Fill the orders queued on the previous rebalance bar at today's close.
    if (pendingSells.size || pendingBuys.length) {
      const sold: string[] = [];
      const bought: string[] = [];
      for (const [coin, reason] of [...pendingSells]) {
        const px = prices[coin][t];
        if (!valid(px)) continue; // No bar today: the order (and its slot) waits for the next one.
        sell(coin, px, t, reason);
        pendingSells.delete(coin);
        sold.push(coin);
      }
      if (pendingBuys.length) {
        const target = equityNow() / P.topN;
        for (const coin of pendingBuys) {
          // An unfilled sell still holds its slot, so never exceed the cap.
          if (positions.size >= P.topN) break;
          const px = prices[coin][t];
          if (!valid(px)) continue; // Can't fill: the slot stays free until the next rebalance.
          const notional = Math.min(target, cash / (1 + fee));
          if (!(notional > target * 1e-6)) continue;
          const f = notional * fee;
          cash -= notional + f;
          totalFees += f;
          positions.set(coin, { units: notional / px, entryIndex: t, entryPrice: px, cost: notional + f });
          bought.push(coin);
        }
        pendingBuys = [];
      }
      if (sold.length || bought.length) events.push({ date: dates[t], bought, sold, held: [...positions.keys()].sort() });
    }

    // 2) Last bar: report what was held, then close everything.
    if (t === end) {
      const eq = equityNow();
      finalHoldings = [...positions].map(([coin, pos]) => {
        const lp = lastPrice.get(coin) ?? pos.entryPrice;
        return {
          coin,
          entryDate: dates[pos.entryIndex],
          entryPrice: pos.entryPrice,
          lastPrice: lp,
          returnPct: ((pos.units * lp) / pos.cost - 1) * 100,
          weightPct: eq > 0 ? ((pos.units * lp) / eq) * 100 : 0
        };
      });
      finalHoldings.sort((a, b) => b.weightPct - a.weightPct);
      for (const coin of [...positions.keys()]) sell(coin, lastPrice.get(coin) ?? positions.get(coin)!.entryPrice, t, 'end');
      pendingSells.clear();
    }

    // 3) Mark to market.
    const eqNow = equityNow();
    equity.push(eqNow);
    investedSum += eqNow > 0 ? (eqNow - cash) / eqNow : 0;

    // 4) Rebalance decision — uses bars <= t only; fills happen on bar t + 1.
    if (t < end && (t - s) % P.rebalanceDays === 0) {
      rebalances += 1;
      const rankOf = new Map(rankAt(input, P.signal, P.lookbackDays, t, P.filter).map((r) => [r.coin, r.rank]));
      pendingSells.clear();
      for (const coin of positions.keys()) {
        const r = rankOf.get(coin);
        if (r === undefined) pendingSells.set(coin, 'unrankable');
        else if (r > P.worstRankHeld) pendingSells.set(coin, 'rank');
      }
      let free = P.topN - (positions.size - pendingSells.size);
      pendingBuys = [];
      const ranking = [...rankOf].sort((a, b) => a[1] - b[1]);
      for (const [coin, rank] of ranking) {
        if (free <= 0 || rank > P.worstRankHeld) break;
        if (positions.has(coin)) continue;
        pendingBuys.push(coin);
        free -= 1;
      }
    }
  }

  // Benchmark: buy BTC on the strategy's first fill bar, hold, sell on the last bar.
  const btcEquity: number[] = [];
  let btcUnits = 0;
  let btcCash = P.initialCash;
  let btcLast: number | null = null;
  for (let t = s; t <= end; t += 1) {
    if (valid(btc[t])) btcLast = btc[t];
    if (t === s + 1 && btcLast != null) {
      const notional = btcCash / (1 + fee);
      btcUnits = notional / btcLast;
      btcCash = 0;
    }
    let v = btcCash + btcUnits * (btcLast ?? 0);
    if (t === end && btcUnits > 0) v -= btcUnits * (btcLast ?? 0) * fee;
    btcEquity.push(v);
  }

  const closed = trades;
  const wins = closed.filter((x) => x.returnPct > 0).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    dates: dates.slice(s, end + 1),
    equity: { strategy: equity, btc: btcEquity },
    drawdownPct: { strategy: drawdownSeries(equity), btc: drawdownSeries(btcEquity) },
    metrics: { strategy: computeMetrics(equity, P.initialCash), btc: computeMetrics(btcEquity, P.initialCash) },
    stats: {
      trades: closed.length,
      winRatePct: closed.length ? (wins / closed.length) * 100 : null,
      avgTradePct: avg(closed.map((x) => x.returnPct)),
      bestTradePct: closed.length ? Math.max(...closed.map((x) => x.returnPct)) : null,
      worstTradePct: closed.length ? Math.min(...closed.map((x) => x.returnPct)) : null,
      avgHoldDays: avg(closed.map((x) => x.holdDays)),
      totalFees,
      exposurePct: (investedSum / equity.length) * 100,
      rebalances
    },
    trades,
    events,
    finalHoldings,
    finalRanking: rankAt(input, P.signal, P.lookbackDays, end, P.filter)
  };
};
