import { supabase } from '../../config/supabase';
import { readSeries } from '../series/store';
import type { DailyPoint } from '../sources/blockchaincom.client';

// ─────────────────────────────────────────────────────────────────────────────
// Altcoin Season Index (robust). Measures the share of liquid, non-stable
// altcoins outperforming BTC over a timeframe — but separates RELATIVE strength
// (beat BTC) from ABSOLUTE strength (actually up), so a "season" call isn't made
// just because alts are falling less than BTC. Computed from the stored daily
// price series (daily_prices `cg:<id>`), not the partial precomputed columns.
// ─────────────────────────────────────────────────────────────────────────────

export type Timeframe = '7d' | '30d' | '60d' | '90d' | '180d' | '1y';
export type Universe = 'premium_clean' | 'all';

const TF_DAYS: Record<Timeframe, number> = { '7d': 7, '30d': 30, '60d': 60, '90d': 90, '180d': 180, '1y': 365 };
const TF_LABEL: Record<Timeframe, string> = { '7d': '7 days', '30d': '30 days', '60d': '60 days', '90d': '90 days', '180d': '180 days', '1y': '1 year' };

const DAY = 86_400_000;
const ts = (d: string) => Date.parse(`${d}T00:00:00Z`);

// Stablecoins / fiat-pegged — never part of an "altcoin season" read.
const STABLES = new Set([
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'USDS', 'GUSD', 'USDP', 'FRAX', 'LUSD', 'USD0', 'USDG', 'EURT', 'EURC', 'XAUT', 'PAXG'
]);
// Wrapped / staked / pegged / bridged / credit derivatives — track the
// underlying or aren't crypto-beta, so excluded from the clean universe.
const WRAPPED_SYMBOLS = new Set(['WBTC', 'WETH', 'WBNB', 'WEETH', 'WSTETH', 'STETH', 'RETH', 'CBBTC', 'CBETH', 'WBETH', 'LBTC', 'SOLVBTC', 'BSC-USD', 'JITOSOL', 'MSOL']);
const WRAPPED_NAME = /wrapped|staked|bridged|pegged|liquid staked|restaked|heloc|t-?bill|treasury|money market/i;

const MIN_VOLUME = 10_000_000; // $10M 24h
const MIN_HISTORY = 180; // days for the clean universe

interface Coin {
  coingecko_id: string;
  symbol: string;
  name: string;
  image_url: string | null;
  market_cap_rank: number | null;
  total_volume: number | null;
}

export type Badge = 'Clean' | 'Short history' | 'Low liquidity' | 'Abnormal spike';
export interface CoinRow {
  symbol: string;
  name: string;
  image: string | null;
  rank: number | null;
  coin_return: number;
  btc_return: number;
  relative: number;
  signal: 'True outperformer' | 'Relative outperformer, but still negative' | 'Weak vs BTC';
  badge: Badge;
}

interface UniverseItem {
  coin: Coin;
  pts: DailyPoint[];
  badge: Badge;
}

const sma = (pts: DailyPoint[], n: number): number | null => {
  if (pts.length < n) return null;
  return pts.slice(-n).reduce((s, p) => s + p.value, 0) / n;
};

// Return over `days` using a date-anchored lookback (robust to gaps). null when
// the series doesn't reach back far enough.
const retOver = (pts: DailyPoint[], days: number): number | null => {
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  return retEndingAt(pts, ts(last.date), days);
};

// Return over `days` ending at a specific timestamp (date-anchored on both ends).
const retEndingAt = (pts: DailyPoint[], endTs: number, days: number): number | null => {
  const end = priceAt(pts, endTs);
  const prev = priceAt(pts, endTs - days * DAY);
  if (end == null || prev == null || prev <= 0) return null;
  return (end / prev - 1) * 100;
};

// Latest value at or before targetTs (binary search; pts sorted ascending).
const priceAt = (pts: DailyPoint[], targetTs: number): number | null => {
  let lo = 0;
  let hi = pts.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts(pts[mid].date) <= targetTs) {
      res = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res >= 0 ? pts[res].value : null;
};

