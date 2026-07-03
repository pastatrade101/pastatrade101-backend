import { supabase } from '../../config/supabase';
import { computeAltcoinSeason } from '../altcoin-btc/altcoin-season.service';
import { readLatestSocialRisk } from '../social/social-latest.service';

// ─────────────────────────────────────────────────────────────────────────────
// Market Regime Engine — ONE normalized read of "is the broader market
// supportive or dangerous for altcoins right now?".
//
// Pure ADAPTER layer: it reuses the platform's existing indicators (global
// market snapshots, BTC risk model, altcoin season, derivatives leverage,
// Fear & Greed) and never duplicates their computation. Every input is
// graceful: unavailable → "unknown" with zero score impact, never a crash.
//
// scoreImpact convention: positive = supportive for altcoins, negative =
// hostile. altcoinEnvironmentScore = 50 + Σimpacts, clamped 0–100.
// ─────────────────────────────────────────────────────────────────────────────

export type Trend3 = 'rising' | 'falling' | 'sideways' | 'unknown';
export type Bias3 = 'bullish' | 'neutral' | 'bearish' | 'unknown';
export type Level4 = 'low' | 'medium' | 'high' | 'extreme' | 'unknown';
export type RegimeSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface RegimeWarning {
  label: string;
  message: string;
  severity: RegimeSeverity;
}

export type MarketTimingLabel =
  | 'Strong altcoin tailwind'
  | 'Improving altcoin conditions'
  | 'Mixed market backdrop'
  | 'Weak altcoin environment'
  | 'High-risk market regime'
  | 'Unknown';

export interface MarketRegimeSnapshot {
  timestamp: string;
  btcDominance: { value: number | null; trend: Trend3; strength: 'weak' | 'medium' | 'strong' | 'unknown'; scoreImpact: number };
  btcRisk: { level: Level4; scoreImpact: number };
  altcoinSeason: { status: 'not_confirmed' | 'early_rotation' | 'confirmed' | 'overheated' | 'unknown'; scoreImpact: number };
  ethBtcTrend: { trend: Bias3; scoreImpact: number };
  total2Trend: { trend: Bias3; scoreImpact: number };
  total3Trend: { trend: Bias3; scoreImpact: number };
  stablecoinDominance: { trend: Trend3; interpretation: 'risk_off' | 'risk_on' | 'neutral' | 'unknown'; scoreImpact: number };
  leverageRisk: { level: Level4; scoreImpact: number };
  sentiment: { regime: 'fear' | 'neutral' | 'greed' | 'euphoria' | 'unknown'; scoreImpact: number };
  altcoinEnvironmentScore: number;
  marketTimingLabel: MarketTimingLabel;
  warnings: RegimeWarning[];
  summary: string;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

// ── Trend helper: % change of recent avg vs prior avg over a numeric series. ──
const pctTrend = (series: number[]): { changePct: number | null; trend: Trend3 } => {
  const vals = series.filter((v) => Number.isFinite(v));
  if (vals.length < 6) return { changePct: null, trend: 'unknown' };
  const half = Math.floor(vals.length / 2);
  const recent = vals.slice(0, half); // series is newest-first
  const prior = vals.slice(half);
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const prev = avg(prior);
  if (!prev) return { changePct: null, trend: 'unknown' };
  const changePct = ((avg(recent) - prev) / Math.abs(prev)) * 100;
  return { changePct, trend: changePct > 0.35 ? 'rising' : changePct < -0.35 ? 'falling' : 'sideways' };
};
const biasOf = (t: Trend3): Bias3 => (t === 'rising' ? 'bullish' : t === 'falling' ? 'bearish' : t === 'sideways' ? 'neutral' : 'unknown');

interface GlobalRow {
  btc_dominance: number | null;
  eth_dominance: number | null;
  total_market_cap: number | null;
  stablecoin_market_cap: number | null;
  btc_price: number | null;
  eth_price: number | null;
  captured_at: string;
}

// ── 5-minute in-memory cache (analyses are on-demand; the regime moves slowly). ──
let cache: { at: number; snap: MarketRegimeSnapshot } | null = null;
const CACHE_MS = 5 * 60_000;

export const getMarketRegimeSnapshot = async (): Promise<MarketRegimeSnapshot> => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.snap;

