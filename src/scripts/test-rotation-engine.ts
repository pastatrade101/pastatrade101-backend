/**
 * Rotation Backtest engine — tests.
 * Run:  npx tsx src/scripts/test-rotation-engine.ts
 * Pure functions, no I/O — exits non-zero on any failure.
 */
import { decide, rankAt, runRotation, scoreAt, type EngineInput, type EngineParams } from '../services/rotation-backtest/engine';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const N = 120;
const dates = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
const growth = (daily: number, start = 100) => Array.from({ length: N }, (_, i) => start * (1 + daily) ** i);

const base: EngineParams = { signal: 'momentum', filter: 'none', lookbackDays: 10, topN: 2, worstRankHeld: 3, rebalanceDays: 1, feePct: 0, initialCash: 10000 };
const make = (prices: Record<string, (number | null)[]>, params: Partial<EngineParams> = {}, startIndex = 10): EngineInput => ({
  dates,
  prices,
  btc: prices.bitcoin ?? growth(0.001),
  startIndex,
  params: { ...base, ...params }
});

console.log('scores');
{
  const p = growth(0.01);
  check('momentum = L-day return', near(scoreAt('momentum', p, p, 20, 10), 1.01 ** 10 - 1));
  const down = growth(-0.01);
  check('positive filter drops a falling coin', Number.isNaN(scoreAt('momentum', down, p, 20, 10, 'positive')));
  check('positive filter keeps a rising coin', near(scoreAt('momentum', p, p, 20, 10, 'positive'), 1.01 ** 10 - 1));
  check('beat_btc filter drops BTC itself (ties do not beat)', Number.isNaN(scoreAt('momentum', p, p, 20, 10, 'beat_btc')));
  check('beat_btc filter keeps a coin outrunning BTC', Number.isFinite(scoreAt('momentum', growth(0.02), p, 20, 10, 'beat_btc')));
  check('no score before warm-up', Number.isNaN(scoreAt('momentum', p, p, 5, 10)));
  const gap: (number | null)[] = [...p];
  gap[10] = null;
  check('missing lookback bar → unrankable', Number.isNaN(scoreAt('momentum', gap, p, 20, 10)));
  const ranks = rankAt({ prices: { b: growth(0.01), a: growth(0.01), c: growth(0.02) }, btc: p }, 'momentum', 10, 30);
  check('ranks best first, id breaks ties', ranks.map((r) => r.coin).join(',') === 'c,a,b', ranks.map((r) => r.coin).join(','));
}

console.log('rotation mechanics');
{
  // Fixed ordering: d > c > b > a. With topN = 2 it should hold c and d, nothing else.
  const prices = { a: growth(0.001), b: growth(0.002), c: growth(0.003), d: growth(0.004), bitcoin: growth(0.001) };
  const r = runRotation(make(prices));
  const firstBuy = r.events[0];
  check('first fill happens on the bar after the signal', firstBuy?.date === dates[11], firstBuy?.date);
  check('buys the top 2 (bitcoin is in the universe too)', firstBuy?.bought.slice().sort().join(',') === 'c,d', firstBuy?.bought.join(','));
  check('never exceeds topN slots', r.events.every((e) => e.held.length <= 2));
  check('stable ranking → no churn (only the final exit trades)', r.trades.every((t) => t.exitReason === 'end') && r.trades.length === 2);
  check('equity starts at initial cash', r.equity.strategy[0] === 10000);
}
{
  // Hold band: c leads, then fades to rank 3 (inside worstRankHeld = 3) → kept.
  // With worstRankHeld = 2 the same fade must trigger a sell.
  const fade = Array.from({ length: N }, (_, i) => (i < 40 ? 100 * 1.004 ** i : 100 * 1.004 ** 40 * 1.0025 ** (i - 40)));
  const prices = { a: growth(0.001), b: growth(0.003), c: fade, d: growth(0.0035) };
  const kept = runRotation(make(prices, { worstRankHeld: 3 }));
  const cut = runRotation(make(prices, { worstRankHeld: 2 }));
  const soldOnRank = (res: typeof kept) => res.trades.some((t) => t.coin === 'c' && t.exitReason === 'rank');
  check('hold band keeps a holding that slips to rank 3 of band 3', !soldOnRank(kept));
  check('tighter band (2) sells it', soldOnRank(cut));
}
{
  // A coin whose data stops is unrankable → liquidated.
  const dies: (number | null)[] = growth(0.01).map((v, i) => (i > 50 ? null : v));
  const r = runRotation(make({ a: growth(0.001), b: growth(0.002), dies }, { topN: 1, worstRankHeld: 1 }));
  check('unrankable holding is queued for sale', r.trades.some((t) => t.coin === 'dies'), r.trades.map((t) => `${t.coin}:${t.exitReason}`).join(' '));
}

{
  // Everything falls → the positive filter holds cash; no filter stays invested.
  const prices = { a: growth(-0.002), b: growth(-0.003), c: growth(-0.001) };
  const inCash = runRotation(make(prices, { filter: 'positive' }));
  const invested = runRotation(make(prices, { filter: 'none' }));
  check('positive filter sits in cash through a falling market', inCash.stats.trades === 0 && inCash.metrics.strategy.finalEquity === 10000);
  check('no filter stays invested and loses', invested.stats.exposurePct > 90 && invested.metrics.strategy.finalEquity < 10000);
}

