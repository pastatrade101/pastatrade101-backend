/**
 * Moon backtest — tests for the engine, the coin filter, the rules parser and the zip reader.
 * Run:  npm run test:moon
 * No network — synthetic candles only. Exits non-zero on any failure.
 */
import { dayToDate, type History, type Series } from '../services/moon-backtest/data';
import { runMoonBacktest, type MoonParams } from '../services/moon-backtest/engine';
import { DEFAULT_PARAMS, normalizeParams } from '../services/moon-backtest/presets';
import { canBuy, wantPair } from '../services/moon-backtest/universe';
import { unzipFirst } from '../services/moon-backtest/zip';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** 2020-01-06, a Monday. */
const D0 = 18267;

/**
 * A pair from a close series (day k = start + k). Each day opens at the previous close,
 * the high/low sit `wick` around the body, volume is per day (USDT). `opens` overrides
 * individual opens (for gaps).
 */
const mk = (symbol: string, start: number, closes: number[], vol: number | number[] = 1_000_000, opts: { trading?: boolean; wick?: number; opens?: Record<number, number> } = {}): Series => {
  const n = closes.length;
  const f = () => new Float64Array(n);
  const s: Series = { symbol, start, n, open: f(), high: f(), low: f(), close: f(), volume: f(), trading: opts.trading ?? true };
  const w = opts.wick ?? 0.005;
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    const o = opts.opens?.[i] ?? (i ? closes[i - 1] : c);
    s.open[i] = o;
    s.close[i] = c;
    s.high[i] = Math.max(o, c) * (1 + w);
    s.low[i] = Math.min(o, c) * (1 - w);
    s.volume[i] = Array.isArray(vol) ? vol[i] : vol;
  }
  return s;
};

/** BTC rising gently from 300 days before D0, so it sits above its 200-day average. */
const btcUp = (days = 1000) => mk('BTCUSDT', D0 - 300, Array.from({ length: days }, (_, i) => 10_000 * 1.001 ** i), 1e9);
const btcDown = (days = 1000) => mk('BTCUSDT', D0 - 300, Array.from({ length: days }, (_, i) => 10_000 * 0.999 ** i), 1e9);

const hist = (btc: Series, ...series: Series[]): History => ({
  btc,
  series,
  firstDay: btc.start,
  lastDay: Math.max(btc.start + btc.n - 1, ...series.map((s) => s.start + s.n - 1)),
  delisted: series.filter((s) => !s.trading).length
});

/** Daily rules small enough for synthetic data: a 60-day base, everything else plain. */
const P = (over: Partial<MoonParams> = {}): MoonParams => ({
  ...DEFAULT_PARAMS,
  timeframe: 'daily',
  baseBars: 60,
  maxRangePct: 50,
  breakoutPct: 2,
  volumeMult: 2,
  minDailyVolumeUsd: 0,
  minListedDays: 0,
  btcFilter: true,
  slots: 5,
  maxNewPerDay: 5,
  stopLossPct: 0,
  trailPct: 0,
  failExit: false,
  takeProfits: [],
  timeStopDays: 0,
  cooldownDays: 0,
  feePct: 0,
  spreadPct: 0,
  maxAdvPct: 100,
  initialCash: 1000,
  startDate: dayToDate(D0),
  endDate: null,
  ...over
});

/**
 * A coin that sits in a 0.95–1.05 range for 100 days, breaks out on day 100 (close
 * 1.2 on 5× volume), then follows `after` (closes from day 101 on).
 */
const BREAK = 100;
const baseThenBreak = (symbol: string, after: number[], { vol = 1e6, trading = true, start = D0, opens = {} as Record<number, number> } = {}) => {
  const closes = [...Array.from({ length: BREAK }, (_, i) => (i % 2 ? 0.95 : 1.05)), 1.2, ...after];
  const v = closes.map((_, i) => (i === BREAK ? vol * 5 : vol));
  return mk(symbol, start, closes, v, { trading, opens });
};
const flat = (x: number, n: number) => Array.from({ length: n }, () => x);