  const [globalsRes, riskRes, derivRes, alt, social] = await Promise.all([
    supabase.from('global_market_snapshots').select('btc_dominance, eth_dominance, total_market_cap, stablecoin_market_cap, btc_price, eth_price, captured_at').order('captured_at', { ascending: false }).limit(30),
    supabase.from('risk_summary_daily').select('summary_risk').order('snapshot_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('derivatives_daily').select('leverage_risk').order('date', { ascending: false }).limit(1).maybeSingle(),
    computeAltcoinSeason('30d', 'premium_clean').catch(() => null),
    readLatestSocialRisk().catch(() => null)
  ]);

  const rows = (globalsRes.data ?? []) as GlobalRow[];
  const warnings: RegimeWarning[] = [];

  // ── 1 · BTC dominance trend (rising dominance = money hiding in BTC = alt headwind) ──
  const domSeries = rows.map((r) => r.btc_dominance ?? NaN);
  const dom = pctTrend(domSeries);
  const domStrength: 'weak' | 'medium' | 'strong' | 'unknown' =
    dom.changePct == null ? 'unknown' : Math.abs(dom.changePct) > 2 ? 'strong' : Math.abs(dom.changePct) > 0.8 ? 'medium' : 'weak';
  const domImpact = dom.trend === 'falling' ? (domStrength === 'strong' ? 8 : 5) : dom.trend === 'rising' ? (domStrength === 'strong' ? -8 : -5) : 0;
  const btcDominance = { value: rows[0]?.btc_dominance ?? null, trend: dom.trend, strength: domStrength, scoreImpact: domImpact };
  if (dom.trend === 'rising' && domStrength === 'strong') warnings.push({ label: 'BTC Dominance Rising', message: 'Bitcoin dominance is rising strongly — capital is rotating away from altcoins.', severity: 'high' });

  // ── 2 · BTC risk level (existing risk model, 0–1) ──
  const btcRiskVal = riskRes.data?.summary_risk != null ? Number(riskRes.data.summary_risk) : null;
  const btcRiskLevel: Level4 = btcRiskVal == null ? 'unknown' : btcRiskVal < 0.35 ? 'low' : btcRiskVal < 0.6 ? 'medium' : btcRiskVal < 0.8 ? 'high' : 'extreme';
  const btcRisk = { level: btcRiskLevel, scoreImpact: btcRiskLevel === 'low' ? 6 : btcRiskLevel === 'medium' ? 0 : btcRiskLevel === 'high' ? -6 : btcRiskLevel === 'extreme' ? -10 : 0 };
  if (btcRiskLevel === 'extreme') warnings.push({ label: 'Extreme BTC Risk', message: 'The BTC risk model is in its extreme zone — historically hostile for speculative altcoins.', severity: 'critical' });

  // ── 3 · Altcoin season condition (existing index, 0–100) ──
  const altIdx = alt ? Number(alt.altcoin_season_index) : null;
  const altStatus = altIdx == null ? 'unknown' : altIdx < 40 ? 'not_confirmed' : altIdx < 60 ? 'early_rotation' : altIdx < 80 ? 'confirmed' : 'overheated';
  const altcoinSeason = {
    status: altStatus as MarketRegimeSnapshot['altcoinSeason']['status'],
    scoreImpact: altStatus === 'confirmed' ? 8 : altStatus === 'early_rotation' ? 4 : altStatus === 'overheated' ? -4 : altStatus === 'not_confirmed' ? -4 : 0
  };
  if (altStatus === 'overheated') warnings.push({ label: 'Altcoin Overheat', message: 'Altcoin breadth looks overheated — late-stage rotations reverse fast.', severity: 'medium' });

  // ── 4 · ETH/BTC trend (alt leadership proxy) ──
  const ethBtcSeries = rows.map((r) => (r.eth_price && r.btc_price ? r.eth_price / r.btc_price : NaN));
  const ethBtc = pctTrend(ethBtcSeries);
  const ethBtcTrend = { trend: biasOf(ethBtc.trend), scoreImpact: ethBtc.trend === 'rising' ? 5 : ethBtc.trend === 'falling' ? -5 : 0 };

  // ── 5/6 · TOTAL2 / TOTAL3 trends (alt market cap ex-BTC / ex-BTC-ETH) ──
  const total2Series = rows.map((r) => (r.total_market_cap && r.btc_dominance != null ? r.total_market_cap * (1 - r.btc_dominance / 100) : NaN));
  const total3Series = rows.map((r) => (r.total_market_cap && r.btc_dominance != null && r.eth_dominance != null ? r.total_market_cap * (1 - r.btc_dominance / 100 - r.eth_dominance / 100) : NaN));
  const t2 = pctTrend(total2Series);
  const t3 = pctTrend(total3Series);
  const total2Trend = { trend: biasOf(t2.trend), scoreImpact: t2.trend === 'rising' ? 5 : t2.trend === 'falling' ? -5 : 0 };
  const total3Trend = { trend: biasOf(t3.trend), scoreImpact: t3.trend === 'rising' ? 4 : t3.trend === 'falling' ? -4 : 0 };
  if (t2.trend === 'falling' && t3.trend === 'falling') warnings.push({ label: 'Alt Market Contracting', message: 'TOTAL2 and TOTAL3 are both falling — the altcoin market is losing capital.', severity: 'high' });

  // ── 7 · Stablecoin dominance (rising share = risk-off cash positioning) ──
  const stableSeries = rows.map((r) => (r.stablecoin_market_cap && r.total_market_cap ? (r.stablecoin_market_cap / r.total_market_cap) * 100 : NaN));
  const st = pctTrend(stableSeries);
  const stInterp = st.trend === 'rising' ? 'risk_off' : st.trend === 'falling' ? 'risk_on' : st.trend === 'sideways' ? 'neutral' : 'unknown';
  const stablecoinDominance = {
    trend: st.trend,
    interpretation: stInterp as MarketRegimeSnapshot['stablecoinDominance']['interpretation'],
    scoreImpact: stInterp === 'risk_on' ? 4 : stInterp === 'risk_off' ? -4 : 0
  };

  // ── 8 · Leverage risk (existing derivatives model, 0–1) ──
  const levVal = derivRes.data?.leverage_risk != null ? Number(derivRes.data.leverage_risk) : null;
  const levLevel: Level4 = levVal == null ? 'unknown' : levVal < 0.35 ? 'low' : levVal < 0.6 ? 'medium' : levVal < 0.8 ? 'high' : 'extreme';
  const leverageRisk = { level: levLevel, scoreImpact: levLevel === 'low' ? 3 : levLevel === 'high' ? -4 : levLevel === 'extreme' ? -8 : 0 };
  if (levLevel === 'extreme') warnings.push({ label: 'Extreme Leverage', message: 'Derivatives leverage is extreme — liquidation cascades hit altcoins hardest.', severity: 'high' });

  // ── 9 · Sentiment regime (Fear & Greed, 0–100) ──
  const fg = social?.detail?.fear_greed ?? null;
  const sentimentRegime = fg == null ? 'unknown' : fg < 30 ? 'fear' : fg < 60 ? 'neutral' : fg < 80 ? 'greed' : 'euphoria';
  const sentiment = {
    regime: sentimentRegime as MarketRegimeSnapshot['sentiment']['regime'],
    // Contrarian at the edges: deep fear is not a headwind for accumulation; euphoria is a warning.
    scoreImpact: sentimentRegime === 'greed' ? 2 : sentimentRegime === 'euphoria' ? -6 : 0
  };
  if (sentimentRegime === 'euphoria') warnings.push({ label: 'Euphoric Sentiment', message: 'Fear & Greed is in euphoria — crowd exuberance often precedes corrections.', severity: 'medium' });

  // ── Composite ──
  const parts = [btcDominance, btcRisk, altcoinSeason, ethBtcTrend, total2Trend, total3Trend, stablecoinDominance, leverageRisk, sentiment];
  const known = parts.filter((p) => p.scoreImpact !== 0 || !isUnknown(p)).length;
  const altcoinEnvironmentScore = clamp(50 + parts.reduce((s, p) => s + p.scoreImpact, 0));

  const critical = warnings.some((w) => w.severity === 'critical');
  const marketTimingLabel: MarketTimingLabel =
    known === 0 ? 'Unknown'
    : critical || altcoinEnvironmentScore < 30 ? 'High-risk market regime'
    : altcoinEnvironmentScore < 45 ? 'Weak altcoin environment'
    : altcoinEnvironmentScore < 60 ? 'Mixed market backdrop'
    : altcoinEnvironmentScore < 75 ? 'Improving altcoin conditions'
    : 'Strong altcoin tailwind';

  const drivers: string[] = [];
  if (btcDominance.trend !== 'unknown') drivers.push(`BTC dominance ${btcDominance.trend}`);
  if (altStatus !== 'unknown') drivers.push(`altcoin season ${altStatus.replace('_', ' ')}`);
  if (total2Trend.trend !== 'unknown') drivers.push(`TOTAL2 ${total2Trend.trend}`);
  if (btcRiskLevel !== 'unknown') drivers.push(`BTC risk ${btcRiskLevel}`);
  const summary = known === 0
    ? 'Market regime data is unavailable right now — token analysis runs without a market backdrop.'
    : `${marketTimingLabel} (${altcoinEnvironmentScore}/100): ${drivers.slice(0, 4).join(', ')}${sentimentRegime !== 'unknown' ? `, sentiment ${sentimentRegime}` : ''}.`;

  const snap: MarketRegimeSnapshot = {
    timestamp: new Date().toISOString(),
    btcDominance, btcRisk, altcoinSeason, ethBtcTrend, total2Trend, total3Trend, stablecoinDominance, leverageRisk, sentiment,
    altcoinEnvironmentScore, marketTimingLabel, warnings, summary
  };
  cache = { at: Date.now(), snap };
  return snap;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isUnknown = (p: any): boolean =>
  p.trend === 'unknown' || p.level === 'unknown' || p.status === 'unknown' || p.regime === 'unknown' || p.interpretation === 'unknown';