const isStable = (c: Coin) => STABLES.has(c.symbol.toUpperCase());
const isWrapped = (c: Coin) => WRAPPED_SYMBOLS.has(c.symbol.toUpperCase()) || WRAPPED_NAME.test(c.name);

// Load the tracked universe with each coin's full daily series + a quality badge.
// Static filters only (timeframe-independent), so both the snapshot and history
// reuse it. Returns the kept items + how many candidates were excluded.
const loadUniverse = async (universe: Universe, limit: number): Promise<{ items: UniverseItem[]; excluded: number }> => {
  const clean = universe === 'premium_clean';
  const { data: rows } = await supabase
    .from('coins')
    .select('coingecko_id, symbol, name, image_url, market_cap_rank, total_volume')
    .lte('market_cap_rank', 100)
    .not('market_cap_rank', 'is', null)
    .neq('coingecko_id', 'bitcoin')
    .order('market_cap_rank', { ascending: true });
  const candidates = ((rows ?? []) as Coin[]).filter((c) => !isStable(c));

  const items: UniverseItem[] = [];
  let excluded = 0;
  for (const coin of candidates) {
    if (items.length >= limit) break;
    if (isWrapped(coin)) {
      excluded += 1;
      if (clean) continue;
    }
    const lowLiq = (coin.total_volume ?? 0) < MIN_VOLUME;
    if (clean && lowLiq) {
      excluded += 1;
      continue;
    }
    const pts = await readSeries(`cg:${coin.coingecko_id}`);
    if (pts.length < 2) {
      excluded += 1;
      continue;
    }
    const shortHistory = pts.length < MIN_HISTORY;
    if (clean && shortHistory) {
      excluded += 1;
      continue;
    }
    const r7 = retOver(pts, 7) ?? 0;
    const abnormal = Math.abs(r7) > 60 && (lowLiq || shortHistory);
    if (clean && abnormal) {
      excluded += 1;
      continue;
    }
    const badge: Badge = abnormal ? 'Abnormal spike' : shortHistory ? 'Short history' : lowLiq ? 'Low liquidity' : 'Clean';
    items.push({ coin, pts, badge });
  }
  return { items, excluded };
};

const regimeLabel = (outPct: number, posPct: number): string => {
  if (outPct < 25) return 'BTC season';
  if (outPct <= 45) return 'Altcoin weakness';
  if (outPct <= 60) return 'Neutral';
  if (outPct <= 75) return posPct >= 50 ? 'Broad altcoin strength' : 'Selective altcoin strength';
  return posPct >= 50 ? 'Altcoin season' : 'Relative altcoin strength';
};

const qualityLabel = (q: number): string =>
  q <= 25 ? 'Weak' : q <= 45 ? 'Low quality' : q <= 60 ? 'Mixed' : q <= 75 ? 'Selective but improving' : 'High quality altcoin season';

export interface AltcoinSeasonResult {
  timeframe: Timeframe;
  universe: Universe;
  tracked_count: number;
  btc_return: number;
  outperforming_btc_count: number;
  outperforming_btc_percent: number;
  positive_return_count: number;
  positive_return_percent: number;
  above_ma50_percent: number | null;
  above_ma200_percent: number | null;
  altcoin_season_index: number;
  altcoin_season_quality: number;
  quality_label: string;
  regime_label: string;
  confidence: 'High' | 'Medium' | 'Low';
  confidence_reason: string;
  premium_takeaway: string;
  true_leaders: CoinRow[];
  relative_defenders: CoinRow[];
  weak_vs_btc: CoinRow[];
  data_quality_summary: { clean: number; short_history: number; low_liquidity: number; abnormal_spike: number; excluded: number };
}

