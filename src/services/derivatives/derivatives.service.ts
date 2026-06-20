import { supabase } from '../../config/supabase';
import { getAllFuturesTickers, getCurrentFunding, getLongShort, getOpenInterest } from '../sources/bitget.client';

// ─────────────────────────────────────────────────────────────────────────────
// Derivatives / Leverage Risk — turns Bitget funding rate, open interest and
// long/short ratio into a 0–1 leverage-risk read. High = crowded longs /
// over-leveraged (fragile); low/negative = fearful / deleveraged.
// Probability-style, never an instruction. Fully optional: if Bitget is
// unreachable the result is "unavailable" and nothing downstream breaks.
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number, d = 4) => Number(n.toFixed(d));

export interface DerivativesResult {
  as_of: string;
  leverage_risk: number | null;
  leverage_percent: number | null;
  label: string;
  confidence: 'High' | 'Medium' | 'Low';
  interpretation: string;
  btc_funding_rate: number | null;
  eth_funding_rate: number | null;
  btc_open_interest: number | null;
  eth_open_interest: number | null;
  btc_long_short: number | null;
  eth_long_short: number | null;
  hot_funding_breadth: number | null;
  components: { funding_risk: number | null; long_short_risk: number | null };
  top_funding: { symbol: string; funding: number }[]; // most crowded longs (highest funding)
  bottom_funding: { symbol: string; funding: number }[]; // most fearful / short-paid (negative funding)
}

export interface DerivativesHistoryPoint {
  date: string;
  leverage_percent: number | null;
  btc_funding_rate: number | null;
  btc_open_interest: number | null;
  btc_long_short: number | null;
}

// Funding (per 8h) → risk. Small positive ≈ neutral; high positive = crowded longs.
const fundingRisk = (f: number | null): number | null => (f == null ? null : round(clamp01((f + 0.0002) / 0.0012), 3));
// Long/short ratio → risk. 1.0 balanced; >2 = heavily long.
const lsRisk = (r: number | null): number | null => (r == null ? null : round(clamp01((r - 0.7) / 1.3), 3));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const computeDerivatives = async (): Promise<DerivativesResult> => {
  // Everything except long/short can be fetched concurrently.
  const [btcF, ethF, btcOI, ethOI, tickers] = await Promise.all([
    getCurrentFunding('BTCUSDT'),
    getCurrentFunding('ETHUSDT'),
    getOpenInterest('BTCUSDT'),
    getOpenInterest('ETHUSDT'),
    getAllFuturesTickers()
  ]);
  // The long/short endpoint is rate-limited to 1 req/s, so fetch BTC then ETH
  // sequentially with a gap. Each is independent — if one fails we keep the other.
  const btcLS = await getLongShort('BTCUSDT', '1h');
  await sleep(1100);
  const ethLS = await getLongShort('ETHUSDT', '1h');

  const fRisk = fundingRisk(btcF);
  const lRisk = lsRisk(btcLS);
  const parts = [
    { w: 0.6, v: fRisk },
    { w: 0.4, v: lRisk }
  ].filter((p) => p.v != null) as { w: number; v: number }[];
  const wsum = parts.reduce((s, p) => s + p.w, 0) || 1;
  const leverage = parts.length ? round(clamp01(parts.reduce((s, p) => s + p.w * p.v, 0) / wsum), 3) : null;

  // Liquid universe only — drop illiquid micro-cap perps whose funding is noise.
  // Fall back to all-with-funding if volume is missing across the board.
  const MIN_VOL = 20_000_000; // $20M 24h
  const withFunding = tickers.filter((t) => t.fundingRate != null);
  const liquid = withFunding.filter((t) => (t.volume ?? 0) >= MIN_VOL);
  const universe = liquid.length >= 20 ? liquid : withFunding;

  // Breadth: share of liquid futures with "hot" funding (> 0.03% / 8h).
  const hotBreadth = universe.length ? Math.round((universe.filter((t) => (t.fundingRate as number) > 0.0003).length / universe.length) * 100) : null;

  // Per-coin funding extremes: most crowded longs (highest +funding) and most
  // fearful / short-paid (most negative funding). Coin symbol only (drop USDT).
  const coin = (s: string) => s.replace(/USDT$/, '');
  const sortedFunding = [...universe].sort((a, b) => (b.fundingRate as number) - (a.fundingRate as number));
  const top_funding = sortedFunding.slice(0, 6).filter((t) => (t.fundingRate as number) > 0).map((t) => ({ symbol: coin(t.symbol), funding: t.fundingRate as number }));
  const bottom_funding = sortedFunding.slice(-6).reverse().filter((t) => (t.fundingRate as number) < 0).map((t) => ({ symbol: coin(t.symbol), funding: t.fundingRate as number }));

  let label: string;
  if (leverage == null) label = 'Unavailable';
  else if (btcF != null && btcF < 0 && leverage < 0.35) label = 'Fear / short-heavy';
  else if (leverage < 0.35) label = 'Low leverage';
  else if (leverage < 0.55) label = 'Normal';
  else if (leverage < 0.75) label = 'Elevated leverage';
  else label = 'Overheated / crowded longs';

  const present = [fRisk, lRisk, hotBreadth].filter((x) => x != null).length;
  const confidence: DerivativesResult['confidence'] = present >= 3 ? 'High' : present === 2 ? 'Medium' : 'Low';

  const interpretation =
    leverage == null
      ? 'Live derivatives data is unavailable right now. This read is skipped until it returns.'
      : leverage >= 0.75
        ? 'Funding and positioning point to crowded long leverage — historically a more fragile, higher-risk backdrop. Long-squeezes become more likely if price stalls.'
        : leverage >= 0.55
          ? 'Leverage is building. Funding is rising and traders lean long — watch for over-extension if price keeps climbing.'
          : btcF != null && btcF < 0
            ? 'Funding is negative and positioning is short-heavy — the market is fearful, which is often a lower-risk backdrop for patient buyers.'
            : 'Leverage looks calm — funding and positioning are not stretched, which is a healthier backdrop than crowded-long conditions.';

  return {
    as_of: new Date().toISOString(),
    leverage_risk: leverage,
    leverage_percent: leverage == null ? null : Math.round(leverage * 100),
    label,
    confidence,
    interpretation,
    btc_funding_rate: btcF,
    eth_funding_rate: ethF,
    btc_open_interest: btcOI,
    eth_open_interest: ethOI,
    btc_long_short: btcLS,
    eth_long_short: ethLS,
    hot_funding_breadth: hotBreadth,
    components: { funding_risk: fRisk, long_short_risk: lRisk },
    top_funding,
    bottom_funding
  };
};

