import { supabase } from '../../config/supabase';
import { AppError } from '../../utils/api-response';
import { readSeries } from '../series/store';
import { computeCycleRisk } from '../btc-cycle/cycle-risk';
import { computeAltcoinSeason } from '../altcoin-btc/altcoin-season.service';
import { readLatestSocialRisk, type SocialLatest } from '../social/social-latest.service';
import { getLatestLogRegression } from '../log-regression/logRegression.service';
import { getDerivativesForExit } from '../derivatives/derivatives.service';
import { getProfile, type ExitProfile, type LadderStep, type RiskZone } from './exitStrategySettings.service';

// ─────────────────────────────────────────────────────────────────────────────
// exitStrategy.service — combines BTC risk, on-chain, social, altcoin breadth and
// cycle extension into a single Exit Risk Score (0–1), then maps it to a strategy
// zone + a configurable exit ladder. Probability-style; never an instruction.
//
// Social Risk is pulled live from the Social Metrics module (btc_social_metrics)
// via readLatestSocialRisk — preferred stored social_risk_score, computed
// fallback. Weights are reweighted proportionally over whatever is available.
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export interface ExitCategory {
  key: 'btc' | 'onchain' | 'social' | 'altcoin' | 'cycle';
  label: string;
  score: number | null;
  weight: number; // configured weight
  active_weight: number; // effective weight after reweighting (0 if unavailable)
  available: boolean;
  meaning: string;
}
export interface ExitLadderRow extends LadderStep {
  reached: boolean;
  current: boolean;
}
export interface ExitSocialDetail {
  status: SocialLatest['status'];
  label: string;
  sources_active: string[];
  sources_missing: string[];
  last_synced: string | null;
  detail: SocialLatest['detail'];
  meaning: string;
  interpretation: string;
}
export interface ExitStrategyResult {
  as_of: string | null;
  btc_price: number | null;
  profile: string;
  exit_risk_score: number;
  exit_risk_percent: number;
  strategy_label: string;
  zone: RiskZone | null;
  suggested_action: string;
  exposure_guidance: string;
  current_action: { action: string; reason: string };
  next_threshold: { score: number; label: string; meaning: string } | null;
  confidence: 'High' | 'Medium' | 'Low';
  confidence_reason: string;
  categories: ExitCategory[];
  active_weights: Record<string, number>;
  social: ExitSocialDetail;
  coverage_note: string;
  interpretation: string;
  confirmation_needed: string[];
  risk_warnings: string[];
  conflicts: string[];
  signal_changes: { upgrade: string[]; weaken: string[] };
  ladder: ExitLadderRow[];
  show_percentages: boolean;
  disclaimer: string;
}

const band = (s: number | null) => (s == null ? 'na' : s < 0.4 ? 'low' : s < 0.6 ? 'moderate' : s < 0.8 ? 'elevated' : 'high');

// Social Risk zones (0–1) per the Social Metrics definition.
const socialZoneMeaning = (s: number | null): string => {
  if (s == null) return 'Social data unavailable — Exit Risk is calculated from active categories only.';
  if (s < 0.2) return 'Crowd attention is very low. Social data does not support major exit pressure.';
  if (s < 0.4) return 'Retail attention remains calm. Exit pressure from social hype is low.';
  if (s < 0.6) return 'Crowd attention is present but not extreme.';
  if (s < 0.8) return 'Retail interest is rising. Exit pressure increases if BTC/on-chain risk also rises.';
  return 'Crowd attention is high. If price and on-chain risk are also elevated, distribution risk increases strongly.';
};

const meaningFor = (key: ExitCategory['key'], s: number | null): string => {
  const b = band(s);
  switch (key) {
    case 'btc':
      return b === 'na' ? 'BTC risk data unavailable.' : `BTC is ${b}-risk.`;
    case 'onchain':
      return b === 'na' ? 'On-chain data unavailable.' : b === 'low' || b === 'moderate' ? 'Holder / miner / on-chain conditions are calm.' : b === 'elevated' ? 'On-chain conditions are heating up.' : 'On-chain conditions look euphoric / stressed.';
    case 'social':
      return socialZoneMeaning(s);
    case 'altcoin':
      return b === 'na' ? 'Altcoin breadth unavailable.' : b === 'low' || b === 'moderate' ? 'Altcoin speculation is weak/selective.' : b === 'elevated' ? 'Altcoin speculation is broadening.' : 'Altcoin speculation is broad.';
    case 'cycle':
      return b === 'na' ? 'Cycle data unavailable.' : b === 'low' || b === 'moderate' ? 'BTC is below historical cycle-extension zones.' : b === 'elevated' ? 'BTC is approaching cycle-extension zones.' : 'BTC is in historical cycle-extension territory.';
  }
};