console.log('fees and accounting');
{
  const prices = { a: growth(0.001), b: growth(0.002), c: growth(0.003) };
  const free = runRotation(make(prices, { feePct: 0 }));
  const paid = runRotation(make(prices, { feePct: 0.5 }));
  check('fees lower final equity', paid.metrics.strategy.finalEquity < free.metrics.strategy.finalEquity);
  check('fees are counted', paid.stats.totalFees > 0 && free.stats.totalFees === 0);
  // Flat prices + 0.5% fee on buy and sell → each trade loses ~1%.
  const flat = { a: new Array(N).fill(50), b: new Array(N).fill(80) };
  const f = runRotation(make(flat, { feePct: 0.5, topN: 2 }));
  check('flat market: each trade nets ≈ −1% after two 0.5% fees', f.trades.every((t) => near(t.returnPct, (0.995 / 1.005 - 1) * 100, 1e-9)));
  check('all positions closed on the last bar', f.trades.length === 2 && f.trades.every((t) => t.exitDate === dates[N - 1]));
}
{
  const btc = growth(0.002);
  const r = runRotation(make({ a: growth(0.001), bitcoin: btc }, { feePct: 0 }));
  const expect = 10000 * (btc[N - 1] / btc[11]);
  check('BTC benchmark = buy on first fill bar, hold to the end', near(r.metrics.btc.finalEquity, expect), `${r.metrics.btc.finalEquity} vs ${expect}`);
}

console.log('lookahead');
{
  // Bump-last-bar test (from the PyBroker skill): changing only the final bar must not
  // change any earlier equity value or any earlier decision.
  const prices = { a: growth(0.001), b: growth(0.004), c: growth(0.003), d: growth(0.002) };
  const bumped = { ...prices, a: [...prices.a.slice(0, N - 1), prices.a[N - 1] * 5] };
  for (const signal of ['momentum', 'risk_adjusted'] as const) {
    for (const filter of ['none', 'positive', 'beat_btc'] as const) {
      const x = runRotation(make(prices, { signal, filter }));
      const y = runRotation(make(bumped, { signal, filter }));
      const sameEquity = x.equity.strategy.slice(0, -1).every((v, i) => v === y.equity.strategy[i]);
      const sameEvents = JSON.stringify(x.events.filter((e) => e.date < dates[N - 1])) === JSON.stringify(y.events.filter((e) => e.date < dates[N - 1]));
      check(`${signal}/${filter}: earlier bars unchanged when the last bar moves`, sameEquity && sameEvents);
    }
  }
}

console.log('rebalance cadence');
{
  const prices = { a: growth(0.001), b: growth(0.002), c: growth(0.003) };
  const daily = runRotation(make(prices, { rebalanceDays: 1 }));
  const weekly = runRotation(make(prices, { rebalanceDays: 7 }));
  check('weekly rebalances ≈ 1/7 as often', weekly.stats.rebalances === Math.ceil((N - 1 - 10) / 7), String(weekly.stats.rebalances));
  check('daily rebalances every bar but the last', daily.stats.rebalances === N - 1 - 10);
}

console.log('rule plan (what a review on the last day says)');
{
  // Fixed ordering d > c > b > a; topN 2 holds c, d → a review today keeps both.
  const prices = { a: growth(0.001), b: growth(0.002), c: growth(0.003), d: growth(0.004) };
  const r = runRotation(make(prices, { rebalanceDays: 7 }));
  check('plan keeps what the rule holds when nothing changed', r.plan.keep.join(',') === 'c,d' && !r.plan.drop.length && !r.plan.add.length);
  check('plan is dated on the last bar', r.plan.asOf === dates[N - 1]);
  // Reviews at bars 10, 17, …; last review before bar 119 is 115; next is 122 → 3 days after the end.
  check('last review = most recent review bar', r.plan.lastReview === dates[115], r.plan.lastReview ?? 'null');
  check('next review = next cadence step after the data', r.plan.nextReview === '2025-05-03', r.plan.nextReview);
  check('no cash slots when fully invested', r.plan.cashSlots === 0);
}
{
  // A holding that fails the filter on the last day must be listed as a drop,
  // and the free slot either refilled or left as cash.
  const late = growth(0.004).map((v, i) => (i >= N - 12 ? growth(0.004)[N - 13] * 0.97 ** (i - (N - 13)) : v));
  const prices = { a: growth(0.001), b: growth(0.002), late };
  const r = runRotation(make(prices, { topN: 1, worstRankHeld: 1, filter: 'positive', rebalanceDays: 30 }));
  const dropped = r.plan.drop.find((x) => x.coin === 'late');
  check('a holding that stopped qualifying is listed as a drop', !!dropped, JSON.stringify(r.plan));
  check('its slot is refilled from the ranking', r.plan.add.length + r.plan.cashSlots === 1);
}
{
  // Plan uses the same rules as the backtest: replaying decide() on the final ranking matches.
  const prices = { a: growth(0.001), b: growth(0.004), c: growth(0.003), d: growth(0.002) };
  const r = runRotation(make(prices));
  const same = decide(r.finalHoldings.map((h) => h.coin).sort(), r.finalRanking, base);
  check('plan = decide(final holdings, final ranking)', JSON.stringify(same.adds) === JSON.stringify(r.plan.add) && same.keep.join() === r.plan.keep.join());
}

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll rotation engine tests passed.');
process.exit(failures ? 1 : 0);