/** Persist today's derivatives read (for the overview + exit-strategy blend). */
export const storeDerivativesDaily = async (): Promise<number> => {
  const r = await computeDerivatives();
  if (r.leverage_risk == null) return 0; // nothing to store when Bitget is down
  const date = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('derivatives_daily').upsert(
    {
      date,
      btc_funding_rate: r.btc_funding_rate,
      eth_funding_rate: r.eth_funding_rate,
      btc_open_interest: r.btc_open_interest,
      eth_open_interest: r.eth_open_interest,
      btc_long_short: r.btc_long_short,
      eth_long_short: r.eth_long_short,
      hot_funding_breadth: r.hot_funding_breadth,
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

/** Stored daily history for the trend chart. Oldest → newest. Best-effort. */
export const getDerivativesHistory = async (days = 90): Promise<DerivativesHistoryPoint[]> => {
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const { data } = await supabase
      .from('derivatives_daily')
      .select('date, leverage_percent, btc_funding_rate, btc_open_interest, btc_long_short')
      .gte('date', since)
      .order('date', { ascending: true });
    return (data ?? []).map((r) => ({
      date: r.date as string,
      leverage_percent: r.leverage_percent == null ? null : Number(r.leverage_percent),
      btc_funding_rate: r.btc_funding_rate == null ? null : Number(r.btc_funding_rate),
      btc_open_interest: r.btc_open_interest == null ? null : Number(r.btc_open_interest),
      btc_long_short: r.btc_long_short == null ? null : Number(r.btc_long_short)
    }));
  } catch {
    return [];
  }
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
      .select('leverage_risk, btc_funding_rate, btc_open_interest, btc_long_short, label')
      .order('date', { ascending: false })
      .limit(2);
    if (!data || !data.length || data[0].leverage_risk == null) return null;
    const cur = data[0];
    const prev = data[1];
    const ls = cur.btc_long_short == null ? null : Number(cur.btc_long_short);
    return {
      leverage_risk: Number(cur.leverage_risk),
      label: (cur.label as string) ?? 'Normal',
      funding_high: cur.btc_funding_rate != null && Number(cur.btc_funding_rate) > 0.0003,
      oi_rising: cur.btc_open_interest != null && prev?.btc_open_interest != null && Number(cur.btc_open_interest) > Number(prev.btc_open_interest) * 1.03,
      ls_extreme: ls != null && (ls > 1.8 || ls < 0.6)
    };
  } catch {
    return null;
  }
};
