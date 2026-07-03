import type { TokenSecurityDetail } from '../sources/goplus.client';

// ─────────────────────────────────────────────────────────────────────────────
// Token Position Radar scoring — pure functions (no I/O) so every rule is
// testable. All scores are 0–100. Probability-style research signals, never
// financial advice; ratings use watch/avoid language only.
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketContext {
  macro_score: number | null; // 0–100 (risk-on high)
  btc_risk: number | null; // 0–1 (high = distribution risk)
  leverage_risk: number | null; // 0–1
  alt_season: number | null; // 0–100
}

export interface ScoringInput {
  liquidity_usd: number | null;
  volume_24h: number | null;
  market_cap: number | null;
  fdv: number | null;
  price_change_h1: number | null;
  price_change_h6: number | null;
  price_change_h24: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
  age_days: number | null;
  security: TokenSecurityDetail;
  market: MarketContext;
  input_type: 'address' | 'ticker';
}

export interface Scores {
  opportunity: number;
  risk: number;
  momentum: number;
  liquidity: number;
  holder_health: number | null;
  contract_safety: number | null;
  timing: number | null;
  confidence: number;
}

export type Rating = 'Strong Opportunity' | 'Good Watchlist Candidate' | 'Neutral / Wait for Confirmation' | 'Weak Setup' | 'High Risk / Avoid for Now';

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

// ── Liquidity: log scale — $1k→0 · $10k→25 · $100k→50 · $1M→75 · $10M→100,
// nudged by the volume/liquidity ratio (dead pools score lower). ──
export const liquidityScore = (liq: number | null, vol: number | null): number => {
  if (liq == null || liq <= 0) return 0;
  let s = clamp(((Math.log10(liq) - 3) / 4) * 100);
  const ratio = vol != null && liq > 0 ? vol / liq : null;
  if (ratio != null) {
    if (ratio < 0.02) s -= 10; // stagnant pool
    else if (ratio >= 0.2 && ratio <= 3) s += 6; // healthy turnover
    else if (ratio > 10) s -= 8; // suspicious churn vs depth
  }
  return clamp(s);
};

// ── Momentum: recent price action + buy/sell pressure. ──
export const momentumScore = (i: ScoringInput): number => {
  let s = 50;
  if (i.price_change_h24 != null) s += Math.max(-20, Math.min(20, i.price_change_h24 * 0.4));
  if (i.price_change_h6 != null) s += Math.max(-12, Math.min(12, i.price_change_h6 * 0.6));
  if (i.price_change_h1 != null) s += Math.max(-6, Math.min(6, i.price_change_h1 * 0.6));
  const buys = i.buys_24h ?? 0;
  const sells = i.sells_24h ?? 0;
  if (buys + sells >= 20) {
    const ratio = buys / Math.max(1, sells);
    s += ratio >= 1.5 ? 10 : ratio >= 1.1 ? 5 : ratio <= 0.6 ? -10 : ratio <= 0.9 ? -5 : 0;
  } else if (buys + sells < 5) s -= 8; // barely trading
  return clamp(s);
};

// ── Holder health: count (log scale) minus concentration penalties. ──
export const holderHealthScore = (sec: TokenSecurityDetail): number | null => {
  if (sec.holder_count == null && sec.top10_percent == null) return null;
  let s = 50;
  if (sec.holder_count != null && sec.holder_count > 0) s = clamp((Math.log10(sec.holder_count) / 5) * 100); // 100→40 · 1k→60 · 10k→80 · 100k→100
  if (sec.top10_percent != null) {
    if (sec.top10_percent > 70) s -= 40;
    else if (sec.top10_percent > 50) s -= 25;
    else if (sec.top10_percent > 30) s -= 10;
    else s += 5;
  }
  if (sec.creator_percent != null && sec.creator_percent > 20) s -= 15;
  return clamp(s);
};

