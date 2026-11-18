import { computeMetrics, type Metrics } from '../rotation-backtest/engine';
import { dateToDay, dayToDate, type History, type Series } from './data';
import { canBuy } from './universe';

/**
 * Moon backtest — buys a coin when it closes above a long sideways range (a "base")
 * on a volume surge, and sells on fixed rules. Replays Binance's real daily candles,
 * dead coins included. Pure and deterministic: no I/O, and every decision on day d
 * uses only candles up to d.
 *
 * Each day d:
 *   1. At the open: sell what yesterday's close flagged, then buy yesterday's signals
 *      (signals fill at the NEXT open, never at the close that produced them).
 *   2. During the day: stop-loss / trailing stop (resting orders: fill at the stop, or
 *      at the open if the coin gaps below it), then take-profit levels.
 *   3. At the close: value the book; flag failed breakouts and time stops for
 *      tomorrow's open; sell at the close a coin with no candle tomorrow (delisted or
 *      halted — its last price is the exit).
 *   4. On a signal close (every day, or Sundays for weekly): look for breakouts.
 *
 * Costs on every fill: the exchange fee, half the spread, and price impact that grows
 * with the order's share of the coin's daily volume (the square-root rule:
 * daily volatility × √(order ÷ daily volume)).
 */

export type Timeframe = 'daily' | 'weekly';
export interface TakeProfit {
  /** Gain over the entry price that triggers it, in percent. */
  gainPct: number;
  /** Share of the original position sold there, in percent. */
  sellPct: number;
}

export interface MoonParams {
  timeframe: Timeframe;
  /** Length of the base in bars of the timeframe (days or weeks). */
  baseBars: number;
  /** The base's height — highest close ÷ lowest close − 1 — at most this, in percent. */
  maxRangePct: number;
  /** The breakout close must clear the base's highest close by this much, in percent. */
  breakoutPct: number;
  /** The breakout bar's volume must be at least this many times the base's average. */
  volumeMult: number;
  /** Median daily USDT volume over the last 30 days, at least. */
  minDailyVolumeUsd: number;
  /** A coin must have traded this many days before it can be bought. */
  minListedDays: number;
  /** Only buy while BTC closes above its 200-day average. */
  btcFilter: boolean;
  /** Equal-size position slots. */
  slots: number;
  /** New buys per signal close, at most. */
  maxNewPerDay: number;
  /** Sell if price falls this far below the entry, in percent (0 = off). */
  stopLossPct: number;
  /** Sell if price falls this far below its highest close since entry, in percent (0 = off). */
  trailPct: number;
  /** Sell when a signal close falls back into the base (below its top − failBufferPct). */
  failExit: boolean;
  failBufferPct: number;
  takeProfits: TakeProfit[];
  /** Sell after this many days if the gain is still below timeStopMinGainPct (0 = off). */
  timeStopDays: number;
  timeStopMinGainPct: number;
  /** Days before a sold coin may be bought again. */
  cooldownDays: number;
  /** Exchange fee per fill, in percent. */
  feePct: number;
  /** Half the bid/ask spread paid on every fill, in percent. */
  spreadPct: number;
  /** An order is at most this share of the coin's median daily volume, in percent. */
  maxAdvPct: number;
  initialCash: number;
  startDate: string;
  endDate: string | null;
}

export type ExitReason = 'stop' | 'trail' | 'failed' | 'time' | 'target' | 'delisted' | 'halted' | 'end';

export interface MoonTrade {
  symbol: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  /** Average price of all the sells. */
  exitPrice: number;
  returnPct: number;
  pnlUsd: number;
  costUsd: number;
  holdDays: number;
  exitReason: ExitReason;
  /** Take-profit sells before the final exit. */
  partials: number;
  base: { top: number; bottom: number; rangePct: number; volumeSurge: number };
  /** The coin no longer trades on Binance. */
  delisted: boolean;
}