export const computeAltcoinSeason = async (timeframe: Timeframe = '30d', universe: Universe = 'premium_clean', limit = 50): Promise<AltcoinSeasonResult> => {
  const days = TF_DAYS[timeframe];

  const btcSeries = await readSeries('btc-full');
  const btcReturn = retOver(btcSeries, days);
  if (btcReturn == null) throw new Error('BTC price history not available for this timeframe. Run a Lab price-series sync.');

  const { items, excluded: staticExcluded } = await loadUniverse(universe, limit);

  const considered = items
    .map((it) => {
      const ret = retOver(it.pts, days);
      const last = it.pts[it.pts.length - 1].value;
      const ma50 = sma(it.pts, 50);
      const ma200 = sma(it.pts, 200);
      return { ...it, ret, aboveMa50: ma50 == null ? null : last > ma50, aboveMa200: ma200 == null ? null : last > ma200 };
    })
    .filter((c): c is typeof c & { ret: number } => c.ret != null);

  const excluded = staticExcluded + (items.length - considered.length);
  const tracked = considered.length;
  const out = considered.filter((c) => c.ret > btcReturn);
  const positive = considered.filter((c) => c.ret > 0);
  const ma50Have = considered.filter((c) => c.aboveMa50 != null);
  const ma200Have = considered.filter((c) => c.aboveMa200 != null);
  const ma50Pct = ma50Have.length ? (ma50Have.filter((c) => c.aboveMa50).length / ma50Have.length) * 100 : null;
  const ma200Pct = ma200Have.length ? (ma200Have.filter((c) => c.aboveMa200).length / ma200Have.length) * 100 : null;

  const outPct = tracked ? (out.length / tracked) * 100 : 0;
  const posPct = tracked ? (positive.length / tracked) * 100 : 0;
  const dataQualityPct = tracked ? (considered.filter((c) => c.badge === 'Clean').length / tracked) * 100 : 0;

  const index = Math.round(outPct);
  const quality = Math.round(0.4 * outPct + 0.25 * posPct + 0.15 * (ma50Pct ?? posPct) + 0.15 * (ma200Pct ?? posPct) + 0.05 * dataQualityPct);
  const regime = regimeLabel(outPct, posPct);

  const shortRatio = tracked ? considered.filter((c) => c.badge !== 'Clean').length / tracked : 1;
  const relativeOnly = outPct >= 61 && posPct < 50;
  let confidence: AltcoinSeasonResult['confidence'];
  let confidence_reason: string;
  if (tracked < 12 || shortRatio > 0.4) {
    confidence = 'Low';
    confidence_reason = `Only ${tracked} assets had clean data for this timeframe; treat the read as low-confidence.`;
  } else if (relativeOnly) {
    confidence = 'Medium';
    confidence_reason = `${out.length} of ${tracked} assets outperformed BTC, but positive-return breadth is low (${posPct.toFixed(0)}%) and several remain negative in USD terms.`;
  } else if (tracked >= 25) {
    confidence = 'High';
    confidence_reason = `${tracked} liquid assets with sufficient history; relative and absolute breadth broadly agree.`;
  } else {
    confidence = 'Medium';
    confidence_reason = `${tracked} assets tracked — a usable but moderate sample.`;
  }

  const toRow = (c: (typeof considered)[number]): CoinRow => {
    const relv = c.ret - btcReturn;
    const signal: CoinRow['signal'] = c.ret > btcReturn ? (c.ret > 0 ? 'True outperformer' : 'Relative outperformer, but still negative') : 'Weak vs BTC';
    return {
      symbol: c.coin.symbol.toUpperCase(),
      name: c.coin.name,
      image: c.coin.image_url,
      rank: c.coin.market_cap_rank,
      coin_return: Number(c.ret.toFixed(2)),
      btc_return: Number(btcReturn.toFixed(2)),
      relative: Number(relv.toFixed(2)),
      signal,
      badge: c.badge
    };
  };

  const true_leaders = out.filter((c) => c.ret > 0).sort((a, b) => b.ret - a.ret).slice(0, 10).map(toRow);
  const relative_defenders = out.filter((c) => c.ret <= 0).sort((a, b) => b.ret - a.ret).slice(0, 10).map(toRow);
  const weak_vs_btc = considered.filter((c) => c.ret <= btcReturn).sort((a, b) => a.ret - b.ret).slice(0, 10).map(toRow);

  const tfLabel = TF_LABEL[timeframe];
  const o = `${out.length} of ${tracked} tracked assets`;
  const takeaway = (() => {
    switch (regime) {
      case 'BTC season':
        return `Capital is concentrated in BTC — only ${o} outperformed it over ${tfLabel}. This is a BTC-led market, not an environment for broad altcoin risk.`;
      case 'Altcoin weakness':
        return `Most altcoins are lagging BTC (${o} outperformed over ${tfLabel}). Altcoin risk is unfavourable until breadth improves.`;
      case 'Neutral':
        return `Altcoins and BTC are roughly balanced (${o} beat BTC over ${tfLabel}) — no clear rotation yet. Stay selective and wait for confirmation.`;
      case 'Selective altcoin strength':
      case 'Relative altcoin strength':
        return `Altcoins are showing selective relative strength against BTC — ${o} outperformed BTC over ${tfLabel}. However, only ${posPct.toFixed(0)}% are positive in absolute terms, so several "outperformers" are simply falling less than BTC. Treat this as selective strength, not full risk-on confirmation.`;
      case 'Broad altcoin strength':
        return `Altcoin outperformance is broadening — ${o} beat BTC over ${tfLabel} and ${posPct.toFixed(0)}% are positive in absolute terms. This is stronger evidence of rotation, though not yet a full euphoric altcoin season.`;
      default:
        return `Altcoin strength is broad and high quality — most tracked altcoins are outperforming BTC and ${posPct.toFixed(0)}% are positive in absolute terms. This supports an altcoin-season regime; manage risk as the move extends.`;
    }
  })();

  return {
    timeframe,
    universe,
    tracked_count: tracked,
    btc_return: Number(btcReturn.toFixed(2)),
    outperforming_btc_count: out.length,
    outperforming_btc_percent: Math.round(outPct),
    positive_return_count: positive.length,
    positive_return_percent: Math.round(posPct),
    above_ma50_percent: ma50Pct == null ? null : Math.round(ma50Pct),
    above_ma200_percent: ma200Pct == null ? null : Math.round(ma200Pct),
    altcoin_season_index: index,
    altcoin_season_quality: quality,
    quality_label: qualityLabel(quality),
    regime_label: regime,
    confidence,
    confidence_reason,
    premium_takeaway: takeaway,
    true_leaders,
    relative_defenders,
    weak_vs_btc,
    data_quality_summary: {
      clean: considered.filter((c) => c.badge === 'Clean').length,
      short_history: considered.filter((c) => c.badge === 'Short history').length,
      low_liquidity: considered.filter((c) => c.badge === 'Low liquidity').length,
      abnormal_spike: considered.filter((c) => c.badge === 'Abnormal spike').length,
      excluded
    }
  };
};

