import { cacheGet, cacheSet } from '../../utils/cache';
import { getBgHistory, num, type BgRow } from '../sources/bgeometrics.client';
import { readSeries } from '../series/store';

// ─────────────────────────────────────────────────────────────────────────────
// Macro market data for the analyst page and the regime score — BGeometrics
// (Advanced plan): global M2, the US dollar index, gold, stablecoin supply and
// Bitcoin's rolling correlations with the S&P 500, the dollar and gold. All of
// it is daily/weekly data the provider refreshes at 03:00 UTC, so one fetch a
// day per series (cached in the client) is enough; the assembled payload is
// kept for an hour on top of that.
// ─────────────────────────────────────────────────────────────────────────────

type Pt = [string, number];

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const round = (n: number, d = 2) => Number(n.toFixed(d));
const pctChange = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b === 0 ? null : round((a / b - 1) * 100, 2));

/** Value on or before `date` in an ascending series (binary search). */
const valueAt = (pts: Pt[], date: string): number | null => {
  let lo = 0;
  let hi = pts.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= date) {
      best = pts[mid][1];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
};
const daysAgo = (latest: string, days: number) => new Date(dayMs(latest) - days * DAY).toISOString().slice(0, 10);

/** Percentile rank (0–1) of `v` within `xs`. */
export const percentileRank = (xs: number[], v: number): number => {
  if (!xs.length) return 0.5;
  const below = xs.filter((x) => x < v).length;
  const equal = xs.filter((x) => x === v).length;
  return (below + equal / 2) / xs.length;
};
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sma = (pts: Pt[], n: number): (number | null)[] => {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    sum += pts[i][1];
    if (i >= n) sum -= pts[i - n][1];
    out.push(i >= n - 1 ? round(sum / n, 3) : null);
  }
  return out;
};

/** Keep every point in the last two years; one per ISO week before that (keeps the payload small). */
const weekOf = (d: string) => Math.floor((dayMs(d) / DAY + 3) / 7); // Monday-start week number
const thin = <T extends [string, ...unknown[]]>(rows: T[]): T[] => {
  if (!rows.length) return rows;
  const cutoff = daysAgo(rows[rows.length - 1][0], 730);
  // Inside the window: every point. Before it: the last point of each week.
  return rows.filter((r, i) => {
    const next = rows[i + 1];
    return r[0] >= cutoff || !next || next[0] >= cutoff || weekOf(next[0]) !== weekOf(r[0]);
  });
};

const series = (rows: BgRow[], field: string, from = '2000-01-01'): Pt[] =>
  rows
    .map((r) => [r.d.slice(0, 10), num(r[field])] as [string, number | null])
    .filter((p): p is Pt => p[1] != null && p[0] >= from);

export interface MacroLiquidity {
  date: string;
  m2_usd: number;
  yoy_pct: number;
  /** Change in M2 over the last 13 weeks, %. */
  chg_13w_pct: number | null;
  /** 13-week change annualised, % — compare with yoy to see acceleration. */
  annualised_13w_pct: number | null;
  /** Percentile (0–1) of today's y/y growth within the last 10 years. */
  yoy_percentile: number;
  yoy_median_10y: number | null;
}
export interface MacroStablecoins {
  date: string;
  total_usd: number;
  usdt_usd: number;
  usdc_usd: number;
  chg_30d_pct: number | null;
  chg_90d_pct: number | null;
  /** Percentile (0–1) of the 30-day change within the last 3 years. */
  chg_30d_percentile: number | null;
}

export interface MacroMarket {
  as_of: string | null;
  kpis: {
    dxy: { date: string; value: number; chg_1m_pct: number | null; chg_3m_pct: number | null; ma200: number | null; above_200d: boolean | null } | null;
    m2: MacroLiquidity | null;
    stablecoins: MacroStablecoins | null;
    gold: { date: string; price: number; chg_1m_pct: number | null; btc_gold_ratio: number | null } | null;
    btc: { date: string; price: number; chg_1m_pct: number | null } | null;
    correlations: { date: string; sp500_30d: number | null; sp500_90d: number | null; dxy_30d: number | null; dxy_90d: number | null; gold_30d: number | null; gold_90d: number | null } | null;
  };
  series: {
    /** [date, BTC close] — daily for 2 years, weekly before (from 2012). */
    btc: Pt[];
    /** [date, global M2 USD trillions, y/y %] — weekly from 2012. */
    m2: [string, number, number | null][];
    /** [date, DXY, 50-day MA, 200-day MA]. */
    dxy: [string, number, number | null, number | null][];
    /** [date, gold USD/oz, BTC in ounces of gold]. */
    gold: [string, number, number | null][];
    /** [date, USDT $bn, USDC $bn, other $bn]. */
    stablecoins: [string, number, number, number][];
    /** [date, S&P 30d, S&P 90d, DXY 30d, DXY 90d, gold 30d, gold 90d]. */
    correlations: [string, number | null, number | null, number | null, number | null, number | null, number | null][];
  };
  sources: { provider: string; updated: string; series: string[] };
}