export interface MoonStats {
  trades: number;
  wins: number;
  winRatePct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Total gains ÷ total losses, in dollars. */
  profitFactor: number | null;
  bestTradePct: number | null;
  worstTradePct: number | null;
  avgHoldDays: number | null;
  /** Average share of the book in coins (not cash). */
  exposurePct: number;
  feesUsd: number;
  slippageUsd: number;
  /** Breakouts that passed every rule. */
  signals: number;
  /** …of which no slot was free. */
  skippedNoSlot: number;
  /** Breakouts on coins with too little volume. */
  skippedLiquidity: number;
  /** Share of signal closes on which the BTC filter allowed buying. */
  btcFilterOpenPct: number | null;
  pairsTraded: number;
}

export interface MoonSignal {
  symbol: string;
  close: number;
  top: number;
  rangePct: number;
  volumeSurge: number;
  dailyVolumeUsd: number;
}

export interface MoonResult {
  params: MoonParams;
  period: { start: string; end: string; days: number };
  universe: { pairs: number; delisted: number };
  metrics: { strategy: Metrics; btc: Metrics };
  stats: MoonStats;
  byYear: { year: number; strategyPct: number; btcPct: number; trades: number }[];
  exitReasons: { reason: ExitReason; count: number; avgReturnPct: number }[];
  trades: MoonTrade[];
  /** Daily equity, both curves starting from the same cash. */
  equity: { dates: string[]; strategy: number[]; btc: number[] };
  /** Breakouts on the last signal close of the period (whether or not a slot was free). */
  latestSignals: { date: string | null; btcFilterOpen: boolean; coins: MoonSignal[] };
}

const MIN_ORDER_USD = 10;
const MAX_IMPACT = 0.2;

interface Bars {
  s: Series;
  /** Bar number of index 0 (day number, or week number). */
  start: number;
  close: Float64Array;
  volume: Float64Array;
  /** Over the base window (the baseBars bars before i); NaN when the window has a gap. */
  top: Float64Array;
  bottom: Float64Array;
  avgVolume: Float64Array;
}

interface Position {
  s: Series;
  qty: number;
  qty0: number;
  entryDay: number;
  entryPrice: number;
  costUsd: number;
  proceedsUsd: number;
  exitQty: number;
  exitValue: number;
  peakClose: number;
  lastClose: number;
  nextTarget: number;
  partials: number;
  base: MoonTrade['base'];
}

interface PendingEntry {
  s: Series;
  usd: number;
  adv: number;
  sigma: number;
  base: MoonTrade['base'];
}

/** Monday-based week number of a day (day 0, 1970-01-01, was a Thursday). */
const weekOf = (d: number) => Math.floor((d + 3) / 7);
const isSunday = (d: number) => (d + 3) % 7 === 6;

const at = (s: Series, arr: Float64Array, d: number) => (d >= s.start && d < s.start + s.n ? arr[d - s.start] : NaN);

const buildBars = (s: Series, P: MoonParams): Bars | null => {
  let start: number;
  let close: Float64Array;
  let volume: Float64Array;
  if (P.timeframe === 'daily') {
    start = s.start;
    close = s.close;
    volume = s.volume;
  } else {
    start = weekOf(s.start);
    const n = weekOf(s.start + s.n - 1) - start + 1;
    close = new Float64Array(n).fill(NaN);
    volume = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const monday = 7 * (start + i) - 3;
      let vol = 0;
      let ok = true;
      for (let d = monday; d <= monday + 6; d++) {
        const c = at(s, s.close, d);
        if (!Number.isFinite(c)) {
          ok = false;
          break;
        }
        vol += at(s, s.volume, d);
      }
      if (ok) {
        close[i] = at(s, s.close, monday + 6);
        volume[i] = vol;
      }
    }
  }
  const n = close.length;
  const B = P.baseBars;
  if (n <= B) return null;
  const top = new Float64Array(n).fill(NaN);
  const bottom = new Float64Array(n).fill(NaN);
  const avgVolume = new Float64Array(n).fill(NaN);
  const gaps = new Int32Array(n + 1);
  const volSum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const bad = !Number.isFinite(close[i]) || !Number.isFinite(volume[i]);
    gaps[i + 1] = gaps[i] + (bad ? 1 : 0);
    volSum[i + 1] = volSum[i] + (bad ? 0 : volume[i]);
  }
  // Monotonic queues over the window [i − B, i − 1].
  const maxQ: number[] = [];
  const minQ: number[] = [];
  let maxH = 0;
  let minH = 0;
  for (let i = 1; i < n; i++) {
    const j = i - 1;
    if (Number.isFinite(close[j])) {
      while (maxQ.length > maxH && close[maxQ[maxQ.length - 1]] <= close[j]) maxQ.pop();
      maxQ.push(j);
      while (minQ.length > minH && close[minQ[minQ.length - 1]] >= close[j]) minQ.pop();
      minQ.push(j);
    }
    while (maxH < maxQ.length && maxQ[maxH] < i - B) maxH++;
    while (minH < minQ.length && minQ[minH] < i - B) minH++;
    if (i - B >= 0 && gaps[i] - gaps[i - B] === 0 && maxH < maxQ.length) {
      top[i] = close[maxQ[maxH]];
      bottom[i] = close[minQ[minH]];
      avgVolume[i] = (volSum[i] - volSum[i - B]) / B;
    }
  }
  return { s, start, close, volume, top, bottom, avgVolume };
};

