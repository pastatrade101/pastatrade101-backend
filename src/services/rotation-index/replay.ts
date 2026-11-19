import { loadPriceMatrix, type PriceMatrix } from '../rotation-backtest/rotationData.service';
import { cached } from '../../utils/cache';
import { buildIndexView, INDEXES, stepRotationIndex, type IndexId } from './rotationIndex.service';

// Replays the Rotation Index over a chosen period on the saved prices — a check, never
// saved — next to holding BTC and the top-10 index over exactly the same days.
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
  key: 'bull' | 'bear' | 'recent';
  label: string;
  from: string;
  to: string;
  btc_pct: number;
}

/** The replay's limits and a few ready-made periods (BTC's best and worst 90 days, and the last 90). Cached 10 min. */
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
  const recent = Math.max(lo, hi - PERIOD_DAYS);
  periods.push({ key: 'recent', label: `Last ${PERIOD_DAYS} days`, from: m.dates[recent], to: maxTo, btc_pct: r2(change(recent, hi) ?? 0) });

  return { min_from: minFrom, max_to: maxTo, periods };
};

/** Average lengths the BTC trend switch accepts (0 = off). */
export const BTC_TREND_MIN = 10;
export const BTC_TREND_MAX = 400;

/**
 * One replay of the period, cached 10 min per period. With `btcTrendDays`, the same rule is
 * also run with the BTC trend switch (cash on review days when BTC closes below its
 * N-day average); BTC and the top 10 come from the plain run, so every line starts on
 * the same day.
 */
export const replayRotationIndex = (id: IndexId, from: string, to: string, btcTrendDays = 0) =>
  cached(
    `rotation:replay:${id}:${from}:${to}:${btcTrendDays}`,
    async () => {
      if (!isoDate.test(from) || !isoDate.test(to)) throw new Error('Dates must be YYYY-MM-DD.');
      if (btcTrendDays && (!Number.isInteger(btcTrendDays) || btcTrendDays < BTC_TREND_MIN || btcTrendDays > BTC_TREND_MAX)) {
        throw new Error(`The BTC average must be ${BTC_TREND_MIN} to ${BTC_TREND_MAX} days.`);
      }
      const style = INDEXES[id].config.style;
      const m = await loadPriceMatrix();
      const { minFrom, maxTo } = bounds(m, style.lookbackDays);
      if (from < minFrom) throw new Error(`The earliest start is ${minFrom}: before it there are no saved market caps to pick the top ${style.universeSize} by.`);
      if (to > maxTo) throw new Error(`The latest end is ${maxTo}, the newest final day.`);
      if (to < shift(from, style.rebalanceDays + 1)) throw new Error(`Pick at least ${style.rebalanceDays + 1} days, so the period has a review and its fill.`);

      const [run, switched] = await Promise.all([
        stepRotationIndex(id, { dryRun: true, start: true, from, to, matrix: m }),
        btcTrendDays ? stepRotationIndex(id, { dryRun: true, start: true, from, to, matrix: m, btcTrendDays }) : Promise.resolve(null)
      ]);
      if (!run.rows?.length) throw new Error('Nothing to replay in that period.');
      const v = buildIndexView(id, run.rows, m);
      if (!v.started) throw new Error('Nothing to replay in that period.');

      let btcSwitch = null;
      let switchedNav = new Map<string, number>();
      if (switched?.rows?.length) {
        const rows = switched.rows;
        const w = buildIndexView(id, rows, m);
        switchedNav = new Map(rows.map((r) => [r.date, r2(r.nav)]));
        // Stretches fully in cash, after the start day (every run starts the day in cash).
        const cashRanges: { from: string; to: string }[] = [];
        for (const r of rows.slice(1)) {
          const inCash = r.state.cash / r.nav > 0.99;
          const open = cashRanges[cashRanges.length - 1];
          if (inCash && open && open.to === shift(r.date, -1)) open.to = r.date;
          else if (inCash) cashRanges.push({ from: r.date, to: r.date });
        }
        btcSwitch = {
          days: btcTrendDays,
          latest: { return_pct: w.latest.return_pct, max_drawdown_pct: w.latest.max_drawdown_pct },
          holdings: w.holdings,
          // An empty ranking is the switch at work: BTC was below its average that day.
          changes: w.reviews.filter((r) => r.adds.length || r.sells.length).map((r) => ({ ...r, btc_below: r.ranking.length === 0 })),
          cash_days: cashRanges.reduce((n, c) => n + (Date.parse(c.to) - Date.parse(c.from)) / DAY + 1, 0),
          measured_days: rows.length - 1,
          cash_ranges: cashRanges
        };
      }

      return {
        from: v.start_date,
        to: v.last_date,
        days: v.days,
        reviews: run.rows.filter((r) => r.review).length,
        latest: v.latest,
        holdings: v.holdings,
        changes: v.reviews.filter((r) => r.adds.length || r.sells.length),
        series: v.series.map((p) => ({ ...p, switched: switchedNav.get(p.date) ?? null })),
        btc_switch: btcSwitch,
        warnings: [...new Set([...run.warnings, ...(switched?.warnings ?? [])])]
      };
    },
    600
  );