// ── History: backfill the index + positive-return breadth over time by sliding
// the timeframe window across the stored series (no extra table needed). ──
export interface SeasonHistoryPoint {
  date: string;
  index: number;
  positive_pct: number;
  btc_price: number | null;
}

export const computeAltcoinSeasonHistory = async (timeframe: Timeframe = '30d', universe: Universe = 'premium_clean', lookbackDays = 365, limit = 50): Promise<SeasonHistoryPoint[]> => {
  const win = TF_DAYS[timeframe];
  const btc = await readSeries('btc-full');
  if (btc.length < win + 2) return [];
  const { items } = await loadUniverse(universe, limit);
  if (!items.length) return [];

  const lastTs = ts(btc[btc.length - 1].date);
  const startTs = lastTs - lookbackDays * DAY;

  // Walk BTC's daily dates within range (BTC is the densest series).
  const out: SeasonHistoryPoint[] = [];
  for (const p of btc) {
    const d = ts(p.date);
    if (d < startTs) continue;
    const btcRet = retEndingAt(btc, d, win);
    if (btcRet == null) continue;
    let outperf = 0;
    let positive = 0;
    let tracked = 0;
    for (const it of items) {
      const r = retEndingAt(it.pts, d, win);
      if (r == null) continue;
      tracked += 1;
      if (r > btcRet) outperf += 1;
      if (r > 0) positive += 1;
    }
    if (tracked < 8) continue; // not enough coverage that far back
    out.push({
      date: p.date,
      index: Math.round((outperf / tracked) * 100),
      positive_pct: Math.round((positive / tracked) * 100),
      btc_price: priceAt(btc, d)
    });
  }
  return out;
};
