import { loadPriceMatrix, type PriceMatrix } from '../rotation-backtest/rotationData.service';
import { cached } from '../../utils/cache';
import { INDEX_EXTRAS, loadReplayMatrix } from './extras';
import { buildIndexView, INDEXES, stepRotationIndex, type IndexId } from './rotationIndex.service';

// Replays the Rotation Index over a chosen period on the saved prices — a check, never
// saved. It runs twice, with and without the stock tokens, so the two can be compared
// against holding BTC and the top-10 index over exactly the same days.
//
// The earliest start is the first day with saved market caps (each review picks the
// top 20 by THAT day's market cap; before those days the cut would use today's sizes,
// which is hindsight). The coin list is today's Binance list.

const PERIOD_DAYS = 90;
const DAY = 86_400_000;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

const bounds = (m: PriceMatrix, lookbackDays: number) => {
  const firstWithCaps = m.coingeckoFrom ?? m.dates[0];
  const earliestRanked = m.dates[Math.min(lookbackDays, m.dates.length - 1)];
  return {
    minFrom: firstWithCaps > earliestRanked ? firstWithCaps : earliestRanked,
    maxTo: m.dates[m.dates.length - 2]
  };
};

export interface ReplayPeriod {
  key: 'bull' | 'bear' | 'stocks' | 'recent';
  label: string;
  from: string;
  to: string;
  btc_pct: number;
}

/** The replay's limits and a few ready-made periods (BTC's best and worst 90 days, and since the stock tokens can be ranked). Cached 10 min. */
export const replayPeriods = (id: IndexId) => cached(`rotation:replay-periods:${id}`, () => findPeriods(id), 600);

const findPeriods = async (id: IndexId) => {
  const style = INDEXES[id].config.style;
  const m = await loadPriceMatrix();
  const { minFrom, maxTo } = bounds(m, style.lookbackDays);
  const btc = m.prices.bitcoin ?? [];
  const lo = m.dates.indexOf(minFrom);
  const hi = m.dates.indexOf(maxTo);
  // BTC from the period's first fill day (the day after the start), as the replay's BTC line starts.
  const change = (a: number, b: number) => (btc[a + 1] && btc[b] ? (btc[b]! / btc[a + 1]! - 1) * 100 : null);

  let best: { i: number; pct: number } | null = null;
  let worst: { i: number; pct: number } | null = null;
  for (let i = lo; i >= 0 && i + PERIOD_DAYS <= hi; i += 1) {
    const pct = change(i, i + PERIOD_DAYS);
    if (pct == null) continue;
    if (!best || pct > best.pct) best = { i, pct };
    if (!worst || pct < worst.pct) worst = { i, pct };
  }
  const periods: ReplayPeriod[] = [];
  if (best) periods.push({ key: 'bull', label: `BTC's best ${PERIOD_DAYS} days`, from: m.dates[best.i], to: m.dates[best.i + PERIOD_DAYS], btc_pct: r2(best.pct) });
  if (worst) periods.push({ key: 'bear', label: `BTC's worst ${PERIOD_DAYS} days`, from: m.dates[worst.i], to: m.dates[worst.i + PERIOD_DAYS], btc_pct: r2(worst.pct) });

  // From the day all the stock tokens have a full ranking window.
  const { matrix } = await loadReplayMatrix();
  const firstPriced = INDEX_EXTRAS.map((x) => matrix.prices[x.id]?.findIndex((v) => v != null) ?? -1);
  if (firstPriced.every((i) => i >= 0)) {
    const i = Math.max(...firstPriced) + style.lookbackDays;
    if (i < hi && m.dates[i] >= minFrom) {
      const pct = change(i, hi);
      periods.push({ key: 'stocks', label: 'Since the stock tokens can be ranked', from: m.dates[i], to: maxTo, btc_pct: r2(pct ?? 0) });
    }
  }
  const recent = Math.max(lo, hi - PERIOD_DAYS);
  periods.push({ key: 'recent', label: `Last ${PERIOD_DAYS} days`, from: m.dates[recent], to: maxTo, btc_pct: r2(change(recent, hi) ?? 0) });

  return { min_from: minFrom, max_to: maxTo, periods };
};

