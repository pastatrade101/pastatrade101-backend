import { supabase } from '../../config/supabase';
import { cacheGet, cacheSet } from '../../utils/cache';
import { getBgHistory, getBgRecent, num, type BgRow } from '../sources/bgeometrics.client';

// ─────────────────────────────────────────────────────────────────────────────
// Derivatives / Leverage Risk — BGeometrics (bitcoin-data.com, Advanced plan).
//
// The score blends three readings of how much leverage is in BTC futures:
//   • funding rate (24h average, per 8h)        35% — what longs pay to stay long
//   • open interest in BTC vs the past year      35% — how much leverage is open
//   • top-trader long/short accounts vs the year 30% — how one-sided traders are
// High = crowded longs / over-leveraged (fragile); low or negative funding =
// fearful / deleveraged. Taker flow, liquidations and the Coinbase premium are
// shown for context but are not scored.
//
// Calls: six histories once a day (cached in the client until the provider's
// 03:00 UTC update) plus three short intraday windows at most once an hour.
// Probability-style, never an instruction. Every input is optional: if the
// provider is unreachable the read is "unavailable" and nothing downstream breaks.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number, d = 4) => Number(n.toFixed(d));
const dayOf = (d: string) => d.slice(0, 10);
const dayMs = (d: string) => Date.parse(`${dayOf(d)}T00:00:00Z`);
const shiftDay = (d: string, days: number) => new Date(dayMs(d) + days * DAY).toISOString().slice(0, 10);
const pctChange = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b === 0 ? null : round((a / b - 1) * 100, 2));
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Percentile rank (0–1) of `v` within `xs`. */
const pctRank = (xs: number[], v: number): number => {
  if (!xs.length) return 0.5;
  let below = 0;
  let equal = 0;
  for (const x of xs) {
    if (x < v) below += 1;
    else if (x === v) equal += 1;
  }
  return (below + equal / 2) / xs.length;
};

/** Index of the last row on or before `date` in an ascending [date, …] list. */
const idxAt = <T extends [string, ...unknown[]]>(rows: T[], date: string): number => {
  let lo = 0;
  let hi = rows.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= date) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
};

/** Values of `rows` in the `days` before (and including) row `i`. */
const trailing = (rows: [string, number][], i: number, days = 365): number[] => {
  const from = shiftDay(rows[i][0], -days);
  const out: number[] = [];
  for (let j = i; j >= 0 && rows[j][0] > from; j -= 1) out.push(rows[j][1]);
  return out;
};
const MIN_HISTORY = 60; // days of history before a percentile means anything

// Funding (per 8h) → risk. Small positive ≈ neutral; high positive = crowded longs.
const fundingRisk = (f: number | null): number | null => (f == null ? null : round(clamp01((f + 0.0002) / 0.0012), 3));

export const WEIGHTS = { funding: 0.35, open_interest: 0.35, positioning: 0.3 } as const;
const blend = (f: number | null, o: number | null, l: number | null): number | null => {
  const parts = [
    { w: WEIGHTS.funding, v: f },
    { w: WEIGHTS.open_interest, v: o },
    { w: WEIGHTS.positioning, v: l }
  ].filter((p) => p.v != null) as { w: number; v: number }[];
  if (!parts.length) return null;
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  return round(clamp01(parts.reduce((s, p) => s + p.w * p.v, 0) / wsum), 3);
};

const EXCHANGES: Record<string, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  gateIo: 'Gate',
  bitget: 'Bitget',
  deribit: 'Deribit',
  huobi: 'HTX',
  cryptoCom: 'Crypto.com',
  kucoin: 'KuCoin',
  bitfinex: 'Bitfinex',
  bitmex: 'BitMEX',
  kraken: 'Kraken',
  dydx: 'dYdX',
  deltaExchange: 'Delta Exchange'
};

// ── Inputs ──

