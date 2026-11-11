import type { RankRow } from '../rotation-backtest/engine';
import { planReview, reviewStatus, type BotStyle, type DropReason } from '../rotation-bot/planner';

// The Rotation Index: the rotation rule tracked forward on paper, one day at a time,
// from the day it starts. Unlike the backtest it never looks back with hindsight —
// each review picks from the coins that are big on THAT day, and its decisions are
// saved and never recomputed. Same mechanics as the Lab's engine: decide on a review
// day's close, fill at the next day's close, equal weight 1/topN of equity at the
// fill, a fee on every buy and sell. Two yardsticks start on the first fill day:
// holding BTC, and a plain top-10 index weighted by market cap, reweighted monthly.
//
// Pure — every price, ranking and universe comes in through `DayInput`, so the
// service decides where data comes from and the tests can feed made-up days.

export interface IndexConfig {
  style: BotStyle;
  feePct: number;
  /** Index points at the start (all three lines start here). */
  base: number;
  top10Size: number;
  top10RebalanceDays: number;
}

export interface IndexHolding {
  units: number;
  entryDate: string;
  /** Points spent including the entry fee. */
  cost: number;
}

export interface PendingReview {
  decided: string;
  sells: { coin: string; reason: DropReason }[];
  adds: string[];
}

export interface IndexState {
  cash: number;
  holdings: Record<string, IndexHolding>;
  lastReview: string | null;
  pending: PendingReview | null;
  /** First fill day — the yardsticks start here. */
  startedOn: string | null;
  btcUnits: number | null;
  top10: { cash: number; holdings: Record<string, number>; lastRebalance: string | null };
  /** Last known price per coin, for valuing a holding on a day its price is missing. */
  lastPrice: Record<string, number>;
}

export interface Trade {
  side: 'BUY' | 'SELL';
  coin: string;
  price: number;
  units: number;
  /** Points bought or sold, before the fee. */
  value: number;
  fee: number;
  reason: string;
}

export interface ReviewRecord {
  universe: string[];
  ranking: RankRow[];
  keep: string[];
  sells: { coin: string; reason: DropReason }[];
  adds: string[];
  fillsOn: 'next day';
}

export interface DayInput {
  date: string;
  /** Saved close on this date, or null when the coin has no price that day. */
  price: (coin: string) => number | null;
  /** Coins the rule may pick from on this date, biggest first (asked for on review days only). */
  universe: () => string[];
  /** The style's ranking of those coins on this date. */
  ranking: (universe: string[]) => RankRow[];
  /** Top coins by market cap on this date with their caps (asked for on reweighting days only). */
  top10: (size: number) => { coin: string; marketCap: number }[];
}

export interface DayResult {
  state: IndexState;
  nav: number;
  btc: number;
  top10: number;
  trades: Trade[];
  review: ReviewRecord | null;
  top10Trades: Trade[];
}

export const newIndexState = (base: number): IndexState => ({
  cash: base,
  holdings: {},
  lastReview: null,
  pending: null,
  startedOn: null,
  btcUnits: null,
  top10: { cash: base, holdings: {}, lastRebalance: null },
  lastPrice: {}
});

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const valid = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;