/** One replay of the period, with and without the stock tokens. Cached 10 min per period. */
export const replayRotationIndex = (id: IndexId, from: string, to: string) =>
  cached(
    `rotation:replay:${id}:${from}:${to}`,
    async () => {
      if (!isoDate.test(from) || !isoDate.test(to)) throw new Error('Dates must be YYYY-MM-DD.');
      const style = INDEXES[id].config.style;
      const [base, replay] = await Promise.all([loadPriceMatrix(), loadReplayMatrix()]);
      const { minFrom, maxTo } = bounds(base, style.lookbackDays);
      if (from < minFrom) throw new Error(`The earliest start is ${minFrom}: before it there are no saved market caps to pick the top ${style.universeSize} by.`);
      if (to > maxTo) throw new Error(`The latest end is ${maxTo}, the newest final day.`);
      if (to < shift(from, style.rebalanceDays + 1)) throw new Error(`Pick at least ${style.rebalanceDays + 1} days, so the period has a review and its fill.`);

      const [withStocks, cryptoOnly] = await Promise.all([
        stepRotationIndex(id, { dryRun: true, start: true, from, to, matrix: replay.matrix }),
        stepRotationIndex(id, { dryRun: true, start: true, from, to, matrix: base })
      ]);
      if (!withStocks.rows?.length || !cryptoOnly.rows?.length) throw new Error('Nothing to replay in that period.');
      const a = buildIndexView(id, withStocks.rows, replay.matrix);
      const b = buildIndexView(id, cryptoOnly.rows, base);
      if (!a.started || !b.started) throw new Error('Nothing to replay in that period.');

      const stockSymbols = new Set(INDEX_EXTRAS.map((x) => x.symbol));
      const firstPrice = (xid: string) => {
        const k = replay.matrix.prices[xid]?.findIndex((v) => v != null) ?? -1;
        return k >= 0 ? replay.matrix.dates[k] : null;
      };
      const isStock = (c: string) => INDEX_EXTRAS.some((x) => x.id === c);
      const stockDays = withStocks.rows.filter((r) => Object.keys(r.state.holdings).some(isStock)).length;
      // Reviews where a stock token ranked inside the hold band: even when it isn't bought,
      // it pushes a held coin one place down, and that coin may be sold sooner.
      const stockInBand = withStocks.rows.filter((r) => r.review?.ranking.some((x) => isStock(x.coin) && x.rank <= style.worstRankHeld)).length;
      return {
        from: a.start_date,
        to: a.last_date,
        days: a.days,
        reviews: withStocks.rows.filter((r) => r.review).length,
        stock_prices_fetched: replay.fetched,
        with_stocks: {
          latest: a.latest,
          holdings: a.holdings,
          changes: a.reviews.filter((r) => r.adds.length || r.sells.length),
          /** Days on which at least one stock token was held. */
          stock_days: stockDays,
          /** Reviews with a stock token ranked inside the top `worst_rank_held`. */
          stock_in_band_reviews: stockInBand,
          stock_symbols: [...stockSymbols],
          /** First day each stock token has a Binance price (null: none yet). */
          stock_first_prices: INDEX_EXTRAS.map((x) => ({ symbol: x.symbol, from: firstPrice(x.id) }))
        },
        crypto_only: {
          latest: { return_pct: b.latest.return_pct, max_drawdown_pct: b.latest.max_drawdown_pct, nav: b.latest.nav },
          holdings: b.holdings,
          changes: b.reviews.filter((r) => r.adds.length || r.sells.length)
        },
        series: a.series.map((p, k) => ({ ...p, crypto_only: b.series[k]?.nav ?? null })),
        warnings: [...new Set([...withStocks.warnings, ...cryptoOnly.warnings])]
      };
    },
    600
  );