const empty = (): MacroMarket => ({
  as_of: null,
  kpis: { dxy: null, m2: null, stablecoins: null, gold: null, btc: null, correlations: null },
  series: { btc: [], m2: [], dxy: [], gold: [], stablecoins: [], correlations: [] },
  sources: { provider: 'BGeometrics (bitcoin-data.com)', updated: new Date().toISOString(), series: [] }
});

/** Global M2 liquidity read (shared with the regime score). */
export const readLiquidity = (m2Rows: BgRow[], yoyRows: BgRow[]): MacroLiquidity | null => {
  const m2 = series(m2Rows, 'm2global');
  const yoy = series(yoyRows, 'm2yoyChange');
  if (m2.length < 14 || !yoy.length) return null;
  const [date, level] = m2[m2.length - 1];
  const yoyNow = yoy[yoy.length - 1][1];
  const back13 = m2[m2.length - 14][1];
  const chg13 = pctChange(level, back13);
  const tenYears = yoy.filter((p) => p[0] >= daysAgo(date, 3650)).map((p) => p[1]);
  return {
    date,
    m2_usd: level,
    yoy_pct: round(yoyNow, 2),
    chg_13w_pct: chg13,
    annualised_13w_pct: chg13 == null ? null : round((Math.pow(1 + chg13 / 100, 4) - 1) * 100, 2),
    yoy_percentile: round(percentileRank(tenYears, yoyNow), 3),
    yoy_median_10y: (() => {
      const m = median(tenYears);
      return m == null ? null : round(m, 2);
    })()
  };
};

const STABLE_FIELDS = ['usdt', 'usdc', 'dai', 'busd', 'gusd', 'pax', 'tusd', 'usde', 'fdusd', 'pyusd'];
const stableTotals = (rows: BgRow[]): [string, number, number, number][] =>
  rows
    .map((r) => {
      const usdt = num(r.usdt) ?? 0;
      const usdc = num(r.usdc) ?? 0;
      const total = STABLE_FIELDS.reduce((s, f) => s + (num(r[f]) ?? 0), 0);
      return [r.d.slice(0, 10), usdt, usdc, total - usdt - usdc] as [string, number, number, number];
    })
    .filter((r) => r[1] + r[2] + r[3] > 0);

/** Stablecoin supply read (shared with the regime score). */
export const readStablecoins = (rows: BgRow[]): MacroStablecoins | null => {
  const s = stableTotals(rows);
  if (s.length < 91) return null;
  const totalPts: Pt[] = s.map((r) => [r[0], r[1] + r[2] + r[3]]);
  const [date, total] = totalPts[totalPts.length - 1];
  const at = (days: number) => valueAt(totalPts, daysAgo(date, days));
  const chg30 = pctChange(total, at(30));
  // Distribution of 30-day changes over the last 3 years, for a relative read.
  const from = daysAgo(date, 3 * 365);
  const hist: number[] = [];
  for (let i = 30; i < totalPts.length; i += 1) {
    if (totalPts[i][0] < from) continue;
    const prev = valueAt(totalPts, daysAgo(totalPts[i][0], 30));
    const c = pctChange(totalPts[i][1], prev);
    if (c != null) hist.push(c);
  }
  const last = s[s.length - 1];
  return {
    date,
    total_usd: total,
    usdt_usd: last[1],
    usdc_usd: last[2],
    chg_30d_pct: chg30,
    chg_90d_pct: pctChange(total, at(90)),
    chg_30d_percentile: chg30 == null || !hist.length ? null : round(percentileRank(hist, chg30), 3)
  };
};

/** The dollar index and gold, daily, as plain point series (shared with the regime score). */
export const readDollarAndGold = (macroRows: BgRow[]): { dxy: Pt[]; gold: Pt[]; btcGold: Pt[] } => ({
  dxy: series(macroRows, 'dxy'),
  gold: series(macroRows, 'goldPrice'),
  btcGold: series(macroRows, 'btcGoldRatio')
});

export const loadMacroInputs = async () => {
  const [m2, m2yoy, macro, stables] = await Promise.all([
    getBgHistory('m2global'),
    getBgHistory('m2yoy-change'),
    getBgHistory('macro'),
    getBgHistory('stablecoin-supply')
  ]);
  return { m2, m2yoy, macro, stables };
};

const CACHE_KEY = 'macro:market:v1';