/** Median daily USDT volume and daily volatility (of log returns) over the 30 days ending on `d`. */
const liquidity = (s: Series, d: number): { adv: number; sigma: number } => {
  const vols: number[] = [];
  const rets: number[] = [];
  let prev = NaN;
  for (let k = d - 29; k <= d; k++) {
    const v = at(s, s.volume, k);
    const c = at(s, s.close, k);
    if (Number.isFinite(v)) vols.push(v);
    if (Number.isFinite(c) && Number.isFinite(prev) && prev > 0) rets.push(Math.log(c / prev));
    prev = c;
  }
  vols.sort((a, b) => a - b);
  const adv = vols.length ? (vols.length % 2 ? vols[(vols.length - 1) / 2] : (vols[vols.length / 2 - 1] + vols[vols.length / 2]) / 2) : 0;
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sigma = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0.05;
  return { adv, sigma };
};

const sig = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(8)) : x);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface MoonRun {
  totalDays: number;
  doneDays: () => number;
  /** Run up to `days` more days; true once the period is finished. */
  step: (days: number) => boolean;
  result: () => MoonResult;
}

export const createMoonRun = (h: History, P: MoonParams): MoonRun => {
  const btc = h.btc;
  // BTC's 200-day average (needs 200 closes before the first day).
  const sma200 = new Float64Array(btc.n).fill(NaN);
  {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < btc.n; i++) {
      const c = btc.close[i];
      if (Number.isFinite(c)) {
        sum += c;
        count++;
      }
      if (i >= 200) {
        const o = btc.close[i - 200];
        if (Number.isFinite(o)) {
          sum -= o;
          count--;
        }
      }
      if (i >= 199 && count === 200) sma200[i] = sum / 200;
    }
  }
  const startDay = Math.max(dateToDay(P.startDate), btc.start + 200);
  const endDay = Math.min(P.endDate ? dateToDay(P.endDate) : h.lastDay, btc.start + btc.n - 1);
  if (endDay <= startDay) throw new Error('The backtest period is empty — pick a start date before the end date.');

  const bars: Bars[] = [];
  for (const s of h.series) {
    if (!canBuy(s.symbol)) continue;
    if (s.start + s.n - 1 < startDay - 1 || s.start > endDay) continue;
    const b = buildBars(s, P);
    if (b) bars.push(b);
  }
  const barOf = (d: number) => (P.timeframe === 'daily' ? d : weekOf(d));
  const isSignalClose = (d: number) => P.timeframe === 'daily' || isSunday(d);
  const targets = [...P.takeProfits].filter((t) => t.gainPct > 0 && t.sellPct > 0).sort((a, b) => a.gainPct - b.gainPct);

  let cash = P.initialCash;
  const positions = new Map<string, Position>();
  const pendingExits = new Map<string, ExitReason>();
  let pendingEntries: PendingEntry[] = [];
  const cooldown = new Map<string, number>();
  const trades: MoonTrade[] = [];
  const traded = new Set<string>();
  const dates: string[] = [];
  const eqS: number[] = [];
  const eqB: number[] = [];
  let feesUsd = 0;
  let slippageUsd = 0;
  let exposureSum = 0;
  let signals = 0;
  let skippedNoSlot = 0;
  let skippedLiquidity = 0;
  let signalCloses = 0;
  let filterOpen = 0;
  let latest: MoonResult['latestSignals'] = { date: null, btcFilterOpen: false, coins: [] };

  const btcOpen0 = at(btc, btc.open, startDay);
  const btcQty = (P.initialCash * (1 - P.feePct / 100)) / btcOpen0;

  const costOf = (usd: number, adv: number, sigma: number) =>
    P.spreadPct / 100 + Math.min(MAX_IMPACT, adv > 0 ? sigma * Math.sqrt(usd / adv) : MAX_IMPACT);

  const closeTrade = (p: Position, d: number, reason: ExitReason) => {
    positions.delete(p.s.symbol);
    pendingExits.delete(p.s.symbol);
    cooldown.set(p.s.symbol, d + P.cooldownDays);
    trades.push({
      symbol: p.s.symbol,
      entryDate: dayToDate(p.entryDay),
      exitDate: dayToDate(d),
      entryPrice: sig(p.entryPrice),
      exitPrice: sig(p.exitValue / Math.max(p.exitQty, 1e-30)),
      returnPct: r2((p.proceedsUsd / p.costUsd - 1) * 100),
      pnlUsd: r2(p.proceedsUsd - p.costUsd),
      costUsd: r2(p.costUsd),
      holdDays: d - p.entryDay,
      exitReason: reason,
      partials: p.partials,
      base: p.base,
      delisted: !p.s.trading
    });
  };

  /** Sell `qty` at `price` on day d (costs from the coin's liquidity up to d − 1). */
  const sell = (p: Position, qty: number, price: number, d: number) => {
    const { adv, sigma } = liquidity(p.s, d - 1);
    const fill = price * (1 - costOf(qty * price, adv, sigma));
    const gross = qty * fill;
    const fee = (gross * P.feePct) / 100;
    cash += gross - fee;
    feesUsd += fee;
    slippageUsd += qty * (price - fill);
    p.proceedsUsd += gross - fee;
    p.exitQty += qty;
    p.exitValue += qty * price;
    p.qty -= qty;
  };

  const exitAll = (p: Position, price: number, d: number, reason: ExitReason) => {
    sell(p, p.qty, price, d);
    closeTrade(p, d, reason);
  };

  let d = startDay;
  const runDay = (day: number) => {
    // 1. The open: exits first (they free cash and slots), then entries.
    for (const [symbol, reason] of [...pendingExits]) {
      const p = positions.get(symbol);
      if (!p) continue;
      const o = at(p.s, p.s.open, day);
      exitAll(p, Number.isFinite(o) ? o : p.lastClose, day, reason);
    }
    pendingExits.clear();
    for (const e of pendingEntries) {
      const o = at(e.s, e.s.open, day);
      const usd = Math.min(e.usd, cash);
      if (!Number.isFinite(o) || usd < MIN_ORDER_USD || positions.has(e.s.symbol)) continue;
      const fill = o * (1 + costOf(usd, e.adv, e.sigma));
      const fee = (usd * P.feePct) / 100;
      const qty = (usd - fee) / fill;
      cash -= usd;
      feesUsd += fee;
      slippageUsd += qty * (fill - o);
      positions.set(e.s.symbol, {
        s: e.s,
        qty,
        qty0: qty,
        entryDay: day,
        entryPrice: o,
        costUsd: usd,
        proceedsUsd: 0,
        exitQty: 0,
        exitValue: 0,
        peakClose: o,
        lastClose: o,
        nextTarget: 0,
        partials: 0,
        base: e.base
      });
      traded.add(e.s.symbol);
    }
    pendingEntries = [];

    // 2. During the day: stops (checked first — the cautious order when both are hit), then targets.
    for (const p of [...positions.values()]) {
      const o = at(p.s, p.s.open, day);
      const hi = at(p.s, p.s.high, day);
      const lo = at(p.s, p.s.low, day);
      if (!Number.isFinite(lo)) continue;
      const hard = P.stopLossPct > 0 ? p.entryPrice * (1 - P.stopLossPct / 100) : 0;
      const trail = P.trailPct > 0 ? p.peakClose * (1 - P.trailPct / 100) : 0;
      const level = Math.max(hard, trail);
      if (level > 0 && lo <= level) {
        exitAll(p, Math.min(o, level), day, trail > hard ? 'trail' : 'stop');
        continue;
      }
      while (p.nextTarget < targets.length && p.qty > 0) {
        const t = targets[p.nextTarget];
        const px = p.entryPrice * (1 + t.gainPct / 100);
        if (!(hi >= px)) break;
        const qty = Math.min(p.qty, (p.qty0 * t.sellPct) / 100);
        sell(p, qty, Math.max(o, px), day);
        p.nextTarget++;
        p.partials++;
      }
      if (p.qty <= p.qty0 * 1e-9) closeTrade(p, day, 'target');
    }

    // 3. The close.
    let invested = 0;
    for (const p of [...positions.values()]) {
      const c = at(p.s, p.s.close, day);
      if (Number.isFinite(c)) {
        p.lastClose = c;
        p.peakClose = Math.max(p.peakClose, c);
      }
      if (day < endDay && !Number.isFinite(at(p.s, p.s.close, day + 1))) {
        const ended = day >= p.s.start + p.s.n - 1;
        exitAll(p, p.lastClose, day, ended && !p.s.trading ? 'delisted' : 'halted');
        continue;
      }
      if (P.failExit && isSignalClose(day) && p.lastClose < p.base.top * (1 - P.failBufferPct / 100)) pendingExits.set(p.s.symbol, 'failed');
      else if (P.timeStopDays > 0 && day - p.entryDay >= P.timeStopDays && p.lastClose < p.entryPrice * (1 + P.timeStopMinGainPct / 100)) pendingExits.set(p.s.symbol, 'time');
      invested += p.qty * p.lastClose;
    }
    const equity = cash + invested;
    dates.push(dayToDate(day));
    eqS.push(r2(equity));
    eqB.push(r2(btcQty * (at(btc, btc.close, day) || at(btc, btc.close, day - 1))));
    exposureSum += equity > 0 ? invested / equity : 0;

    // 4. Breakouts on a signal close.
    if (!isSignalClose(day)) return;
    signalCloses++;
    const bc = at(btc, btc.close, day);
    const sma = sma200[day - btc.start];
    const open = !P.btcFilter || (Number.isFinite(sma) && bc > sma);
    if (open) filterOpen++;
    const bar = barOf(day);
    const found: (MoonSignal & { b: Bars; bottom: number; adv: number; sigma: number })[] = [];
    for (const b of bars) {
      const i = bar - b.start;
      if (i < 0 || i >= b.close.length) continue;
      const c = b.close[i];
      const top = b.top[i];
      if (!(c >= top * (1 + P.breakoutPct / 100))) continue;
      const rangePct = (top / b.bottom[i] - 1) * 100;
      if (rangePct > P.maxRangePct) continue;
      const surge = b.volume[i] / b.avgVolume[i];
      if (!(surge >= P.volumeMult)) continue;
      if (day - b.s.start < P.minListedDays) continue;
      const { adv, sigma } = liquidity(b.s, day);
      if (adv < P.minDailyVolumeUsd) {
        skippedLiquidity++;
        continue;
      }
      found.push({ symbol: b.s.symbol, close: sig(c), top: sig(top), rangePct: r2(rangePct), volumeSurge: r2(surge), dailyVolumeUsd: Math.round(adv), b, bottom: b.bottom[i], adv, sigma });
    }
    found.sort((a, b) => b.volumeSurge - a.volumeSurge || a.symbol.localeCompare(b.symbol));
    latest = { date: dayToDate(day), btcFilterOpen: open, coins: found.map(({ b: _b, bottom: _bo, adv: _a, sigma: _s, ...rest }) => rest) };
    if (!open || day >= endDay) return;
    const eligible = found.filter((f) => !positions.has(f.symbol) && (cooldown.get(f.symbol) ?? -Infinity) <= day);
    signals += eligible.length;
    const free = Math.max(0, Math.min(P.maxNewPerDay, P.slots - (positions.size - pendingExits.size)));
    const take = eligible.slice(0, free);
    skippedNoSlot += eligible.length - take.length;
    const slot = equity / P.slots;
    for (const f of take) {
      pendingEntries.push({
        s: f.b.s,
        usd: Math.min(slot, (f.adv * P.maxAdvPct) / 100),
        adv: f.adv,
        sigma: f.sigma,
        base: { top: f.top, bottom: sig(f.bottom), rangePct: f.rangePct, volumeSurge: f.volumeSurge }
      });
    }
  };

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const p of [...positions.values()]) exitAll(p, p.lastClose, endDay, 'end');
  };

  const result = (): MoonResult => {
    finish();
    const wins = trades.filter((t) => t.pnlUsd > 0);
    const losses = trades.filter((t) => t.pnlUsd <= 0);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const grossWin = wins.reduce((a, t) => a + t.pnlUsd, 0);
    const grossLoss = -losses.reduce((a, t) => a + t.pnlUsd, 0);
    const years = [...new Set(dates.map((x) => Number(x.slice(0, 4))))];
    const byYear = years.map((year) => {
      const idx = dates.map((x, i) => (Number(x.slice(0, 4)) === year ? i : -1)).filter((i) => i >= 0);
      const first = idx[0];
      const last = idx[idx.length - 1];
      const baseS = first > 0 ? eqS[first - 1] : P.initialCash;
      const baseB = first > 0 ? eqB[first - 1] : P.initialCash;
      return {
        year,
        strategyPct: r2((eqS[last] / baseS - 1) * 100),
        btcPct: r2((eqB[last] / baseB - 1) * 100),
        trades: trades.filter((t) => Number(t.entryDate.slice(0, 4)) === year).length
      };
    });
    const reasons = [...new Set(trades.map((t) => t.exitReason))].map((reason) => {
      const ts = trades.filter((t) => t.exitReason === reason);
      return { reason, count: ts.length, avgReturnPct: r2(mean(ts.map((t) => t.returnPct)) ?? 0) };
    });
    return {
      params: P,
      period: { start: dayToDate(startDay), end: dayToDate(endDay), days: endDay - startDay + 1 },
      universe: { pairs: bars.length, delisted: bars.filter((b) => !b.s.trading).length },
      metrics: { strategy: computeMetrics(eqS, P.initialCash), btc: computeMetrics(eqB, P.initialCash) },
      stats: {
        trades: trades.length,
        wins: wins.length,
        winRatePct: trades.length ? r2((wins.length / trades.length) * 100) : null,
        avgWinPct: wins.length ? r2(mean(wins.map((t) => t.returnPct))!) : null,
        avgLossPct: losses.length ? r2(mean(losses.map((t) => t.returnPct))!) : null,
        profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
        bestTradePct: trades.length ? Math.max(...trades.map((t) => t.returnPct)) : null,
        worstTradePct: trades.length ? Math.min(...trades.map((t) => t.returnPct)) : null,
        avgHoldDays: trades.length ? r2(mean(trades.map((t) => t.holdDays))!) : null,
        exposurePct: r2((exposureSum / Math.max(1, dates.length)) * 100),
        feesUsd: r2(feesUsd),
        slippageUsd: r2(slippageUsd),
        signals,
        skippedNoSlot,
        skippedLiquidity,
        btcFilterOpenPct: P.btcFilter && signalCloses ? r2((filterOpen / signalCloses) * 100) : null,
        pairsTraded: traded.size
      },
      byYear,
      exitReasons: reasons.sort((a, b) => b.count - a.count),
      trades,
      equity: { dates, strategy: eqS, btc: eqB },
      latestSignals: latest
    };
  };

  return {
    totalDays: endDay - startDay + 1,
    doneDays: () => d - startDay,
    step: (days: number) => {
      const stop = Math.min(endDay, d + days - 1);
      for (; d <= stop; d++) runDay(d);
      return d > endDay;
    },
    result
  };
};

/** Run a whole backtest in one go (the CLI and tests). */
export const runMoonBacktest = (h: History, P: MoonParams): MoonResult => {
  const run = createMoonRun(h, P);
  while (!run.step(365));
  return run.result();
};