const zoneFor = (zones: RiskZone[], score: number): RiskZone | null => zones.find((z) => score >= z.min && score < z.max) ?? zones[zones.length - 1] ?? null;

const ACTION: Record<string, string> = {
  Accumulation: 'Risk is low. The model does not support exit behaviour yet — this zone favours disciplined accumulation.',
  Hold: 'Risk is moderate. Continue monitoring; there is no strong exit pressure yet.',
  'Reduce DCA': 'Risk is rising. Avoid aggressive new buying and watch for overheating signals.',
  'Light profit-taking': 'Risk is elevated but not extreme. Avoid aggressive new buying. Small partial profit-taking may be reasonable if already in profit, while waiting for broader confirmation before major exits.',
  'Scale-out zone': 'Risk is high. Gradual profit-taking becomes more important than new buying.',
  'Major distribution': 'Multiple risk categories are elevated. Aggressive new buying is unfavourable; gradual distribution may be more appropriate.',
  'Extreme exit risk': 'The model shows highly elevated risk. Historically this is not a favourable zone for aggressive exposure.'
};

const buildLadder = (ladder: LadderStep[], score: number): ExitLadderRow[] => {
  const sorted = [...ladder].sort((a, b) => a.risk - b.risk);
  // "current" = the highest step whose threshold has been reached.
  let currentIdx = -1;
  sorted.forEach((s, i) => {
    if (score >= s.risk) currentIdx = i;
  });
  return sorted.map((s, i) => ({ ...s, reached: score >= s.risk, current: i === currentIdx }));
};

const nextThreshold = (ladder: LadderStep[], score: number): { risk: number; label: string } | null => {
  const next = [...ladder].sort((a, b) => a.risk - b.risk).find((s) => s.risk > score);
  return next ? { risk: next.risk, label: next.label } : null;
};

const readRiskLatest = async () => {
  const { data: latest } = await supabase.from('risk_summary_daily').select('snapshot_date, summary_risk').order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
  if (!latest?.snapshot_date) return null;
  const { data: cats } = await supabase.from('risk_category_daily').select('category, risk').eq('snapshot_date', latest.snapshot_date as string);
  const byCat = Object.fromEntries((cats ?? []).map((c) => [c.category, c.risk]));
  return {
    date: latest.snapshot_date as string,
    btc: latest.summary_risk == null ? null : Number(latest.summary_risk),
    onchain: byCat.onchain == null ? null : Number(byCat.onchain)
  };
};

// Small comparison helpers that treat null as "not satisfied".
const ge = (x: number | null, t: number) => x != null && x >= t;
const lt = (x: number | null, t: number) => x != null && x < t;