type Pt = [string, number];
interface Prepared {
  price: Pt[]; // daily mean mark price (from the funding rows)
  funding: Pt[]; // daily mean funding per 8h (fraction)
  oi: { d: string; usd: number; btc: number | null; ex: Record<string, number> }[];
  oiBtc: Pt[];
  ls: Pt[]; // daily mean top-trader long/short (accounts)
  taker: [string, number, number][]; // date, buy vol, sell vol
  liq: [string, number, number, number][]; // date, total, long, short (USD)
  premium: Pt[]; // Coinbase premium index, %
}

/** Daily means of an intraday field. */
const dailyMean = (rows: BgRow[], field: string): Pt[] => {
  const acc = new Map<string, { s: number; n: number }>();
  for (const r of rows) {
    const v = num(r[field]);
    if (v == null) continue;
    const d = dayOf(r.d);
    const a = acc.get(d) ?? { s: 0, n: 0 };
    a.s += v;
    a.n += 1;
    acc.set(d, a);
  }
  return [...acc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, a]) => [d, a.s / a.n]);
};

const PREP_KEY = 'derivatives:prepared:v2';
// The page asks for the live read and the history at the same moment; share one
// load so a cold cache costs one round of calls, not two.
let preparing: Promise<Prepared | null> | null = null;
const loadPrepared = (): Promise<Prepared | null> => {
  const hit = cacheGet<Prepared>(PREP_KEY);
  if (hit) return Promise.resolve(hit);
  if (!preparing) preparing = buildPrepared().finally(() => (preparing = null));
  return preparing;
};
const buildPrepared = async (): Promise<Prepared | null> => {
  const [fundingRows, oiRows, lsRows, takerRows, liqRows, premRows] = await Promise.all([
    getBgHistory('funding-rate'),
    getBgHistory('open-interest-futures'),
    getBgHistory('top-trader-account-1h', 760),
    getBgHistory('taker-buy-ratio-1h', 400),
    getBgHistory('btc-liquidations-1d'),
    getBgHistory('coinbase-premium-index')
  ]);
  if (!fundingRows.length && !oiRows.length && !lsRows.length) return null;

  const price = dailyMean(fundingRows, 'markPrice');
  const funding = dailyMean(fundingRows, 'fundingRate');

  // The feed sometimes drops exchanges for a day (e.g. 2026-09-18: nine of
  // them), which reads as a fake 60% crash in open interest. Carry each
  // exchange's last value forward for up to a week and sum the exchanges
  // ourselves instead of using the feed's total.
  const oi: Prepared['oi'] = [];
  const lastSeen: Record<string, { v: number; d: string }> = {};
  for (const r of [...oiRows].sort((a, b) => (a.d < b.d ? -1 : 1))) {
    const d = dayOf(r.d);
    const ex: Record<string, number> = {};
    for (const k of Object.keys(EXCHANGES)) {
      const v = num(r[k]);
      if (v != null && v > 0) {
        ex[k] = v;
        lastSeen[k] = { v, d };
      } else if (lastSeen[k] && dayMs(d) - dayMs(lastSeen[k].d) <= 7 * DAY) ex[k] = lastSeen[k].v;
    }
    const usd = Object.values(ex).reduce((s, v) => s + v, 0) || num(r.openInterestFutures);
    if (!usd) continue;
    const pi = idxAt(price, d);
    const px = pi >= 0 ? price[pi][1] : null;
    oi.push({ d, usd, btc: px ? usd / px : null, ex });
  }
  const oiBtc: Pt[] = oi.filter((o) => o.btc != null).map((o) => [o.d, o.btc as number]);

  const ls = dailyMean(lsRows, 'topTraderLongShortRatioAccount');

  const takerAcc = new Map<string, { b: number; s: number }>();
  for (const r of takerRows) {
    const b = num(r.takerBuyVol);
    const s = num(r.takerSellVol);
    if (b == null || s == null) continue;
    const d = dayOf(r.d);
    const a = takerAcc.get(d) ?? { b: 0, s: 0 };
    a.b += b;
    a.s += s;
    takerAcc.set(d, a);
  }
  const taker = [...takerAcc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, a]) => [d, a.b, a.s] as [string, number, number]);

  const liq = liqRows
    .map((r) => [dayOf(r.d), num(r.totalLiquidationsUsd), num(r.longLiquidationsUsd), num(r.shortLiquidationsUsd)] as const)
    .filter((x) => x[1] != null)
    .map((x) => [x[0], x[1] as number, x[2] ?? 0, x[3] ?? 0] as [string, number, number, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const premium = premRows
    .map((r) => [dayOf(r.d), num(r.coinbasePremiumIndex)] as const)
    .filter((x) => x[1] != null)
    .map((x) => [x[0], x[1] as number] as Pt)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const out: Prepared = { price, funding, oi, oiBtc, ls, taker, liq, premium };
  cacheSet(PREP_KEY, out, 3600);
  return out;
};

// ── Live read ──

type Tone = 'good' | 'warn' | 'neutral';
const riskTone = (r: number | null): Tone => (r == null ? 'neutral' : r >= 0.7 ? 'warn' : r <= 0.3 ? 'good' : 'neutral');

export interface DerivativesInput {
  key: 'funding' | 'open_interest' | 'positioning';
  input: string;
  reading: string;
  weight: number;
  risk: number | null;
  tone: Tone;
  as_of: string | null;
}

export interface DerivativesResult {
  as_of: string;
  source: 'bgeometrics';
  leverage_risk: number | null;
  leverage_percent: number | null;
  label: string;
  confidence: 'High' | 'Medium' | 'Low';
  interpretation: string;
  /** Latest 8-hour funding rate (fraction, e.g. 0.0001 = 0.01%). */
  btc_funding_rate: number | null;
  /** Open interest across exchanges, in BTC. */
  btc_open_interest: number | null;
  /** Top-trader long/short account ratio, 24h average. */
  btc_long_short: number | null;
  components: {
    funding_risk: number | null;
    oi_risk: number | null;
    long_short_risk: number | null;
    funding_24h: number | null;
    oi_change_7d_pct: number | null;
    oi_change_30d_pct: number | null;
    source: 'bgeometrics';
  };
  inputs: DerivativesInput[];
  funding: { as_of: string; latest: number; avg_24h: number | null; annualised_pct: number | null; avg_30d: number | null } | null;
  open_interest: {
    as_of: string;
    usd: number;
    btc: number | null;
    chg_7d_pct: number | null;
    chg_30d_pct: number | null;
    usd_chg_7d_pct: number | null;
    percentile_1y: number | null;
    high_1y_btc: number | null;
  } | null;
  positioning: { as_of: string; ratio: number; ratio_24h: number | null; long_pct: number | null; percentile_1y: number | null; median_1y: number | null } | null;
  taker: { as_of: string; ratio_24h: number; buy_share_24h_pct: number; ratio_7d: number | null } | null;
  liquidations: { as_of: string; total_usd: number; long_usd: number; short_usd: number; avg_30d_usd: number | null } | null;
  coinbase_premium: { as_of: string; value: number; avg_30d: number | null } | null;
  oi_by_exchange: { key: string; name: string; usd: number; share_pct: number }[];
}

const unavailable = (): DerivativesResult => ({
  as_of: new Date().toISOString(),
  source: 'bgeometrics',
  leverage_risk: null,
  leverage_percent: null,
  label: 'Unavailable',
  confidence: 'Low',
  interpretation: 'Derivatives data is unavailable right now. This read is skipped until it returns.',
  btc_funding_rate: null,
  btc_open_interest: null,
  btc_long_short: null,
  components: { funding_risk: null, oi_risk: null, long_short_risk: null, funding_24h: null, oi_change_7d_pct: null, oi_change_30d_pct: null, source: 'bgeometrics' },
  inputs: [],
  funding: null,
  open_interest: null,
  positioning: null,
  taker: null,
  liquidations: null,
  coinbase_premium: null,
  oi_by_exchange: []
});

const fmtFunding = (f: number) => `${f >= 0 ? '+' : ''}${(f * 100).toFixed(4)}%`;
const ordinal = (p: number) => {
  const n = Math.round(p * 100);
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
};

const LIVE_KEY = 'derivatives:live:v2';

export const computeDerivatives = async (): Promise<DerivativesResult> => {
  const hit = cacheGet<DerivativesResult>(LIVE_KEY);
  if (hit) return hit;

  const [prep, recentFunding, recentLs, recentTaker] = await Promise.all([
    loadPrepared(),
    getBgRecent('funding-rate', 3),
    getBgRecent('top-trader-account-1h', 2),
    getBgRecent('taker-buy-ratio-1h', 2)
  ]);
  if (!prep) return unavailable();
  const out = unavailable();
  const now = Date.now();
  const fresh = (d: string | null | undefined, days: number) => d != null && now - dayMs(d) <= days * DAY;

  // Funding: latest 8h print, 24h average (last three prints).
  const fRows = (recentFunding.length ? recentFunding : []).filter((r) => num(r.fundingRate) != null).sort((a, b) => (a.d < b.d ? -1 : 1));
  if (fRows.length || prep.funding.length) {
    const lastRow = fRows[fRows.length - 1];
    const latest = lastRow ? (num(lastRow.fundingRate) as number) : prep.funding[prep.funding.length - 1][1];
    const asOf = lastRow ? String(lastRow.d) : prep.funding[prep.funding.length - 1][0];
    const avg24 = fRows.length ? mean(fRows.slice(-3).map((r) => num(r.fundingRate) as number)) : latest;
    const f30 = prep.funding.filter(([d]) => d > shiftDay(dayOf(asOf), -30)).map(([, v]) => v);
    out.funding = {
      as_of: asOf,
      latest: round(latest, 8),
      avg_24h: avg24 == null ? null : round(avg24, 8),
      annualised_pct: avg24 == null ? null : round(avg24 * 3 * 365 * 100, 2),
      avg_30d: f30.length ? round(mean(f30) as number, 8) : null
    };
  }

  // Open interest (daily, across exchanges), in BTC and USD.
  if (prep.oi.length) {
    const last = prep.oi[prep.oi.length - 1];
    const btcAt = (days: number) => {
      const i = idxAt(prep.oiBtc, shiftDay(last.d, -days));
      return i >= 0 ? prep.oiBtc[i][1] : null;
    };
    const usdAt = (days: number) => {
      const i = idxAt(prep.oi.map((o) => [o.d] as [string]), shiftDay(last.d, -days));
      return i >= 0 ? prep.oi[i].usd : null;
    };
    const iBtc = prep.oiBtc.length ? prep.oiBtc.length - 1 : -1;
    const year = iBtc >= 0 ? trailing(prep.oiBtc, iBtc) : [];
    out.open_interest = {
      as_of: last.d,
      usd: Math.round(last.usd),
      btc: last.btc == null ? null : Math.round(last.btc),
      chg_7d_pct: pctChange(last.btc, btcAt(7)),
      chg_30d_pct: pctChange(last.btc, btcAt(30)),
      usd_chg_7d_pct: pctChange(last.usd, usdAt(7)),
      percentile_1y: last.btc != null && year.length >= MIN_HISTORY ? round(pctRank(year, last.btc), 3) : null,
      high_1y_btc: year.length ? Math.round(Math.max(...year)) : null
    };
    const total = Object.values(last.ex).reduce((s, v) => s + v, 0) || last.usd;
    out.oi_by_exchange = Object.entries(last.ex)
      .sort((a, b) => b[1] - a[1])
      .map(([key, usd]) => ({ key, name: EXCHANGES[key] ?? key, usd: Math.round(usd), share_pct: round((usd / total) * 100, 1) }));
  }

  // Top-trader positioning (hourly): latest hour, 24h average, rank vs the year.
  const lsRows = recentLs.filter((r) => num(r.topTraderLongShortRatioAccount) != null).sort((a, b) => (a.d < b.d ? -1 : 1));
  if (lsRows.length || prep.ls.length) {
    const lastRow = lsRows[lsRows.length - 1];
    const ratio = lastRow ? (num(lastRow.topTraderLongShortRatioAccount) as number) : prep.ls[prep.ls.length - 1][1];
    const asOf = lastRow ? String(lastRow.d) : prep.ls[prep.ls.length - 1][0];
    const avg24 = lsRows.length ? mean(lsRows.slice(-24).map((r) => num(r.topTraderLongShortRatioAccount) as number)) : ratio;
    const year = prep.ls.filter(([d]) => d > shiftDay(dayOf(asOf), -365)).map(([, v]) => v);
    const sorted = [...year].sort((a, b) => a - b);
    out.positioning = {
      as_of: asOf,
      ratio: round(ratio, 3),
      ratio_24h: avg24 == null ? null : round(avg24, 3),
      long_pct: lastRow && num(lastRow.topTraderLongAccount) != null ? round((num(lastRow.topTraderLongAccount) as number) * 100, 1) : null,
      percentile_1y: avg24 != null && year.length >= MIN_HISTORY ? round(pctRank(year, avg24), 3) : null,
      median_1y: sorted.length ? round(sorted[sorted.length >> 1], 3) : null
    };
  }

  // Taker flow (context): buy vs sell volume over the last 24 hours and 7 days.
  const tRows = recentTaker.filter((r) => num(r.takerBuyVol) != null && num(r.takerSellVol) != null).sort((a, b) => (a.d < b.d ? -1 : 1));
  if (tRows.length) {
    const day = tRows.slice(-24);
    const b = day.reduce((s, r) => s + (num(r.takerBuyVol) as number), 0);
    const s = day.reduce((t, r) => t + (num(r.takerSellVol) as number), 0);
    const week = prep.taker.slice(-7);
    const wb = week.reduce((t, x) => t + x[1], 0);
    const ws = week.reduce((t, x) => t + x[2], 0);
    if (s > 0)
      out.taker = {
        as_of: String(tRows[tRows.length - 1].d),
        ratio_24h: round(b / s, 3),
        buy_share_24h_pct: round((b / (b + s)) * 100, 1),
        ratio_7d: ws > 0 ? round(wb / ws, 3) : null
      };
  }

  // Liquidations (context): the latest full day and the 30-day average.
  if (prep.liq.length) {
    const [d, total, long, short] = prep.liq[prep.liq.length - 1];
    const prior = prep.liq.slice(-31, -1).map((x) => x[1]);
    out.liquidations = { as_of: d, total_usd: Math.round(total), long_usd: Math.round(long), short_usd: Math.round(short), avg_30d_usd: prior.length ? Math.round(mean(prior) as number) : null };
  }

  // Coinbase premium (context): US spot demand vs offshore.
  if (prep.premium.length) {
    const [d, v] = prep.premium[prep.premium.length - 1];
    const prior = prep.premium.slice(-30).map((x) => x[1]);
    out.coinbase_premium = { as_of: d, value: round(v, 4), avg_30d: prior.length ? round(mean(prior) as number, 4) : null };
  }

  // ── Score ──
  const fR = fundingRisk(out.funding?.avg_24h ?? out.funding?.latest ?? null);
  const oR = out.open_interest?.percentile_1y ?? null;
  const lR = out.positioning?.percentile_1y ?? null;
  const leverage = blend(fR, oR, lR);

  out.btc_funding_rate = out.funding?.latest ?? null;
  out.btc_open_interest = out.open_interest?.btc ?? null;
  out.btc_long_short = out.positioning?.ratio_24h ?? out.positioning?.ratio ?? null;
  out.components = {
    funding_risk: fR,
    oi_risk: oR,
    long_short_risk: lR,
    funding_24h: out.funding?.avg_24h ?? null,
    oi_change_7d_pct: out.open_interest?.chg_7d_pct ?? null,
    oi_change_30d_pct: out.open_interest?.chg_30d_pct ?? null,
    source: 'bgeometrics'
  };

  if (out.funding)
    out.inputs.push({
      key: 'funding',
      input: 'Funding rate',
      reading: `${fmtFunding(out.funding.avg_24h ?? out.funding.latest)} per 8h (24h avg)${out.funding.annualised_pct != null ? ` · ${out.funding.annualised_pct.toFixed(1)}% a year` : ''}`,
      weight: WEIGHTS.funding,
      risk: fR,
      tone: (out.funding.avg_24h ?? out.funding.latest) < 0 ? 'good' : riskTone(fR),
      as_of: out.funding.as_of
    });
  if (out.open_interest)
    out.inputs.push({
      key: 'open_interest',
      input: 'Open interest',
      reading:
        `${out.open_interest.btc != null ? `${Math.round(out.open_interest.btc / 1000)}K BTC` : `$${(out.open_interest.usd / 1e9).toFixed(1)}B`}` +
        `${oR != null ? ` · ${ordinal(oR)} percentile of the year` : ''}` +
        `${out.open_interest.chg_7d_pct != null ? ` · ${out.open_interest.chg_7d_pct >= 0 ? '+' : ''}${out.open_interest.chg_7d_pct.toFixed(1)}% 7D` : ''}`,
      weight: WEIGHTS.open_interest,
      risk: oR,
      tone: riskTone(oR),
      as_of: out.open_interest.as_of
    });
  if (out.positioning)
    out.inputs.push({
      key: 'positioning',
      input: 'Top-trader long/short',
      reading: `${(out.positioning.ratio_24h ?? out.positioning.ratio).toFixed(2)} (24h avg)${lR != null ? ` · ${ordinal(lR)} percentile of the year` : ''}`,
      weight: WEIGHTS.positioning,
      risk: lR,
      tone: riskTone(lR),
      as_of: out.positioning.as_of
    });

  const f24 = out.funding?.avg_24h ?? out.funding?.latest ?? null;
  let label: string;
  if (leverage == null) label = 'Unavailable';
  else if (f24 != null && f24 < 0 && leverage < 0.35) label = 'Fear / short-heavy';
  else if (leverage < 0.35) label = 'Low leverage';
  else if (leverage < 0.55) label = 'Normal';
  else if (leverage < 0.75) label = 'Elevated leverage';
  else label = 'Overheated / crowded longs';

  // Confidence: how many of the three scored inputs are present and recent.
  const present = [
    fR != null && fresh(out.funding?.as_of, 2),
    oR != null && fresh(out.open_interest?.as_of, 4),
    lR != null && fresh(out.positioning?.as_of, 2)
  ].filter(Boolean).length;
  const confidence: DerivativesResult['confidence'] = present >= 3 ? 'High' : present === 2 ? 'Medium' : 'Low';

  // The hottest scored input, named in the read.
  const hot = out.inputs.filter((i) => i.risk != null).sort((a, b) => (b.risk as number) * b.weight - (a.risk as number) * a.weight)[0];
  const driver =
    hot?.key === 'open_interest'
      ? 'open interest is high for the year'
      : hot?.key === 'positioning'
        ? 'top traders lean heavily long'
        : hot?.key === 'funding'
          ? 'funding is running hot'
          : '';
  const interpretation =
    leverage == null
      ? 'Derivatives data is unavailable right now. This read is skipped until it returns.'
      : leverage >= 0.75
        ? 'Funding, open interest and positioning are all stretched — historically a fragile backdrop. Long squeezes become more likely if price stalls.'
        : leverage >= 0.55
          ? `${driver ? `${driver.charAt(0).toUpperCase()}${driver.slice(1)}. ` : ''}Not overheated yet — watch for over-extension if price keeps climbing.`
          : f24 != null && f24 < 0
            ? 'Funding is negative — shorts are paying to hold their bets. Fearful positioning has often been a lower-risk backdrop for patient buyers.'
            : `Leverage looks ${leverage < 0.35 ? 'light' : 'normal'} — funding, open interest and positioning are not stretched together${driver && (hot?.risk ?? 0) >= 0.7 ? `, although ${driver}` : ''}.`;

  out.leverage_risk = leverage;
  out.leverage_percent = leverage == null ? null : Math.round(leverage * 100);
  out.label = label;
  out.confidence = leverage == null ? 'Low' : confidence;
  out.interpretation = interpretation;
  out.as_of = new Date().toISOString();

  if (leverage != null) cacheSet(LIVE_KEY, out, 600);
  return out;
};

// ── History for the charts ──

export interface DerivativesHistory {
  /** [date, leverage %, funding risk, OI risk, positioning risk] — where all three inputs exist. */
  score: [string, number, number, number, number][];
  /** [date, BTC price (daily mean mark price)] */
  price: Pt[];
  /** [date, funding % per 8h (daily mean)] */
  funding: Pt[];
  /** [date, open interest $bn, open interest thousand BTC] */
  open_interest: [string, number, number | null][];
  /** [date, top-trader long/short (daily mean)] */
  long_short: Pt[];
  /** [date, taker buy/sell ratio (daily)] */
  taker: Pt[];
  /** [date, long liquidations $m, short liquidations $m] */
  liquidations: [string, number, number][];
  /** [date, Coinbase premium index %] */
  premium: Pt[];
}

const HIST_KEY = 'derivatives:history:v1';

export const getDerivativesHistory = async (days?: number): Promise<DerivativesHistory> => {
  let h = cacheGet<DerivativesHistory>(HIST_KEY);
  if (!h) {
    const prep = await loadPrepared();
    h = { score: [], price: [], funding: [], open_interest: [], long_short: [], taker: [], liquidations: [], premium: [] };
    if (prep) {
      const fundingMap = new Map(prep.funding);
      for (let i = 0; i < prep.ls.length; i += 1) {
        const d = prep.ls[i][0];
        const lsYear = trailing(prep.ls, i);
        if (lsYear.length < MIN_HISTORY) continue;
        const oi = idxAt(prep.oiBtc, d);
        if (oi < 0) continue;
        const oiYear = trailing(prep.oiBtc, oi);
        if (oiYear.length < MIN_HISTORY) continue;
        const fi = fundingMap.get(d) ?? (() => {
          const j = idxAt(prep.funding, d);
          return j >= 0 ? prep.funding[j][1] : null;
        })();
        const fR = fundingRisk(fi);
        if (fR == null) continue;
        const oR = round(pctRank(oiYear, prep.oiBtc[oi][1]), 3);
        const lR = round(pctRank(lsYear, prep.ls[i][1]), 3);
        const s = blend(fR, oR, lR) as number;
        h.score.push([d, Math.round(s * 100), fR, oR, lR]);
      }
      h.price = prep.price.map(([d, v]) => [d, Math.round(v)]);
      h.funding = prep.funding.map(([d, v]) => [d, round(v * 100, 5)]);
      h.open_interest = prep.oi.map((o) => [o.d, round(o.usd / 1e9, 2), o.btc == null ? null : round(o.btc / 1000, 1)]);
      h.long_short = prep.ls.map(([d, v]) => [d, round(v, 3)]);
      h.taker = prep.taker.filter((x) => x[2] > 0).map(([d, b, s]) => [d, round(b / s, 3)]);
      h.liquidations = prep.liq.map(([d, , l, s]) => [d, round(l / 1e6, 2), round(s / 1e6, 2)]);
      h.premium = prep.premium.map(([d, v]) => [d, round(v, 4)]);
      if (h.price.length) cacheSet(HIST_KEY, h, 3600);
    }
  }
  if (!days) return h;
  const from = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const cut = <T extends [string, ...unknown[]]>(rows: T[]) => rows.filter((x) => x[0] >= from);
  return {
    score: cut(h.score),
    price: cut(h.price),
    funding: cut(h.funding),
    open_interest: cut(h.open_interest),
    long_short: cut(h.long_short),
    taker: cut(h.taker),
    liquidations: cut(h.liquidations),
    premium: cut(h.premium)
  };
};

// ── Stored daily read (Overview, Social Risk, Exit Strategy, reports) ──

/** Persist today's derivatives read. */
export const storeDerivativesDaily = async (): Promise<number> => {
  const r = await computeDerivatives();
  if (r.leverage_risk == null) return 0; // nothing to store when the provider is down
  const date = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('derivatives_daily').upsert(
    {
      date,
      // 24h average funding — steadier than a single 8h print for the stored flags.
      btc_funding_rate: r.components.funding_24h ?? r.btc_funding_rate,
      eth_funding_rate: null,
      btc_open_interest: r.btc_open_interest,
      eth_open_interest: null,
      btc_long_short: r.btc_long_short,
      eth_long_short: null,
      hot_funding_breadth: null,
      leverage_risk: r.leverage_risk,
      leverage_percent: r.leverage_percent,
      label: r.label,
      confidence: r.confidence,
      components: r.components,
      interpretation: r.interpretation,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'date' }
  );
  if (error) throw new Error(`Failed to store derivatives: ${error.message}`);
  return 1;
};

/** Latest stored read — used by the overview + social risk. Best-effort. */
export const getLatestDerivatives = async (): Promise<{ leverage_risk: number | null; label: string } | null> => {
  try {
    const { data } = await supabase.from('derivatives_daily').select('leverage_risk, label').order('date', { ascending: false }).limit(1).maybeSingle();
    if (!data || data.leverage_risk == null) return null;
    return { leverage_risk: Number(data.leverage_risk), label: (data.label as string) ?? 'Normal' };
  } catch {
    return null;
  }
};

type StoredComponents = { source?: string; oi_change_7d_pct?: number | null; long_short_risk?: number | null } | null;

/**
 * Confluence flags from a stored row. Rows written from BGeometrics carry the
 * 7-day open-interest change and the positioning percentile in `components`;
 * older rows (another provider) fall back to comparing with the row before.
 */
export const derivativeFlags = (
  cur: { btc_funding_rate?: unknown; btc_open_interest?: unknown; btc_long_short?: unknown; components?: unknown },
  prev?: { btc_open_interest?: unknown } | null
) => {
  const comp = (cur.components ?? null) as StoredComponents;
  const bg = comp?.source === 'bgeometrics';
  const f = cur.btc_funding_rate == null ? null : Number(cur.btc_funding_rate);
  const ls = cur.btc_long_short == null ? null : Number(cur.btc_long_short);
  return {
    funding_high: f != null && f > 0.0003,
    funding_negative: f != null && f < 0,
    oi_rising: bg
      ? comp?.oi_change_7d_pct != null && comp.oi_change_7d_pct > 5
      : cur.btc_open_interest != null && prev?.btc_open_interest != null && Number(cur.btc_open_interest) > Number(prev.btc_open_interest) * 1.03,
    ls_extreme: bg ? comp?.long_short_risk != null && (comp.long_short_risk >= 0.9 || comp.long_short_risk <= 0.1) : ls != null && (ls > 1.8 || ls < 0.6)
  };
};

/** Richer read for Exit Strategy — adds funding/OI/positioning confluence flags. */
export const getDerivativesForExit = async (): Promise<{
  leverage_risk: number;
  label: string;
  funding_high: boolean;
  oi_rising: boolean;
  ls_extreme: boolean;
} | null> => {
  try {
    const { data } = await supabase
      .from('derivatives_daily')
      .select('leverage_risk, btc_funding_rate, btc_open_interest, btc_long_short, label, components')
      .order('date', { ascending: false })
      .limit(2);
    if (!data || !data.length || data[0].leverage_risk == null) return null;
    const flags = derivativeFlags(data[0], data[1]);
    return {
      leverage_risk: Number(data[0].leverage_risk),
      label: (data[0].label as string) ?? 'Normal',
      funding_high: flags.funding_high,
      oi_rising: flags.oi_rising,
      ls_extreme: flags.ls_extreme
    };
  } catch {
    return null;
  }
};
