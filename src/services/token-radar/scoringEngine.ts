import type { TokenSecurityDetail } from '../sources/goplus.client';
import type { HolderDataResult } from './holderData.service';

// ─────────────────────────────────────────────────────────────────────────────
// Token Position Radar scoring v2 — pure functions (no I/O), fully testable.
//
// Design principles:
//  • DEXScreener = market data; holder data carries its own source-confidence.
//  • Severe HOLDER penalties apply ONLY when holder data is verified. Unverified
//    low holders → a warning + lower analysis quality, never an auto "High Risk".
//  • Volume / liquidity-activity mismatch downgrade regardless of holder source.
//  • Ratings only ever move DOWN (downgradeRating), never up.
//  • Two confidences: data-availability (did providers respond) vs analysis-quality
//    (is the data healthy enough to trust the conclusion).
// Research signals only, never financial advice.
// ─────────────────────────────────────────────────────────────────────────────

export type Rating =
  | 'Strong Opportunity' | 'Good Watchlist Candidate' | 'Neutral / Wait for Confirmation'
  | 'Weak Setup' | 'High Risk / Avoid for Now' | 'Unknown / Insufficient Data';

const RATING_ORDER: Rating[] = [
  'Strong Opportunity', 'Good Watchlist Candidate', 'Neutral / Wait for Confirmation',
  'Weak Setup', 'High Risk / Avoid for Now', 'Unknown / Insufficient Data'
];

/** Never upgrades: returns whichever rating is worse (further down the order). */
export const downgradeRating = (current: Rating, maxAllowed: Rating): Rating =>
  RATING_ORDER.indexOf(current) >= RATING_ORDER.indexOf(maxAllowed) ? current : maxAllowed;

export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';
export interface RiskWarning { label: string; message: string; severity: RiskSeverity }

export interface MarketContext {
  macro_score: number | null; // 0–100 (risk-on high)
  btc_risk: number | null; // 0–1 (high = distribution risk)
  leverage_risk: number | null; // 0–1
  alt_season: number | null; // 0–100
}

export interface MarketData {
  liquidity_usd: number | null;
  volume_24h: number | null;
  market_cap: number | null;
  fdv: number | null;
  price_change_h1: number | null;
  price_change_h6: number | null;
  price_change_h24: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
}

export interface AnalysisInput {
  dex: MarketData | null; // null when no DEX pair was found
  holder: HolderDataResult;
  security: TokenSecurityDetail | null; // null when contract risk was not checked
  age_days: number | null;
  market: MarketContext;
  input_type: 'address' | 'ticker';
  listing_strength?: number | null; // 0–100 exchange-listing strength (confidence only)
  // Market Regime Engine (optional): broader altcoin environment. Influences
  // timing/risk and can CAP the rating in a hostile regime — never upgrades.
  regime?: { env_score: number | null; label: string; warnings: RiskWarning[] } | null;
  // Chart Intelligence (optional): historical structure scores. When present,
  // Momentum = price action 30% + volume trend 25% + RS vs BTC 25% + breakout 20%.
  chart?: { volume_trend_score: number; relative_strength_score: number; breakout_score: number } | null;
}

export interface Scores {
  opportunity: number | null;
  risk: number | null;
  momentum: number | null;
  liquidity: number | null;
  holder_health: number | null;
  contract_safety: number | null;
  timing: number | null;
}