export const stepDay = (prev: IndexState, day: DayInput, cfg: IndexConfig): DayResult => {
  const s: IndexState = structuredClone(prev);
  const fee = cfg.feePct / 100;
  const { topN } = cfg.style;
  const trades: Trade[] = [];
  const top10Trades: Trade[] = [];

  const today = new Map<string, number>();
  const px = (coin: string): number | null => {
    if (!today.has(coin)) {
      const v = day.price(coin);
      if (valid(v)) {
        today.set(coin, v);
        s.lastPrice[coin] = v;
      }
    }
    return today.get(coin) ?? null;
  };
  /** Today's price, or the last one seen — for valuing, never for filling. */
  const mark = (coin: string) => px(coin) ?? s.lastPrice[coin] ?? 0;

  // 1) Fill yesterday's review at today's close: sells first, then buys.
  if (s.pending && s.pending.decided < day.date) {
    const waiting: PendingReview['sells'] = [];
    for (const order of s.pending.sells) {
      const h = s.holdings[order.coin];
      if (!h) continue;
      const p = px(order.coin);
      if (p == null) {
        waiting.push(order); // no price today: the sell (and its slot) waits for tomorrow
        continue;
      }
      const value = h.units * p;
      const f = value * fee;
      s.cash += value - f;
      trades.push({ side: 'SELL', coin: order.coin, price: p, units: h.units, value, fee: f, reason: order.reason });
      delete s.holdings[order.coin];
    }
    const equity = s.cash + Object.entries(s.holdings).reduce((v, [c, h]) => v + h.units * mark(c), 0);
    const target = equity / topN;
    for (const coin of s.pending.adds) {
      if (Object.keys(s.holdings).length >= topN) break; // an unfilled sell still holds its slot
      const p = px(coin);
      if (p == null) continue; // can't fill: the slot stays empty until the next review
      const notional = Math.min(target, s.cash / (1 + fee));
      if (!(notional > target * 1e-6)) continue;
      const f = notional * fee;
      s.cash -= notional + f;
      s.holdings[coin] = { units: notional / p, entryDate: day.date, cost: notional + f };
      trades.push({ side: 'BUY', coin, price: p, units: notional / p, value: notional, fee: f, reason: 'new in the top' });
    }
    s.pending = waiting.length ? { ...s.pending, sells: waiting, adds: [] } : null;
    if (!s.startedOn && trades.length) s.startedOn = day.date;
  }

  // 2) The yardsticks start on the first fill day, at the same fee.
  if (s.startedOn && s.btcUnits == null) {
    const p = px('bitcoin');
    if (p != null) s.btcUnits = cfg.base / (1 + fee) / p;
  }
  const t10 = s.top10;
  if (s.startedOn && (!t10.lastRebalance || dayDiff(t10.lastRebalance, day.date) >= cfg.top10RebalanceDays)) {
    const members = day.top10(cfg.top10Size).filter((m) => m.marketCap > 0 && px(m.coin) != null);
    const totalCap = members.reduce((a, m) => a + m.marketCap, 0);
    if (members.length && totalCap > 0) {
      const value = t10.cash + Object.entries(t10.holdings).reduce((v, [c, u]) => v + u * mark(c), 0);
      const want = new Map(members.map((m) => [m.coin, (value * m.marketCap) / totalCap]));
      // Sell what is over its weight (or no longer a member), then buy what is under.
      for (const [coin, units] of Object.entries(t10.holdings)) {
        const p = px(coin);
        if (p == null) continue;
        const excess = units * p - (want.get(coin) ?? 0);
        if (excess <= value * 1e-9) continue;
        const f = excess * fee;
        t10.cash += excess - f;
        t10.holdings[coin] = units - excess / p;
        if (t10.holdings[coin] <= 1e-12) delete t10.holdings[coin];
        top10Trades.push({ side: 'SELL', coin, price: p, units: excess / p, value: excess, fee: f, reason: 'reweight' });
      }
      const buys = members
        .map((m) => ({ coin: m.coin, p: px(m.coin)!, gap: want.get(m.coin)! - (t10.holdings[m.coin] ?? 0) * px(m.coin)! }))
        .filter((b) => b.gap > value * 1e-9);
      const need = buys.reduce((a, b) => a + b.gap * (1 + fee), 0);
      const scale = need > t10.cash ? t10.cash / need : 1;
      for (const b of buys) {
        const notional = b.gap * scale;
        const f = notional * fee;
        t10.cash -= notional + f;
        t10.holdings[b.coin] = (t10.holdings[b.coin] ?? 0) + notional / b.p;
        top10Trades.push({ side: 'BUY', coin: b.coin, price: b.p, units: notional / b.p, value: notional, fee: f, reason: 'reweight' });
      }
      t10.cash = Math.max(0, t10.cash);
      t10.lastRebalance = day.date;
    }
  }

  // 3) Value all three at today's close.
  const nav = s.cash + Object.entries(s.holdings).reduce((v, [c, h]) => v + h.units * mark(c), 0);
  const btc = s.btcUnits != null ? s.btcUnits * mark('bitcoin') : cfg.base;
  const top10 = s.startedOn ? t10.cash + Object.entries(t10.holdings).reduce((v, [c, u]) => v + u * mark(c), 0) : cfg.base;

  // 4) Review day: rank today's universe and queue tomorrow's orders. A sell still
  //    waiting for a price is decided again here, along with everything else.
  let review: ReviewRecord | null = null;
  if (reviewStatus(s.lastReview, day.date, cfg.style.rebalanceDays).due) {
    const universe = day.universe();
    const ranking = day.ranking(universe);
    const plan = planReview(Object.keys(s.holdings), ranking, new Set(universe), cfg.style);
    s.pending = plan.drops.length || plan.adds.length ? { decided: day.date, sells: plan.drops, adds: plan.adds } : null;
    s.lastReview = day.date;
    review = { universe, ranking: ranking.slice(0, 10), keep: plan.keep, sells: plan.drops, adds: plan.adds, fillsOn: 'next day' };
  }

  return { state: s, nav, btc, top10, trades, review, top10Trades };
};