console.log('entry timing and look-ahead');
{
  // The period ends on the coin's last candle (BTC's history runs longer).
  const lastDay = dayToDate(D0 + BREAK + 50);
  const r = runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(1.3, 50))), P({ endDate: lastDay }));
  const t = r.trades[0];
  check('one trade', r.trades.length === 1, `${r.trades.length}`);
  check('bought at the NEXT open after the breakout close', t?.entryDate === dayToDate(D0 + BREAK + 1), t?.entryDate);
  check('entry price is that open (the breakout close)', near(t?.entryPrice ?? 0, 1.2), `${t?.entryPrice}`);
  check('the base top is the highest close of the 60 days before', near(t?.base.top ?? 0, 1.05), `${t?.base.top}`);
  check('volume surge recorded (5×)', near(t?.base.volumeSurge ?? 0, 5, 1e-3), `${t?.base.volumeSurge}`);
  check('held to the end, valued at the last close', t?.exitReason === 'end' && near(t.exitPrice, 1.3), `${t?.exitReason} ${t?.exitPrice}`);
  // Cutting the history the day after the entry must not change the entry.
  const cut = runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(1.3, 50))), P({ endDate: dayToDate(D0 + BREAK + 1) }));
  check('same entry with the future removed', cut.trades[0]?.entryDate === t?.entryDate && near(cut.trades[0]?.entryPrice ?? 0, t?.entryPrice ?? 0));
  const later = runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(0.5, 50))), P());
  check('a crash after the entry does not move the entry', later.trades[0]?.entryDate === t?.entryDate);
}

console.log('base and volume rules');
{
  const tall = mk('TALLUSDT', D0, [...Array.from({ length: BREAK }, (_, i) => (i % 2 ? 0.5 : 1.05)), 1.2, ...flat(1.3, 20)], Array.from({ length: 121 }, (_, i) => (i === BREAK ? 5e6 : 1e6)));
  check('no buy when the base is taller than maxRangePct', runMoonBacktest(hist(btcUp(), tall), P()).trades.length === 0);
  check('…but a buy when maxRangePct allows it', runMoonBacktest(hist(btcUp(), tall), P({ maxRangePct: 200 })).trades.length === 1);
  const quiet = mk('QUIETUSDT', D0, [...Array.from({ length: BREAK }, (_, i) => (i % 2 ? 0.95 : 1.05)), 1.2, ...flat(1.3, 20)], 1e6);
  check('no buy without a volume surge', runMoonBacktest(hist(btcUp(), quiet), P()).trades.length === 0);
  check('no buy when the close is under top + breakoutPct', runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(1.3, 20))), P({ breakoutPct: 20 })).trades.length === 0);
  const r = runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(1.3, 20), { vol: 1000 })), P({ minDailyVolumeUsd: 100_000 }));
  check('no buy on a coin under minDailyVolumeUsd (counted as skipped)', r.trades.length === 0 && r.stats.skippedLiquidity > 0, `${r.stats.skippedLiquidity}`);
  check('no buy before the coin has traded minListedDays', runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(1.3, 20))), P({ minListedDays: 200 })).trades.length === 0);
}

console.log('BTC filter');
{
  const coin = () => baseThenBreak('AAAUSDT', flat(1.3, 20));
  check('no buy while BTC is below its 200-day average', runMoonBacktest(hist(btcDown(), coin()), P()).trades.length === 0);
  check('buys with the filter off', runMoonBacktest(hist(btcDown(), coin()), P({ btcFilter: false })).trades.length === 1);
}