// ── Contract safety: start neutral-good, subtract for every dangerous property. ──
export const contractSafetyScore = (sec: TokenSecurityDetail): number | null => {
  if (!sec.checked) return null;
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

// ── Timing: platform market regime blended (reweighted over what's available). ──
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

// ── Relative-strength proxy (token vs broad market): short-term price action.
// Honest limitation: without the token's history vs BTC we proxy with 6–24h
// action, damped so it can't dominate the composite. ──
const marketStrengthScore = (i: ScoringInput): number =>
  clamp(50 + Math.max(-25, Math.min(25, (i.price_change_h24 ?? 0) * 0.5)) + Math.max(-15, Math.min(15, (i.price_change_h6 ?? 0) * 0.5)));

// ── Risk (separate axis, high = risky). ──
export const riskScore = (i: ScoringInput): number => {
  let r = 20;
  const liq = i.liquidity_usd ?? 0;
  if (liq < 5_000) r += 30;
  else if (liq < 25_000) r += 20;
  else if (liq < 100_000) r += 10;
  const sec = i.security;
  if (!sec.checked) r += 15; // unknown contract = risk
  if (sec.is_honeypot === true || sec.cannot_sell_all === true) r += 60;
  if (sec.is_open_source === false) r += 15;
  if (sec.has_blacklist === true) r += 10;
  if ((sec.buy_tax ?? 0) + (sec.sell_tax ?? 0) > 0.1) r += 10;
  if (sec.mintable === true && (sec.hidden_owner === true || sec.can_take_back_ownership === true || sec.owner_change_balance === true)) r += 20;
  else if (sec.hidden_owner === true || sec.owner_change_balance === true) r += 12;
  if (sec.top10_percent != null && sec.top10_percent > 70) r += 20;
  else if (sec.top10_percent != null && sec.top10_percent > 50) r += 10;
  if (sec.lp_locked_percent != null && sec.lp_locked_percent < 20) r += 10;
  const vol = i.volume_24h ?? 0;
  if (liq > 0 && vol / liq < 0.05) r += 8; // dead volume
  if (i.age_days != null && i.age_days < 7) r += 15;
  else if (i.age_days != null && i.age_days < 30) r += 8;
  if (i.market.macro_score != null && i.market.macro_score < 40) r += 8;
  if (i.market.btc_risk != null && i.market.btc_risk >= 0.75) r += 8;
  return clamp(r);
};

// ── Severe-risk override: these force "High Risk / Avoid for Now". ──
export const severeRiskReasons = (i: ScoringInput): string[] => {
  const sec = i.security;
  const reasons: string[] = [];
  if (sec.is_honeypot === true) reasons.push('Honeypot behaviour detected — selling may be blocked.');
  if (sec.cannot_sell_all === true) reasons.push('Contract restricts selling (cannot sell all).');
  if (sec.has_blacklist === true && sec.hidden_owner === true) reasons.push('Blacklist function combined with a hidden owner.');
  if (sec.mintable === true && (sec.hidden_owner === true || sec.can_take_back_ownership === true || sec.owner_change_balance === true)) reasons.push('Active mint function with dangerous owner privileges.');
  if ((i.liquidity_usd ?? 0) > 0 && (i.liquidity_usd ?? 0) < 3_000) reasons.push('Liquidity is extremely low (under $3k).');
  if (sec.top10_percent != null && sec.top10_percent > 85) reasons.push('Top-10 wallets hold an extreme share of supply.');
  if (sec.is_open_source === false && sec.lp_locked_percent != null && sec.lp_locked_percent < 10) reasons.push('Unverified contract with essentially unlocked liquidity.');
  return reasons;
};

// ── Confidence in the analysis itself (data coverage, not token quality). ──
export const confidenceScore = (i: ScoringInput, hasDexData: boolean): { score: number; note: string } => {
  let c = 50;
  const missing: string[] = [];
  if (hasDexData) c += 15;
  else {
    c -= 20;
    missing.push('DEX data');
  }
  if (i.security.checked) c += 15;
  else {
    c -= 5;
    missing.push('contract risk data');
  }
  if (i.security.holder_count != null || i.security.top10_percent != null) c += 10;
  else missing.push('holder data');
  const hasMarket = Object.values(i.market).some((v) => v != null);
  if (hasMarket) c += 5;
  else missing.push('market regime data');
  if ((i.liquidity_usd ?? 0) >= 50_000) c += 5;
  if ((i.liquidity_usd ?? 0) < 10_000) c -= 10;
  if (i.age_days != null && i.age_days < 7) c -= 10;
  if (i.input_type === 'address') c += 5;
  const score = clamp(c, 5, 95);
  const level = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
  const note = missing.length
    ? `Analysis confidence is ${level} because ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} limited or unavailable.`
    : `Analysis confidence is ${level} — all data sources responded for this token.`;
  return { score, note };
};

export const ratingFor = (opportunity: number, severe: string[]): Rating => {
  if (severe.length) return 'High Risk / Avoid for Now';
  if (opportunity >= 80) return 'Strong Opportunity';
  if (opportunity >= 65) return 'Good Watchlist Candidate';
  if (opportunity >= 50) return 'Neutral / Wait for Confirmation';
  if (opportunity >= 35) return 'Weak Setup';
  return 'High Risk / Avoid for Now';
};

export const actionFor = (rating: Rating): string =>
  rating === 'Strong Opportunity' ? 'Strong setup, but manage risk'
  : rating === 'Good Watchlist Candidate' ? 'Watch closely'
  : rating === 'Neutral / Wait for Confirmation' ? 'Wait for confirmation'
  : rating === 'Weak Setup' ? 'Avoid for now'
  : 'High risk';

/** Compute every score. Composite weights per the module spec, reweighted over available components. */
export const computeScores = (i: ScoringInput, hasDexData: boolean): { scores: Scores; rating: Rating; severe: string[]; confidence_note: string } => {
  const liquidity = liquidityScore(i.liquidity_usd, i.volume_24h);
  const momentum = momentumScore(i);
  const holder_health = holderHealthScore(i.security);
  const contract_safety = contractSafetyScore(i.security);
  const timing = timingScore(i.market);
  const strength = marketStrengthScore(i);

  const parts: { v: number | null; w: number }[] = [
    { v: liquidity, w: 0.2 },
    { v: momentum, w: 0.2 },
    { v: holder_health, w: 0.15 },
    { v: strength, w: 0.15 },
    { v: timing, w: 0.15 },
    { v: contract_safety, w: 0.15 }
  ];
  const avail = parts.filter((p) => p.v != null) as { v: number; w: number }[];
  const wsum = avail.reduce((s, p) => s + p.w, 0) || 1;
  const opportunity = clamp(avail.reduce((s, p) => s + p.v * p.w, 0) / wsum);

  const risk = riskScore(i);
  const severe = severeRiskReasons(i);
  const { score: confidence, note: confidence_note } = confidenceScore(i, hasDexData);
  const rating = ratingFor(opportunity, severe);

  return { scores: { opportunity, risk, momentum, liquidity, holder_health, contract_safety, timing, confidence }, rating, severe, confidence_note };
};
