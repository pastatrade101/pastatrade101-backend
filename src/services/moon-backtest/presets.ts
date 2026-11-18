import type { MoonParams, TakeProfit } from './engine';

/**
 * The starting rules: daily closes, a 6-month base, wide exits, buying only while BTC is
 * above its 200-day average. Daily closes came out ahead of weekly ones in the first
 * comparison (2019 → 2026-11) — the earlier entry is worth more than the extra fakeouts cost.
 */
export const DEFAULT_PARAMS: MoonParams = {
  timeframe: 'daily',
  baseBars: 180,
  maxRangePct: 150,
  breakoutPct: 2,
  volumeMult: 2,
  minDailyVolumeUsd: 250_000,
  minListedDays: 180,
  btcFilter: true,
  slots: 10,
  maxNewPerDay: 3,
  stopLossPct: 25,
  trailPct: 40,
  failExit: true,
  failBufferPct: 5,
  takeProfits: [],
  timeStopDays: 0,
  timeStopMinGainPct: 0,
  cooldownDays: 30,
  feePct: 0.1,
  spreadPct: 0.1,
  maxAdvPct: 1,
  initialCash: 1000,
  startDate: '2019-01-01',
  endDate: null
};

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const date = (v: unknown, fallback: string | null) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : fallback);

/** Rules from a request (or the CLI), clamped to sane ranges; anything missing takes the default. */
export const normalizeParams = (input: Partial<Record<keyof MoonParams, unknown>> = {}, base: MoonParams = DEFAULT_PARAMS): MoonParams => {
  const timeframe = input.timeframe === 'daily' || input.timeframe === 'weekly' ? input.timeframe : base.timeframe;
  // Switching timeframe without a base length keeps the base the same length in time.
  const baseBarsFallback = timeframe === base.timeframe ? base.baseBars : timeframe === 'daily' ? base.baseBars * 7 : Math.round(base.baseBars / 7);
  const targets: TakeProfit[] = Array.isArray(input.takeProfits)
    ? input.takeProfits
        .map((t) => t as Partial<TakeProfit>)
        // A level of zero or below is dropped, not clamped up to something nobody asked for.
        .filter((t) => Number(t?.gainPct) > 0 && Number(t?.sellPct) > 0)
        .map((t) => ({ gainPct: num(t.gainPct, 0, 1, 100_000), sellPct: num(t.sellPct, 0, 1, 100) }))
        .slice(0, 5)
    : base.takeProfits;
  return {
    timeframe,
    baseBars: Math.round(num(input.baseBars, baseBarsFallback, timeframe === 'daily' ? 20 : 4, timeframe === 'daily' ? 730 : 104)),
    maxRangePct: num(input.maxRangePct, base.maxRangePct, 10, 1000),
    breakoutPct: num(input.breakoutPct, base.breakoutPct, 0, 50),
    volumeMult: num(input.volumeMult, base.volumeMult, 0, 20),
    minDailyVolumeUsd: num(input.minDailyVolumeUsd, base.minDailyVolumeUsd, 0, 1e9),
    minListedDays: Math.round(num(input.minListedDays, base.minListedDays, 0, 2000)),
    btcFilter: bool(input.btcFilter, base.btcFilter),
    slots: Math.round(num(input.slots, base.slots, 1, 50)),
    maxNewPerDay: Math.round(num(input.maxNewPerDay, base.maxNewPerDay, 1, 50)),
    stopLossPct: num(input.stopLossPct, base.stopLossPct, 0, 95),
    trailPct: num(input.trailPct, base.trailPct, 0, 95),
    failExit: bool(input.failExit, base.failExit),
    failBufferPct: num(input.failBufferPct, base.failBufferPct, 0, 50),
    takeProfits: targets,
    timeStopDays: Math.round(num(input.timeStopDays, base.timeStopDays, 0, 1000)),
    timeStopMinGainPct: num(input.timeStopMinGainPct, base.timeStopMinGainPct, -100, 1000),
    cooldownDays: Math.round(num(input.cooldownDays, base.cooldownDays, 0, 365)),
    feePct: num(input.feePct, base.feePct, 0, 2),
    spreadPct: num(input.spreadPct, base.spreadPct, 0, 5),
    maxAdvPct: num(input.maxAdvPct, base.maxAdvPct, 0.01, 100),
    initialCash: num(input.initialCash, base.initialCash, 50, 1e9),
    startDate: date(input.startDate, base.startDate) ?? DEFAULT_PARAMS.startDate,
    endDate: input.endDate === null ? null : date(input.endDate, base.endDate)
  };
};

/**
 * The comparison set: the same idea with one thing changed at a time, so the table
 * shows what each choice is worth — daily vs weekly closes, base length, exit width,
 * the BTC filter, taking profits, and the failed-breakout exit.
 */
export const COMPARE_SET: { name: string; params: Partial<MoonParams> }[] = [
  { name: 'Daily · 6-month base · wide exits', params: {} },
  { name: 'Weekly · 6-month base · wide exits', params: { timeframe: 'weekly', baseBars: 26 } },
  { name: 'Daily · 1-year base', params: { baseBars: 365, maxRangePct: 200 } },
  { name: 'Daily · 3-month base', params: { baseBars: 90, maxRangePct: 100 } },
  { name: 'Daily · tight exits (stop 15%, trail 25%)', params: { stopLossPct: 15, trailPct: 25 } },
  { name: 'Daily · no BTC filter', params: { btcFilter: false } },
  { name: 'Daily · take profits (⅓ at +100%, ⅓ at +300%)', params: { takeProfits: [{ gainPct: 100, sellPct: 33 }, { gainPct: 300, sellPct: 33 }] } },
  { name: 'Daily · no failed-breakout exit', params: { failExit: false } },
  { name: 'Daily · 5 bigger slots', params: { slots: 5 } }
];