console.log('exits');
{
  // Stop: 20% below 1.2 = 0.96. Gap open at 0.9 → fills at the open, not the stop.
  const gap = baseThenBreak('AAAUSDT', [1.25, 0.88, 0.88], { opens: { 102: 0.9 } });
  const g = runMoonBacktest(hist(btcUp(), gap), P({ stopLossPct: 20 })).trades[0];
  check('stop-loss on a gap fills at the open', g?.exitReason === 'stop' && near(g.exitPrice, 0.9), `${g?.exitReason} ${g?.exitPrice}`);
  // No gap: the day's low crosses the stop → fills at the stop.
  const slide = baseThenBreak('AAAUSDT', [1.25, 1.0, 0.9, 0.9]);
  const s = runMoonBacktest(hist(btcUp(), slide), P({ stopLossPct: 20 })).trades[0];
  check('stop-loss without a gap fills at the stop price', s?.exitReason === 'stop' && near(s.exitPrice, 0.96), `${s?.exitReason} ${s?.exitPrice}`);
  // Trail 40% from the highest close (2.0) → 1.2.
  const run = baseThenBreak('AAAUSDT', [1.5, 2.0, 1.7, 1.3, 1.1, 1.1]);
  const tr = runMoonBacktest(hist(btcUp(), run), P({ stopLossPct: 25, trailPct: 40 })).trades[0];
  check('trailing stop exits at 40% under the highest close', tr?.exitReason === 'trail' && near(tr.exitPrice, 1.2), `${tr?.exitReason} ${tr?.exitPrice}`);
  // Failed breakout: closes back below 1.05 × 0.95 → sold at the next open.
  const fail = baseThenBreak('AAAUSDT', [1.1, 0.97, 0.97, 0.97]);
  const f = runMoonBacktest(hist(btcUp(), fail), P({ failExit: true, failBufferPct: 5 })).trades[0];
  check('failed breakout sells at the next open', f?.exitReason === 'failed' && f.exitDate === dayToDate(D0 + BREAK + 3) && near(f.exitPrice, 0.97), `${f?.exitReason} ${f?.exitDate} ${f?.exitPrice}`);
  // Delisted: the series stops while held, and the pair no longer trades.
  const dead = baseThenBreak('DEADUSDT', [1.1, 0.6], { trading: false });
  const dl = runMoonBacktest(hist(btcUp(), dead), P()).trades[0];
  check('a delisted coin is sold at its last close', dl?.exitReason === 'delisted' && near(dl.exitPrice, 0.6) && dl.delisted, `${dl?.exitReason} ${dl?.exitPrice}`);
  const pause = baseThenBreak('HALTUSDT', [1.1, 0.6]);
  const hl = runMoonBacktest(hist(btcUp(), pause), P()).trades[0];
  check('a coin whose candles stop while still listed is sold as halted', hl?.exitReason === 'halted' && !hl.delisted, `${hl?.exitReason}`);
  // Time stop: 10 days, still under +5% → sold.
  const stuck = baseThenBreak('AAAUSDT', flat(1.21, 30));
  const ts = runMoonBacktest(hist(btcUp(), stuck), P({ timeStopDays: 10, timeStopMinGainPct: 5 })).trades[0];
  check('time stop sells a coin that went nowhere', ts?.exitReason === 'time' && ts.holdDays === 11, `${ts?.exitReason} ${ts?.holdDays}`);
  // Take profit: a third at +100% (2.4), then the rest at the end (3.0).
  const moon = baseThenBreak('AAAUSDT', [1.5, 2.5, 3.0, 3.0]);
  const tp = runMoonBacktest(hist(btcUp(), moon), P({ endDate: dayToDate(D0 + BREAK + 4), takeProfits: [{ gainPct: 100, sellPct: 33 }] })).trades[0];
  check('take-profit sells part and keeps the rest', tp?.partials === 1 && tp.exitReason === 'end', `${tp?.partials} ${tp?.exitReason}`);
  const expect = 0.33 * 2.4 + 0.67 * 3.0;
  check('average exit price reflects both sells', near(tp?.exitPrice ?? 0, expect, 1e-6), `${tp?.exitPrice} vs ${expect}`);
}

console.log('costs');
{
  // Buy at 1.2 and sell at 1.2: the round trip costs 2 × (fee + spread) plus a tiny impact.
  const c = runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(1.2, 10), { vol: 1e12 })), P({ feePct: 0.1, spreadPct: 0.1 }));
  const t = c.trades[0];
  check('round trip at the same price loses about 0.4%', !!t && t.returnPct < -0.39 && t.returnPct > -0.41, `${t?.returnPct}`);
  check('fees and slippage are reported', c.stats.feesUsd > 0 && c.stats.slippageUsd > 0);
  // A thin coin pays more impact for the same order.
  const thin = runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(1.2, 10), { vol: 20_000 })), P({ feePct: 0.1, spreadPct: 0.1 })).trades[0];
  check('a thin coin costs more to trade', (thin?.returnPct ?? 0) < (t?.returnPct ?? 0), `${thin?.returnPct} vs ${t?.returnPct}`);
  const capped = runMoonBacktest(hist(btcUp(), baseThenBreak('AAAUSDT', flat(1.2, 10), { vol: 20_000 })), P({ maxAdvPct: 1 })).trades[0];
  check('an order is capped at maxAdvPct of daily volume', near(capped?.costUsd ?? 0, 200), `${capped?.costUsd}`);
}