export const buildMacroMarket = async (): Promise<MacroMarket> => {
  const hit = cacheGet<MacroMarket>(CACHE_KEY);
  if (hit) return hit;

  const [{ m2, m2yoy, macro, stables }, corrSp, corrDxy, corrGold, btcDaily] = await Promise.all([
    loadMacroInputs(),
    getBgHistory('btc-sp500-correlation'),
    getBgHistory('btc-dxy-correlation'),
    getBgHistory('btc-gold-correlation'),
    readSeries('btc-full').catch(() => [])
  ]);

  const out = empty();
  const used: string[] = [];

  // BTC (our own stored daily closes).
  const btc: Pt[] = btcDaily.filter((p) => p.date >= '2012-01-01' && Number.isFinite(p.value)).map((p) => [p.date, p.value]);
  if (btc.length) {
    const [d, v] = btc[btc.length - 1];
    out.kpis.btc = { date: d, price: v, chg_1m_pct: pctChange(v, valueAt(btc, daysAgo(d, 30))) };
    out.series.btc = thin(btc).map(([dd, vv]) => [dd, round(vv, 0)]);
  }

  // Global M2.
  const liq = readLiquidity(m2, m2yoy);
  if (liq) {
    out.kpis.m2 = liq;
    const yoy = series(m2yoy, 'm2yoyChange');
    out.series.m2 = series(m2, 'm2global').map(([d, v]) => [d, round(v / 1e12, 3), valueAt(yoy, d)]);
    used.push('Global M2 (m2global, m2yoy-change)');
  }

  // Dollar index + gold.
  const { dxy, gold, btcGold } = readDollarAndGold(macro);
  if (dxy.length > 200) {
    const [d, v] = dxy[dxy.length - 1];
    const ma50 = sma(dxy, 50);
    const ma200 = sma(dxy, 200);
    const ma200Now = ma200[ma200.length - 1];
    out.kpis.dxy = {
      date: d,
      value: round(v, 3),
      chg_1m_pct: pctChange(v, valueAt(dxy, daysAgo(d, 30))),
      chg_3m_pct: pctChange(v, valueAt(dxy, daysAgo(d, 91))),
      ma200: ma200Now,
      above_200d: ma200Now == null ? null : v > ma200Now
    };
    const rows = dxy.map(([dd, vv], i) => [dd, round(vv, 3), ma50[i], ma200[i]] as [string, number, number | null, number | null]).filter((r) => r[0] >= '2015-01-01');
    out.series.dxy = thin(rows);
    used.push('US Dollar Index (macro)');
  }
  if (gold.length) {
    const [d, v] = gold[gold.length - 1];
    out.kpis.gold = { date: d, price: round(v, 2), chg_1m_pct: pctChange(v, valueAt(gold, daysAgo(d, 30))), btc_gold_ratio: valueAt(btcGold, d) };
    out.series.gold = thin(gold.filter((p) => p[0] >= '2015-01-01').map(([dd, vv]) => [dd, round(vv, 2), valueAt(btcGold, dd)] as [string, number, number | null]));
    used.push('Gold (macro)');
  }

  // Stablecoins.
  const st = readStablecoins(stables);
  if (st) {
    out.kpis.stablecoins = st;
    out.series.stablecoins = thin(stableTotals(stables).map(([d, a, b, c]) => [d, round(a / 1e9, 2), round(b / 1e9, 2), round(c / 1e9, 2)] as [string, number, number, number]));
    used.push('Stablecoin supply');
  }

  // Correlations (30/90-day rolling, BTC vs S&P 500 / DXY / gold).
  const c30 = (rows: BgRow[]) => series(rows, 'corr30d');
  const c90 = (rows: BgRow[]) => series(rows, 'corr90d');
  const sp30 = c30(corrSp);
  const sp90 = c90(corrSp);
  const dx30 = c30(corrDxy);
  const dx90 = c90(corrDxy);
  const gd30 = c30(corrGold);
  const gd90 = c90(corrGold);
  if (sp90.length || dx90.length || gd90.length) {
    const dates = [...new Set([...sp90, ...dx90, ...gd90].map((p) => p[0]))].sort();
    const last = dates[dates.length - 1];
    out.kpis.correlations = {
      date: last,
      sp500_30d: valueAt(sp30, last),
      sp500_90d: valueAt(sp90, last),
      dxy_30d: valueAt(dx30, last),
      dxy_90d: valueAt(dx90, last),
      gold_30d: valueAt(gd30, last),
      gold_90d: valueAt(gd90, last)
    };
    out.series.correlations = thin(
      dates
        .filter((d) => d >= '2016-01-01')
        .map((d) => [d, valueAt(sp30, d), valueAt(sp90, d), valueAt(dx30, d), valueAt(dx90, d), valueAt(gd30, d), valueAt(gd90, d)] as MacroMarket['series']['correlations'][number])
    );
    used.push('BTC correlations (S&P 500, DXY, gold)');
  }

  const dates = [out.kpis.dxy?.date, out.kpis.m2?.date, out.kpis.stablecoins?.date, out.kpis.correlations?.date].filter(Boolean) as string[];
  out.as_of = dates.length ? dates.sort()[dates.length - 1] : null;
  out.sources.series = used;
  // Only keep a payload that actually has data, so a failed fetch retries soon.
  if (used.length) cacheSet(CACHE_KEY, out, 3600);
  return out;
};