export interface AnalysisResult {
  scores: Scores;
  confidence: { data_availability: number; analysis_quality: number; combined: number; note: string };
  holder_meta: { source: HolderDataResult['source']; confidence: HolderDataResult['confidence']; verified: boolean; weight_used: number; used_in_final_score: boolean; warning?: string };
  rating: Rating;
  rating_explanation: string;
  action_label: string;
  warnings: RiskWarning[];
  data_quality_warnings: string[];
  positives: string[];
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

// ── Component scores (0–100) ─────────────────────────────────────────────────
export const liquidityScore = (liq: number | null, vol: number | null): number => {
  if (liq == null || liq <= 0) return 0;
  let s = clamp(((Math.log10(liq) - 3) / 4) * 100);
  const ratio = vol != null && liq > 0 ? vol / liq : null;
  if (ratio != null) {
    if (ratio < 0.02) s -= 15; // stagnant pool — liquidity not confirmed by activity
    else if (ratio >= 0.2 && ratio <= 3) s += 6;
    else if (ratio > 10) s -= 8;
  }
  return clamp(s);
};

export const momentumScore = (d: MarketData): number => {
  let s = 50;
  if (d.price_change_h24 != null) s += Math.max(-20, Math.min(20, d.price_change_h24 * 0.4));
  if (d.price_change_h6 != null) s += Math.max(-12, Math.min(12, d.price_change_h6 * 0.6));
  if (d.price_change_h1 != null) s += Math.max(-6, Math.min(6, d.price_change_h1 * 0.6));
  const buys = d.buys_24h ?? 0;
  const sells = d.sells_24h ?? 0;
  if (buys + sells >= 20) {
    const r = buys / Math.max(1, sells);
    s += r >= 1.5 ? 10 : r >= 1.1 ? 5 : r <= 0.6 ? -10 : r <= 0.9 ? -5 : 0;
  } else if (buys + sells < 5) s -= 12; // barely trading
  if ((d.volume_24h ?? 0) < 100) s -= 15; // dead volume drags momentum hard
  return clamp(s);
};

export const holderHealthScore = (h: HolderDataResult): number | null => {
  if (h.holders == null && h.top10_percent == null) return null;
  let s = 50;
  if (h.holders != null && h.holders > 0) s = clamp((Math.log10(h.holders) / 5) * 100);
  const conc = h.top10_percent;
  if (conc != null) {
    if (conc > 70) s -= 40;
    else if (conc > 50) s -= 25;
    else if (conc > 30) s -= 10;
    else s += 5;
  }
  return clamp(s);
};

export const contractSafetyScore = (sec: TokenSecurityDetail | null): number | null => {
  if (!sec || !sec.checked) return null;
  if (sec.is_honeypot === true || sec.cannot_sell_all === true) return 0;
  let s = 70;
  if (sec.is_open_source === true) s += 10;
  if (sec.is_open_source === false) s -= 25;
  if (sec.has_blacklist === true) s -= 20;
  if (sec.mintable === true) s -= 15;
  if (sec.freezable === true) s -= 15;
  if (sec.is_proxy === true) s -= 10;
  if (sec.hidden_owner === true) s -= 25;
  if (sec.can_take_back_ownership === true) s -= 20;
  if (sec.owner_change_balance === true) s -= 25;
  if (sec.selfdestruct === true) s -= 30;
  const tax = (sec.buy_tax ?? 0) + (sec.sell_tax ?? 0);
  if (tax > 0.1) s -= 20;
  else if (tax > 0.05) s -= 10;
  if (sec.lp_locked_percent != null) {
    if (sec.lp_locked_percent >= 80) s += 10;
    else if (sec.lp_locked_percent < 20) s -= 15;
  }
  return clamp(s);
};

export const timingScore = (m: MarketContext): number | null => {
  const parts: { v: number; w: number }[] = [];
  if (m.macro_score != null) parts.push({ v: m.macro_score, w: 0.3 });
  if (m.btc_risk != null) parts.push({ v: (1 - m.btc_risk) * 100, w: 0.3 });
  if (m.leverage_risk != null) parts.push({ v: (1 - m.leverage_risk) * 100, w: 0.2 });
  if (m.alt_season != null) parts.push({ v: m.alt_season, w: 0.2 });
  if (!parts.length) return null;
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  return clamp(parts.reduce((s, p) => s + p.v * p.w, 0) / wsum);
};

const marketStrengthScore = (d: MarketData): number =>
  clamp(50 + Math.max(-25, Math.min(25, (d.price_change_h24 ?? 0) * 0.5)) + Math.max(-15, Math.min(15, (d.price_change_h6 ?? 0) * 0.5)));

export const riskScore = (i: AnalysisInput, holderVerified: boolean): number => {
  let r = 20;
  const liq = i.dex?.liquidity_usd ?? 0;
  if (liq > 0 && liq < 5_000) r += 30;
  else if (liq < 25_000) r += 20;
  else if (liq < 100_000) r += 10;
  const sec = i.security;
  if (!sec?.checked) r += 15;
  if (sec?.is_honeypot === true || sec?.cannot_sell_all === true) r += 60;
  if (sec?.is_open_source === false) r += 15;
  if (sec?.has_blacklist === true) r += 10;
  if ((sec?.buy_tax ?? 0) + (sec?.sell_tax ?? 0) > 0.1) r += 10;
  if (sec?.mintable === true && (sec?.hidden_owner === true || sec?.can_take_back_ownership === true || sec?.owner_change_balance === true)) r += 20;
  else if (sec?.hidden_owner === true || sec?.owner_change_balance === true) r += 12;
  // Holder concentration only adds risk when it's trustworthy.
  if (holderVerified && i.holder.top10_percent != null) {
    if (i.holder.top10_percent > 70) r += 20;
    else if (i.holder.top10_percent > 50) r += 10;
  }
  if (sec?.lp_locked_percent != null && sec.lp_locked_percent < 20) r += 10;
  const vol = i.dex?.volume_24h ?? 0;
  if (vol < 100) r += 15; // near-dead volume is risk
  else if (liq > 0 && vol / liq < 0.05) r += 8;
  if (i.age_days != null && i.age_days < 7) r += 15;
  else if (i.age_days != null && i.age_days < 30) r += 8;
  if (i.market.macro_score != null && i.market.macro_score < 40) r += 8;
  if (i.market.btc_risk != null && i.market.btc_risk >= 0.75) r += 8;
  return clamp(r);
};

const baseRatingFor = (opp: number): Rating =>
  opp >= 80 ? 'Strong Opportunity' : opp >= 65 ? 'Good Watchlist Candidate' : opp >= 50 ? 'Neutral / Wait for Confirmation' : opp >= 35 ? 'Weak Setup' : 'High Risk / Avoid for Now';

export const actionFor = (rating: Rating, holderVerified: boolean): string => {
  switch (rating) {
    case 'Strong Opportunity': return 'Strong setup, but manage risk';
    case 'Good Watchlist Candidate': return 'Watch closely';
    case 'Neutral / Wait for Confirmation': return holderVerified ? 'Wait for confirmation' : 'Wait for confirmation / needs verified holder data';
    case 'Weak Setup': return holderVerified ? 'Needs more activity' : 'Wait for confirmation / needs verified holder data';
    case 'High Risk / Avoid for Now': return 'Avoid for now';
    default: return 'Needs verified data';
  }
};

// ── Master pipeline ──────────────────────────────────────────────────────────
export const computeAnalysis = (i: AnalysisInput): AnalysisResult => {
  const warnings: RiskWarning[] = [];
  const data_quality_warnings: string[] = [];
  const positives: string[] = [];
  const hasDex = i.dex != null && (i.dex.liquidity_usd != null || i.dex.volume_24h != null);
  const secChecked = !!i.security?.checked;
  const holder = i.holder;
  const holderVerified = holder.verified && (holder.confidence === 'high' || holder.confidence === 'medium');

  // ── Minimum-data rule: nothing to score. ──
  if (!hasDex && holder.source === 'unknown' && !secChecked) {
    return {
      scores: { opportunity: null, risk: null, momentum: null, liquidity: null, holder_health: null, contract_safety: null, timing: null },
      confidence: { data_availability: 10, analysis_quality: 10, combined: 10, note: 'No reliable data was returned for this token from any provider.' },
      holder_meta: { source: holder.source, confidence: holder.confidence, verified: false, weight_used: 0, used_in_final_score: false, warning: holder.warning },
      rating: 'Unknown / Insufficient Data',
      rating_explanation: 'There is not enough reliable data (no DEX market, holders, or contract risk) to score this token.',
      action_label: 'Needs verified data',
      warnings: [{ label: 'Insufficient Data', message: 'No DEX, holder, or contract-risk data was available for this token.', severity: 'high' }],
      data_quality_warnings: [],
      positives: []
    };
  }

  const dex = i.dex ?? { liquidity_usd: null, volume_24h: null, market_cap: null, fdv: null, price_change_h1: null, price_change_h6: null, price_change_h24: null, buys_24h: null, sells_24h: null };

  // ── Component scores ──
  const liquidity = liquidityScore(dex.liquidity_usd, dex.volume_24h);
  // Momentum: short-term price action, upgraded with Chart Intelligence when
  // historical data exists (price action 30% + volume 25% + RS 25% + breakout 20%).
  const baseMomentum = momentumScore(dex);
  const momentum = i.chart
    ? clamp(baseMomentum * 0.3 + i.chart.volume_trend_score * 0.25 + i.chart.relative_strength_score * 0.25 + i.chart.breakout_score * 0.2)
    : baseMomentum;
  if (!i.chart) warnings.push({ label: 'No Chart History', message: 'Historical chart data is unavailable, so chart intelligence was not included.', severity: 'low' });
  const holder_health = holderHealthScore(holder);
  const contract_safety = contractSafetyScore(i.security);
  const strength = marketStrengthScore(dex);
  // Timing blends the platform macro context with the Market Regime Engine's
  // altcoin-environment score (50/50 when both are available).
  const baseTiming = timingScore(i.market);
  const envScore = i.regime?.env_score ?? null;
  const timing = baseTiming != null && envScore != null ? clamp(baseTiming * 0.5 + envScore * 0.5) : (envScore ?? baseTiming);

  // ── Holder weight by source confidence; unused weight redistributed. ──
  const holderWeight = holder_health == null ? 0 : !holderVerified ? 0.03 : holder.confidence === 'high' ? 0.15 : 0.075;
  const holderUsedInFinal = holderWeight >= 0.075 && holder_health != null;

  const parts: { v: number | null; w: number }[] = [
    { v: liquidity, w: 0.2 },
    { v: momentum, w: 0.2 },
    { v: holder_health, w: holderWeight },
    { v: strength, w: 0.15 },
    { v: timing, w: 0.15 },
    { v: contract_safety, w: 0.15 }
  ];
  const avail = parts.filter((p) => p.v != null) as { v: number; w: number }[];
  const wsum = avail.reduce((s, p) => s + p.w, 0) || 1;
  const opportunity = clamp(avail.reduce((s, p) => s + p.v * p.w, 0) / wsum);
  let risk = riskScore(i, holderVerified);
  // Hostile market regime raises downside risk for every altcoin (bounded bump).
  if (envScore != null) {
    if (envScore < 35) risk = clamp(risk + 8);
    else if (envScore < 45) risk = clamp(risk + 4);
  }

  // ── Warnings (severity-graded) ──
  const vol = dex.volume_24h;
  const liq = dex.liquidity_usd;
  if (vol != null && vol < 10) warnings.push({ label: 'Near-Zero Volume', message: '24h trading volume is almost zero — market activity is inactive.', severity: 'critical' });
  else if (vol != null && vol < 100) warnings.push({ label: 'Very Low Volume', message: '24h trading volume is very low — demand is weak and unconfirmed.', severity: 'high' });

  if (liq != null && liq > 100_000 && vol != null && vol < 100) {
    warnings.push({ label: 'Liquidity/Activity Mismatch', message: 'Reported liquidity is high, but trading activity is extremely low.', severity: 'high' });
    data_quality_warnings.push('High liquidity with near-zero volume may indicate inactive pools, stale data, unusual token structure, incomplete indexing, or unreliable market activity.');
  }
  if (liq != null && liq > 1_000_000 && vol != null && vol < 10) {
    data_quality_warnings.push('The token shows large reported liquidity but almost no trading. Treat this market data with caution.');
  }

  if (holder.holders != null && !holderVerified) {
    warnings.push({ label: 'Unverified Holder Data', message: `Holder count (${holder.holders.toLocaleString()}) is from ${holder.source === 'goplus' ? 'a security indexer' : holder.source} and is ${holder.confidence} confidence — it may be incomplete or pair-based, so it was not used as a severe risk override.`, severity: 'medium' });
    if (holder.warning) data_quality_warnings.push(holder.warning);
  }
  if (!secChecked) warnings.push({ label: 'Contract Risk Unknown', message: 'Contract safety data was unavailable for this token — treat contract risk as unknown.', severity: 'medium' });
  if (i.age_days != null && i.age_days < 30) warnings.push({ label: 'Young Token', message: `Token is ${i.age_days} day${i.age_days === 1 ? '' : 's'} old — history is too short to trust patterns.`, severity: i.age_days < 7 ? 'high' : 'low' });

  // ── Positives (never overpraise when activity is dead) ──
  const deadActivity = vol != null && vol < 100;
  if (liquidity >= 60) positives.push(deadActivity ? 'Reported liquidity appears strong, but it is not confirmed by trading activity.' : `Liquidity is solid (${fmtUsd(liq)}).`);
  else if (liquidity >= 40 && !deadActivity) positives.push(`Liquidity is acceptable (${fmtUsd(liq)}).`);
  if (!deadActivity && momentum >= 60) positives.push('Volume and short-term momentum are improving.');
  if (contract_safety != null && contract_safety >= 70) positives.push('Contract safety checks are above average.');
  if (holderVerified && (holder_health ?? 0) >= 60) positives.push(`Holder base looks healthy${holder.holders ? ` (${holder.holders.toLocaleString()} holders, ${holder.source})` : ''}.`);

  // ── Rating: base from opportunity, then only ever downgrade ──
  let rating: Rating = baseRatingFor(opportunity);
  const reasons: string[] = [];

  // Liquidity / volume / activity overrides (source-independent).
  if (liq != null && liq > 0 && liq < 10_000) { rating = downgradeRating(rating, 'Weak Setup'); reasons.push('liquidity is very low (under $10k), so exits are risky'); }
  if (vol != null && vol < 100) { rating = downgradeRating(rating, 'Weak Setup'); reasons.push('24h volume is almost zero, so liquidity is not confirmed by real trading activity'); }
  if (momentum < 45 && vol != null && vol < 1000) rating = downgradeRating(rating, 'Weak Setup');
  if (liq != null && liq > 100_000 && vol != null && vol < 100) rating = downgradeRating(rating, 'Weak Setup');
  if (liq != null && liq > 1_000_000 && vol != null && vol < 10) rating = downgradeRating(rating, 'Weak Setup');

  // Contract overrides (only when verified/checked).
  if (secChecked) {
    if (i.security!.is_honeypot === true || i.security!.cannot_sell_all === true) { rating = 'High Risk / Avoid for Now'; reasons.push('the contract restricts selling (honeypot behaviour)'); }
    if (i.security!.has_blacklist === true && i.security!.hidden_owner === true) { rating = 'High Risk / Avoid for Now'; reasons.push('a blacklist function is combined with a hidden owner'); }
    if ((contract_safety ?? 100) < 30) { rating = 'High Risk / Avoid for Now'; reasons.push('the contract has dangerous properties'); }
  }

  // Verified-holder overrides (severity by confidence). NEVER from unverified data.
  if (holderVerified && holder.holders != null) {
    if (holder.confidence === 'high') {
      if (holder.holders < 10 || holder_health === 0) { rating = 'High Risk / Avoid for Now'; reasons.push(`verified holder data shows only ${holder.holders} holder${holder.holders === 1 ? '' : 's'}`); }
      else if (holder.holders < 50) { rating = downgradeRating(rating, 'Weak Setup'); reasons.push('verified holders are very few'); }
      else if ((holder_health ?? 100) < 20) rating = downgradeRating(rating, 'Weak Setup');
    } else {
      // medium confidence → softer
      if (holder.holders < 10 || (holder_health ?? 100) < 20) { rating = downgradeRating(rating, 'Weak Setup'); reasons.push('holder data suggests very few holders (medium confidence)'); }
    }
  }

  // Aggregate severity → Weak Setup. Note: a "critical" DATA warning (e.g. dead
  // volume) does NOT auto-force High Risk — only genuinely severe RISK conditions
  // (honeypot, verified-low holders, risk>75) do, and those are handled above.
  const high = warnings.filter((w) => w.severity === 'high' || w.severity === 'critical').length;
  if (high >= 2) rating = downgradeRating(rating, 'Weak Setup');
  if (risk > 75) { rating = downgradeRating(rating, 'High Risk / Avoid for Now'); reasons.push('the overall risk score is very high'); }

  // Market-regime cap: in a hostile altcoin environment even a good token setup
  // shouldn't read better than "wait for confirmation". Never upgrades a rating.
  if (envScore != null && envScore < 30) {
    rating = downgradeRating(rating, 'Neutral / Wait for Confirmation');
    reasons.push(`the broader market regime is high-risk for altcoins (${i.regime?.label ?? 'hostile regime'})`);
  }

  // ── Confidence: availability vs quality ──
  let availC = 40;
  if (hasDex) availC += 25;
  if (holder.holders != null && holder.source !== 'unknown') availC += 12;
  if (secChecked) availC += 15;
  if (Object.values(i.market).some((v) => v != null)) availC += 8;
  availC = clamp(availC, 10, 98);

  let qualC = 70;
  if (holder.holders != null && !holderVerified) qualC -= 15;
  if (holder.source === 'unknown') qualC -= 12;
  if (vol != null && vol < 100) qualC -= 20;
  if (liq != null && liq > 100_000 && vol != null && vol < 100) qualC -= 15;
  if (!secChecked) qualC -= 12;
  if (i.age_days != null && i.age_days < 7) qualC -= 10;
  if (i.input_type === 'ticker') qualC -= 8;
  if (!Object.values(i.market).some((v) => v != null)) qualC -= 5;
  // Exchange-listing strength nudges CONFIDENCE only — it can't rescue a token
  // with severe risk or dead volume (those are handled by the overrides above).
  if (i.listing_strength != null) qualC += Math.max(-6, Math.min(8, Math.round((i.listing_strength - 40) * 0.15)));
  qualC = clamp(qualC, 5, 98);

  const combined = clamp(availC * 0.45 + qualC * 0.55);
  const qualLabel = qualC >= 70 ? 'healthy' : qualC >= 45 ? 'reduced' : 'weak';
  const confNote =
    qualC >= 70
      ? `Data providers responded and the data looks healthy (availability ${availC}, quality ${qualC}).`
      : `Data providers responded successfully (availability ${availC}), but analysis quality is ${qualLabel} (${qualC})${vol != null && vol < 100 ? ' — trading volume is almost zero' : ''}${holder.holders != null && !holderVerified ? ', holder data is unverified' : ''}${data_quality_warnings.length ? ', and some metrics look abnormal' : ''}.`;

  // ── Rating explanation ──
  const rating_explanation =
    rating === 'Unknown / Insufficient Data'
      ? 'There was not enough reliable data to score this token.'
      : reasons.length
        ? `The token was rated ${rating} because ${dedupe(reasons).join(', ')}.${!holderVerified && holder.holders != null ? ' Holder data is unverified, so it was not used as a severe holder-risk override.' : ''}`
        : `The token was rated ${rating} based on the balance of liquidity, momentum, contract safety and market timing.`;

  const action_label = actionFor(rating, holderVerified);

  return {
    scores: { opportunity, risk, momentum, liquidity, holder_health, contract_safety, timing },
    confidence: { data_availability: availC, analysis_quality: qualC, combined, note: confNote },
    holder_meta: { source: holder.source, confidence: holder.confidence, verified: holderVerified, weight_used: holderWeight, used_in_final_score: holderUsedInFinal, warning: holder.warning },
    rating,
    rating_explanation,
    action_label,
    warnings: sortSeverity(warnings),
    data_quality_warnings: dedupe(data_quality_warnings),
    positives
  };
};

// ── helpers ──
const fmtUsd = (n: number | null) => (n == null ? 'unknown' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);
const dedupe = (a: string[]) => [...new Set(a)];
const SEV_RANK: Record<RiskSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const sortSeverity = (w: RiskWarning[]) => [...w].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