console.log('slots and weekly closes');
{
  const coins = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map((s, k) => baseThenBreak(s, flat(1.3, 20), { vol: 1e6 * (k + 1) }));
  const r = runMoonBacktest(hist(btcUp(), ...coins), P({ slots: 2 }));
  check('no more positions than slots', r.trades.length === 2, `${r.trades.length}`);
  check('the third breakout is counted as skipped (no slot)', r.stats.skippedNoSlot === 1, `${r.stats.skippedNoSlot}`);
  check('each slot gets an equal share of the book', near(r.trades[0].costUsd, 500) && near(r.trades[1].costUsd, 500), r.trades.map((t) => t.costUsd).join(','));
  const one = runMoonBacktest(hist(btcUp(), ...coins), P({ maxNewPerDay: 1 }));
  check('maxNewPerDay limits buys per signal close', one.trades.length === 1);
  // Weekly: 20 weeks of a flat base, then a breakout week.
  const days = 7 * 30;
  const closes = Array.from({ length: days }, (_, i) => (i < 7 * 21 ? (Math.floor(i / 7) % 2 ? 0.95 : 1.05) : 1.3));
  const vol = closes.map((_, i) => (i >= 7 * 21 && i < 7 * 22 ? 5e6 : 1e6));
  const w = runMoonBacktest(hist(btcUp(), mk('WWWUSDT', D0, closes, vol)), P({ timeframe: 'weekly', baseBars: 20 }));
  const t = w.trades[0];
  check('weekly: one trade', w.trades.length === 1, `${w.trades.length}`);
  check('weekly: bought on the Monday after the breakout week', t?.entryDate === dayToDate(D0 + 7 * 22), t?.entryDate);
}

console.log('coin filter');
{
  check('BTC is the benchmark, not a buy', wantPair('BTCUSDT') && !canBuy('BTCUSDT'));
  for (const s of ['BTCUPUSDT', 'ETHDOWNUSDT', 'BULLUSDT', 'XRPBEARUSDT', 'USDCUSDT', 'FDUSDUSDT', 'EURUSDT', 'PAXGUSDT', 'XAUTUSDT', 'WBTCUSDT', 'AAPLBUSDT', 'TSLABUSDT', 'BTCBUSD']) check(`skips ${s}`, !wantPair(s));
  for (const s of ['JUPUSDT', 'SYRUPUSDT', 'SOLUSDT', 'LUNAUSDT', 'WAVESUSDT', 'PEPEUSDT']) check(`keeps ${s}`, canBuy(s));
}

console.log('rules from a request');
{
  const n = normalizeParams({ slots: '999', stopLossPct: -5, timeframe: 'weekly', startDate: 'nope', takeProfits: [{ gainPct: 100, sellPct: 50 }, { gainPct: -1, sellPct: 10 }] });
  check('numbers are clamped', n.slots === 50 && n.stopLossPct === 0, `${n.slots} ${n.stopLossPct}`);
  check('switching to weekly keeps the base about the same length in time', n.baseBars === Math.round(DEFAULT_PARAMS.baseBars / 7), `${n.baseBars}`);
  check('a bad date falls back to the default', n.startDate === DEFAULT_PARAMS.startDate);
  check('bad take-profit levels are dropped', n.takeProfits.length === 1 && n.takeProfits[0].gainPct === 100);
  check('no input gives the defaults', JSON.stringify(normalizeParams({})) === JSON.stringify(DEFAULT_PARAMS));
}

console.log('zip reader');
{
  const zip = Buffer.from('UEsDBBQAAAAIAAqacl3hVcngLwAAAEEAAAAQAAAAWC0xZC0yMDI0LTAxLmNzdhWKwQkAMAwC/51Fgra1Ifsv1uRQhEMlL19uDlBMNxjVK2hcP+TjGiAx3B7uGFwfUEsBAhQDFAAAAAgACppyXeFVyeAvAAAAQQAAABAAAAAAAAAAAAAAAIABAAAAAFgtMWQtMjAyNC0wMS5jc3ZQSwUGAAAAAAEAAQA+AAAAXQAAAAAA', 'base64');
  const csv = unzipFirst(zip).toString();
  check('reads the CSV inside a Binance-style zip', csv.startsWith('1704067200000,1.0,1.2,0.9,1.1,100'), csv.slice(0, 40));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
