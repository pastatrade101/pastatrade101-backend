/**
 * Rotation Index — tests for the daily step (pure, no I/O).
 * Run:  npm run test:index
 */
import type { RankRow } from '../services/rotation-backtest/engine';
import { newIndexState, stepDay, type DayInput, type IndexConfig, type IndexState } from '../services/rotation-index/indexEngine';
import { STYLES } from '../services/rotation-bot/planner';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const cfg: IndexConfig = { style: STYLES.balanced, feePct: 0.1, base: 100, top10Size: 2, top10RebalanceDays: 30 };
const day = (i: number) => new Date(Date.UTC(2026, 10, 11 + i)).toISOString().slice(0, 10);
const rows = (...coins: string[]): RankRow[] => coins.map((coin, i) => ({ coin, rank: i + 1, score: 1 - i / 10 }));

type Prices = Record<string, number | null>;
const input = (i: number, prices: Prices, ranking: RankRow[] = rows('a', 'b', 'c', 'd', 'e', 'f', 'g'), caps: Record<string, number> = { bitcoin: 3, a: 1 }): DayInput => ({
  date: day(i),
  price: (c) => prices[c] ?? null,
  universe: () => ranking.map((r) => r.coin),
  ranking: () => ranking,
  top10: (n) => Object.entries(caps).map(([coin, marketCap]) => ({ coin, marketCap })).slice(0, n)
});
const flat: Prices = { bitcoin: 100, a: 10, b: 20, c: 40, d: 1, e: 2, f: 3, g: 4 };

console.log('start');
let s: IndexState = newIndexState(100);
const d0 = stepDay(s, input(0, flat), cfg);
check('day 0 is a review and trades nothing yet', d0.trades.length === 0 && d0.review?.adds.join() === 'a,b,c');
check('all three lines start at 100', d0.nav === 100 && d0.btc === 100 && d0.top10 === 100);
check('orders wait for the next day', d0.state.pending?.adds.join() === 'a,b,c' && d0.state.lastReview === day(0));
s = JSON.parse(JSON.stringify(d0.state)); // the state goes through jsonb between days

console.log('first fills');
const d1 = stepDay(s, input(1, flat), cfg);
check('buys the three at the next day close', d1.trades.filter((t) => t.side === 'BUY').map((t) => t.coin).join() === 'a,b,c');
check('equal weight, fee on every buy', near(d1.state.holdings.a.units * 10, 100 / 3, 1e-9) && near(d1.state.holdings.a.cost, (100 / 3) * 1.001));
check('never spends more than it has', d1.state.cash >= -1e-9 && d1.state.cash < 1e-6, String(d1.state.cash));
check('nav ≈ 100 minus fees', d1.nav < 100 && d1.nav > 99.89, String(d1.nav));
check('BTC yardstick bought on the first fill day', near(d1.btc, 100 / 1.001) && d1.state.startedOn === day(1));
check('top-10 yardstick weights by market cap', near(d1.state.top10.holdings.bitcoin * 100, 75 / 1.001, 1e-6) && near(d1.state.top10.holdings.a * 10, 25 / 1.001, 1e-6), JSON.stringify(d1.state.top10));
check('pending cleared', d1.state.pending === null);
s = d1.state;

console.log('between reviews');
const up: Prices = { ...flat, a: 20, bitcoin: 110 };
const d3 = stepDay(s, input(3, up), cfg);
check('no review mid-week', d3.review === null && d3.trades.length === 0);
check('nav follows the holdings', near(d3.nav, d1.nav + d1.state.holdings.a.units * 10), `${d3.nav}`);
check('BTC follows BTC', near(d3.btc, (100 / 1.001) * 1.1));
const gap = stepDay(d3.state, input(4, { ...up, b: null }), cfg);
check('a missing price is valued at the last one seen', near(gap.nav, d3.nav));
s = gap.state;

console.log('weekly review');
const d7 = stepDay(s, input(7, up, rows('a', 'd', 'e', 'f', 'g', 'b', 'c')), cfg);
check('review on day 7', d7.review !== null && d7.state.lastReview === day(7));
check('sells the ones outside the hold band (b #6, c #7)', d7.review!.sells.map((x) => x.coin).sort().join() === 'b,c' && d7.review!.keep.join() === 'a');
check('fills the free slots with the best not held', d7.review!.adds.join() === 'd,e');
const d8 = stepDay(d7.state, input(8, { ...up, c: null }), cfg);
check('a sell with no price waits', !!d8.state.holdings.c && d8.state.pending?.sells.map((x) => x.coin).join() === 'c');
check('…and still holds its slot (only one new coin fits)', d8.trades.filter((t) => t.side === 'BUY').map((t) => t.coin).join() === 'd');
const d9 = stepDay(d8.state, input(9, up), cfg);
check('the waiting sell fills when the price is back', !d9.state.holdings.c && d9.state.pending === null);
check('cash never goes negative', d9.state.cash >= -1e-9);

console.log('top-10 reweighting');
let st = d9.state;
for (let i = 10; i <= 30; i += 1) st = stepDay(st, input(i, up), cfg).state;
const d31 = stepDay(st, input(31, up, undefined, { bitcoin: 1, a: 1 }), cfg);
check('reweights 30 days after the start', d31.top10Trades.length > 0 && d31.state.top10.lastRebalance === day(31));
const w = d31.state.top10.holdings;
check('to the new market-cap weights', near(w.bitcoin * 110, w.a * 20, 1e-3), `${w.bitcoin * 110} vs ${w.a * 20}`);

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll rotation index tests passed.');
process.exit(failures ? 1 : 0);