export const computeExitStrategy = async (profileName?: string): Promise<ExitStrategyResult> => {
  const profile: ExitProfile = await getProfile(profileName);
  const risk = await readRiskLatest();
  if (!risk || risk.btc == null) throw new AppError('Risk data is not available yet. Run a risk sync first.', 503);

  // Social Risk — live from the Social Metrics module.
  const socialLatest = await readLatestSocialRisk();

  let altcoin: number | null = null;
  try {
    const s = await computeAltcoinSeason('30d', 'premium_clean');
    altcoin = clamp01(s.altcoin_season_index / 100);
  } catch {
    /* altcoin breadth optional */
  }

  let cycle: number | null = null;
  let btcPrice: number | null = null;
  try {
    const series = await readSeries('btc-full');
    if (series.length > 250) {
      const c = computeCycleRisk(series);
      cycle = clamp01(c.risk_score / 100);
      btcPrice = c.btc_price;
    }
  } catch {
    /* cycle optional */
  }
  // Blend the long-term log-regression position (vs bubble bands) into the
  // cycle-extension category. Graceful — only when regression data is available.
  try {
    const lr = await getLatestLogRegression('BTC');
    if (lr) cycle = cycle == null ? lr.risk_score : clamp01((cycle + lr.risk_score) / 2);
  } catch {
    /* log-regression optional */
  }
  // Derivatives / leverage — read once (also drives the confluence overlay below).
  const deriv = await getDerivativesForExit();
  // Nudge cycle-extension risk by current leverage (funding/positioning). Graceful.
  if (deriv?.leverage_risk != null) cycle = cycle == null ? deriv.leverage_risk : clamp01(cycle * 0.7 + deriv.leverage_risk * 0.3);

  const social = socialLatest.score;
  const w = profile.weights;
  const categories: ExitCategory[] = [
    { key: 'btc', label: 'BTC Risk', score: risk.btc, weight: w.btc, active_weight: 0, available: risk.btc != null, meaning: meaningFor('btc', risk.btc) },
    { key: 'onchain', label: 'On-chain Risk', score: risk.onchain, weight: w.onchain, active_weight: 0, available: risk.onchain != null, meaning: meaningFor('onchain', risk.onchain) },
    { key: 'social', label: 'Social Risk', score: social, weight: w.social, active_weight: 0, available: social != null, meaning: meaningFor('social', social) },
    { key: 'altcoin', label: 'Altcoin Breadth Risk', score: altcoin, weight: w.altcoin, active_weight: 0, available: altcoin != null, meaning: meaningFor('altcoin', altcoin) },
    { key: 'cycle', label: 'Cycle Extension Risk', score: cycle, weight: w.cycle, active_weight: 0, available: cycle != null, meaning: meaningFor('cycle', cycle) }
  ];

  const avail = categories.filter((c) => c.available && c.score != null);
  const wsum = avail.reduce((s, c) => s + c.weight, 0) || 1;
  // Effective (reweighted) weights, shown in the UI so users see how the score was built.
  const active_weights: Record<string, number> = {};
  for (const c of categories) {
    c.active_weight = c.available && c.score != null ? Number((c.weight / wsum).toFixed(3)) : 0;
    active_weights[c.key] = c.active_weight;
  }
  const baseScore = clamp01(avail.reduce((s, c) => s + c.weight * (c.score as number), 0) / wsum);

  // ── Leverage confluence overlay ──
  // Derivatives feed Exit Strategy more directly than Social Risk: when leverage
  // is building (high funding / rising open interest / one-sided positioning)
  // AND price or crowd risk corroborates, exit pressure increases. Bounded to
  // +0.08 so it can sharpen — never dominate — and silent in calm markets.
  let leverageBump = 0;
  let leverage_note: string | null = null;
  if (deriv?.leverage_risk != null) {
    const levConds = [deriv.funding_high, deriv.oi_rising, deriv.ls_extreme, deriv.leverage_risk >= 0.6].filter(Boolean).length;
    const btcRising = ge(risk.btc, 0.6);
    const socialElevated = ge(social, 0.6);
    if (levConds >= 2 && (btcRising || socialElevated)) {
      leverageBump = Math.min(0.08, 0.02 * levConds + (btcRising ? 0.02 : 0) + (socialElevated ? 0.02 : 0));
      const drivers = [deriv.funding_high && 'high funding', deriv.oi_rising && 'rising open interest', deriv.ls_extreme && 'one-sided positioning'].filter(Boolean).join(', ');
      leverage_note = `Leverage is building (${drivers || 'elevated leverage'}) while ${btcRising ? 'BTC risk' : 'crowd attention'} is elevated — exit pressure raised by +${Math.round(leverageBump * 100)}.`;
    }
  }
  const score = clamp01(baseScore + leverageBump);
  const pct = Math.round(score * 100);

  const zone = zoneFor(profile.risk_zones, score);
  const label = zone?.label ?? 'Hold';
  const suggested_action = ACTION[label] ?? zone?.meaning ?? '';
  const ladder = buildLadder(profile.ladder, score);
  const currentStep = ladder.find((s) => s.current) ?? null;
  const exposure_guidance = currentStep
    ? `${currentStep.action}${profile.show_percentages && currentStep.pct ? ` (${currentStep.pct})` : ''}.`
    : 'No exit action yet — accumulation/hold conditions.';

  const nt = nextThreshold(profile.ladder, score);
  const next_threshold = nt
    ? { score: nt.risk, label: nt.label, meaning: `If Exit Risk rises above ${nt.risk.toFixed(2)}, the model moves from "${label}" toward "${nt.label}" — a more cautious posture.` }
    : null;

  // Category shorthands.
  const btc = risk.btc;
  const oc = risk.onchain;
  const so = social;
  const alt = altcoin;
  const fg = socialLatest.detail.fear_greed; // 0–100
  const trends = socialLatest.detail.trends_bitcoin; // 0–100
  const yt = socialLatest.detail.youtube_attention; // 0–1
  const socialAvail = so != null;
  const onchainAvail = oc != null;

  // ── Confidence ──
  const scores = avail.map((c) => c.score as number);
  const n = avail.length;
  const elevated = scores.filter((s) => s >= 0.6).length;
  const calm = scores.filter((s) => s < 0.4).length;
  const strongAgree = n > 0 && (elevated >= Math.ceil(n * 0.6) || calm >= Math.ceil(n * 0.6));
  const strongConflict = elevated >= 2 && calm >= 2;
  let confidence: ExitStrategyResult['confidence'];
  if (n >= 5 && strongAgree) confidence = 'High';
  else if (n < 3 || (!socialAvail && !onchainAvail) || strongConflict) confidence = 'Low';
  else confidence = 'Medium';
  // Social missing reduces confidence one level unless the rest strongly agree.
  let socialDowngrade = false;
  if (!socialAvail && !strongAgree && confidence !== 'Low') {
    confidence = confidence === 'High' ? 'Medium' : 'Low';
    socialDowngrade = true;
  }
  const confidence_reason = socialDowngrade
    ? 'Social Risk is unavailable, so confidence is reduced by one level.'
    : confidence === 'High'
      ? 'BTC, on-chain, social, altcoin breadth and cycle are all active and most categories agree.'
      : confidence === 'Low'
        ? n < 3
          ? 'Several categories are unavailable, so the read is lower-confidence.'
          : strongConflict
            ? 'Categories strongly conflict, so the read is lower-confidence.'
            : 'On-chain and social coverage is weak, so the read is lower-confidence.'
        : 'Some categories agree, but coverage or agreement is not complete — the signal is mixed.';

  // ── Conflict detection (incl. Social Risk) ──
  const conflicts: string[] = [];
  if (ge(btc, 0.65) && lt(so, 0.4)) conflicts.push('Price risk is elevated, but retail hype is not extreme. Exit pressure is rising but not fully confirmed.');
  if (ge(btc, 0.4) && lt(btc, 0.65) && ge(so, 0.6)) conflicts.push('Crowd attention is rising early, but price risk has not fully confirmed distribution risk.');
  if (ge(oc, 0.6) && ge(so, 0.6)) conflicts.push('On-chain and crowd behaviour are both elevated. Distribution risk is increasing.');
  if (ge(alt, 0.65) && ge(so, 0.6)) conflicts.push('Altcoin speculation and crowd attention are both elevated. This increases exit pressure.');
  if (lt(so, 0.4) && lt(btc, 0.4) && lt(oc, 0.4)) conflicts.push('The market is not crowded. Exit pressure is limited.');
  if ([btc, oc, so, alt].every((x) => ge(x, 0.6))) conflicts.push('Multiple risk categories are elevated together. Scale-out pressure is high.');
  if (leverage_note) conflicts.push(leverage_note);

  // ── Confirmation needed for bigger exits ──
  const confirmation_needed: string[] = [];
  if (lt(btc, 0.75)) confirmation_needed.push('BTC Risk rises above 0.75');
  if (lt(oc, 0.6)) confirmation_needed.push('On-chain Risk moves into the elevated zone');
  if (socialAvail && lt(so, 0.6)) confirmation_needed.push('Social Risk rises above 0.60');
  if (fg != null && fg < 75) confirmation_needed.push('Fear & Greed enters Greed / Extreme Greed');
  if (trends != null && trends < 75) confirmation_needed.push('Google Trends Bitcoin search interest spikes');
  if (yt != null && yt < 0.7) confirmation_needed.push('YouTube attention rises sharply');
  if (lt(alt, 0.75)) confirmation_needed.push('Altcoin breadth / season quality becomes broad');
  if (lt(cycle, 0.75)) confirmation_needed.push('BTC moves above its upper cycle / risk bands');
  if (!confirmation_needed.length) confirmation_needed.push('Most categories are already elevated — watch for sustained confirmation.');

  // ── Risk warnings ──
  const risk_warnings: string[] = [];
  if (!socialAvail) risk_warnings.push('Social Risk is unavailable, so exit confidence is reduced.');
  if (ge(so, 0.6) && ge(alt, 0.6)) risk_warnings.push('Social Risk is rising while altcoin breadth is expanding.');
  if (fg != null && fg >= 75) risk_warnings.push('Fear & Greed is entering extreme greed.');
  if ((trends != null && trends >= 75) || (yt != null && yt >= 0.7)) risk_warnings.push('Google Trends or YouTube attention is spiking.');
  if (ge(so, 0.6) && lt(oc, 0.6)) risk_warnings.push('Crowd attention is elevated before on-chain risk confirms.');
  if (lt(btc, 0.6)) risk_warnings.push('BTC risk is below 0.60 — exit pressure is limited.');
  if (lt(alt, 0.4)) risk_warnings.push('Altcoin breadth is weak — speculation is not broad.');
  risk_warnings.push('Major exits require several categories to align: high BTC risk, elevated on-chain risk, high Social Risk, broad altcoin speculation, and cycle extension.');

  // ── What would change the signal? ──
  const upgrade: string[] = [];
  if (next_threshold) upgrade.push(`Exit Risk rises above the next threshold (${next_threshold.score.toFixed(2)} — ${next_threshold.label})`);
  if (lt(btc, 0.6)) upgrade.push('BTC Risk rises above 0.60');
  if (socialAvail) {
    if (lt(so, 0.6)) upgrade.push('Social Risk rises above 0.60 (Fear & Greed, Trends, YouTube heat up)');
  } else {
    upgrade.push('Social Risk data becomes available and confirms rising crowd attention');
  }
  if (lt(oc, 0.6)) upgrade.push('On-chain Risk moves into the elevated zone');
  upgrade.push(ge(alt, 0.5) ? 'Altcoin breadth / Altcoin Season Quality stays high' : 'Altcoin breadth broadens across the market');
  if (lt(cycle, 0.75)) upgrade.push('BTC moves closer to its upper cycle / risk bands');

  const weaken: string[] = [];
  weaken.push('Exit Risk falls back below the current zone');
  if (alt != null) weaken.push('Altcoin breadth weakens');
  weaken.push(socialAvail ? 'Social attention stays quiet' : 'Social attention remains subdued');
  weaken.push('On-chain metrics remain calm');
  weaken.push('BTC fails to build further cycle strength');

  // ── Current action ──
  const current_action = buildCurrentAction(score, { btc, oc, so, alt, socialAvail });

  // ── Coverage ──
  const activeLabels = avail.map((c) => c.label.replace(' Risk', '').replace(' Breadth', ' breadth'));
  const missing = categories.filter((c) => !c.available).map((c) => c.label);
  const coverage_note = `Exit Risk uses active categories: ${activeLabels.join(', ')}.${missing.length ? ` ${missing.join(', ')} unavailable — calculated from active sources only.` : ''}`;

  // ── Interpretation ──
  const interpretation =
    score < 0.5
      ? `Exit Risk is ${pct}/100 (${label}). The market is not in deep distribution — risk is ${score < 0.3 ? 'low and accumulation-friendly' : 'moderate'}. ${conflicts[0] ?? 'No strong exit pressure yet.'}`
      : score < 0.75
        ? `Exit Risk is ${pct}/100 (${label}). The market is no longer in deep accumulation but not yet in full distribution. Risk is rising, so aggressive DCA should be reduced; partial profit-taking may be reasonable for users already in profit, but the model does not yet show extreme exit risk.`
        : `Exit Risk is ${pct}/100 (${label}). Multiple categories are elevated — gradual distribution becomes more important than new buying. ${conflicts[conflicts.length - 1] ?? 'Risk is high across categories.'}`;

  const socialDetail: ExitSocialDetail = {
    status: socialLatest.status,
    label: socialLatest.label,
    sources_active: socialLatest.sources_active,
    sources_missing: socialLatest.sources_missing,
    last_synced: socialLatest.as_of,
    detail: socialLatest.detail,
    meaning: socialZoneMeaning(so),
    interpretation: socialLatest.interpretation
  };

  return {
    as_of: risk.date,
    btc_price: btcPrice,
    profile: profile.profile_name,
    exit_risk_score: Number(score.toFixed(3)),
    exit_risk_percent: pct,
    strategy_label: label,
    zone,
    suggested_action,
    exposure_guidance,
    current_action,
    next_threshold,
    confidence,
    confidence_reason,
    categories,
    active_weights,
    social: socialDetail,
    coverage_note,
    interpretation,
    confirmation_needed,
    risk_warnings,
    conflicts,
    signal_changes: { upgrade, weaken },
    ladder,
    show_percentages: profile.show_percentages,
    disclaimer: profile.disclaimer
  };
};

// Plain-language "what should I do right now" summary, derived from the score
// band plus the live category states. Probability-style — never an instruction.
const buildCurrentAction = (score: number, c: { btc: number | null; oc: number | null; so: number | null; alt: number | null; socialAvail: boolean }): { action: string; reason: string } => {
  const socialPhrase = !c.socialAvail
    ? 'Social Risk is unavailable for this read'
    : lt(c.so, 0.4)
      ? 'Social Risk is quiet, meaning the crowd is not euphoric'
      : lt(c.so, 0.6)
        ? 'Social Risk is at normal levels'
        : lt(c.so, 0.8)
          ? 'Social Risk is elevated'
          : 'Social Risk is in hype territory';
  const altPhrase = c.alt == null ? 'altcoin breadth is unavailable' : lt(c.alt, 0.4) ? 'altcoin breadth is weak' : lt(c.alt, 0.65) ? 'altcoin breadth is rising but not broad enough to confirm distribution risk' : lt(c.alt, 0.8) ? 'altcoin breadth is broadening' : 'altcoin breadth is broad';
  const priceCalm = lt(c.btc, 0.6) && (c.oc == null || lt(c.oc, 0.6));

  if (score < 0.5) {
    return {
      action: 'No major exit pressure yet.',
      reason: `${priceCalm ? 'BTC and on-chain risk remain low' : 'Risk is building but still moderate'}, while ${altPhrase}. ${socialPhrase}. The model suggests holding and monitoring rather than major exits.`
    };
  }
  if (score < 0.65) {
    return {
      action: 'Reduce aggressive DCA.',
      reason: `Exit Risk is rising, but the model has not yet reached a major distribution zone — ${altPhrase}, and ${socialPhrase}. Watch BTC risk, Social Risk and on-chain risk for confirmation.`
    };
  }
  if (score < 0.75) {
    return {
      action: 'Consider light profit-taking.',
      reason: `Exit Risk is elevated. ${altPhrase}, and ${socialPhrase}. Small partial profit-taking may be reasonable if already in profit, while waiting for broader confirmation before larger exits.`
    };
  }
  if (score < 0.85) {
    return {
      action: 'Scale-out pressure is increasing.',
      reason: `BTC risk, on-chain risk and ${altPhrase}; ${socialPhrase}. With several categories elevated together, disciplined partial profit-taking may become more important.`
    };
  }
  return {
    action: 'Treat the market as high distribution risk.',
    reason: `Multiple risk categories are highly elevated and ${socialPhrase}. Historically this favours gradual distribution over new buying, not aggressive exposure.`
  };
};

/** Persist today's computed values (for history + reports). Best-effort. */
export const storeExitStrategyDaily = async (profileName?: string): Promise<number> => {
  const r = await computeExitStrategy(profileName);
  if (!r.as_of) return 0;
  const cat = (k: string) => r.categories.find((c) => c.key === k)?.score ?? null;

  // Log a transition event when the strategy label changes vs the latest snapshot.
  const { data: prev } = await supabase
    .from('exit_strategy_daily')
    .select('date, strategy_label, exit_risk_score')
    .lt('date', r.as_of)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prev && prev.strategy_label && prev.strategy_label !== r.strategy_label) {
    await supabase.from('exit_strategy_events').insert({
      date: r.as_of,
      event_type: 'label_change',
      old_label: prev.strategy_label,
      new_label: r.strategy_label,
      old_score: prev.exit_risk_score,
      new_score: r.exit_risk_score,
      message: `Exit strategy moved from "${prev.strategy_label}" to "${r.strategy_label}" (${r.exit_risk_percent}/100).`
    });
  }
  const { error } = await supabase.from('exit_strategy_daily').upsert(
    {
      date: r.as_of,
      btc_price: r.btc_price,
      exit_risk_score: r.exit_risk_score,
      exit_risk_percent: r.exit_risk_percent,
      strategy_label: r.strategy_label,
      suggested_action: r.suggested_action,
      confidence: r.confidence,
      btc_risk: cat('btc'),
      onchain_risk: cat('onchain'),
      social_risk: cat('social'),
      social_risk_status: r.social.status,
      social_risk_sources: { active: r.social.sources_active, missing: r.social.sources_missing },
      active_weights: r.active_weights,
      altcoin_breadth_risk: cat('altcoin'),
      cycle_extension_risk: cat('cycle'),
      category_breakdown: r.categories,
      coverage_status: r.coverage_note,
      interpretation: r.interpretation,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'date' }
  );
  if (error) throw new AppError('Failed to store exit strategy snapshot.', 500, [error]);
  return 1;
};
