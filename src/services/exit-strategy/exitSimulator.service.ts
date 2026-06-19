import { computeExitStrategy } from './exitStrategy.service';
import { getProfile, type ExitProfile, type LadderStep, type RiskZone } from './exitStrategySettings.service';

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio Exit Simulator — converts the current (or a custom) Exit Risk Score
// + a strategy profile into a risk-based scale-out *simulation* for a user's own
// portfolio size. This is NOT financial advice and never says "sell". It only
// shows possible scale-out ranges based on the configured exit ladder.
// ─────────────────────────────────────────────────────────────────────────────

export type SimulationMode = 'total_portfolio' | 'profit_only' | 'recover_capital' | 'moonbag';
export type PortfolioType = 'btc' | 'altcoin' | 'mixed' | 'custom';

export const SIM_DISCLAIMER =
  'This simulator is not financial advice. It does not know your full financial situation, tax obligations, goals, or risk tolerance. It only shows a risk-based scenario based on Pastatrade indicators. Always do your own research.';

export interface SimulateInput {
  portfolio_value: number;
  original_capital?: number | null;
  portfolio_type?: PortfolioType;
  strategy_profile?: string;
  simulation_mode?: SimulationMode;
  moonbag_percent?: number | null;
  custom_risk_score?: number | null;
}

interface Range {
  min: number;
  max: number;
}
export interface SimulationResult {
  current_exit_risk_score: number;
  exit_risk_percent: number;
  signal: string;
  current_action: string | null;
  confidence: string | null;
  used_custom_risk: boolean;
  strategy_profile: string;
  portfolio_type: PortfolioType;
  simulation_mode: SimulationMode;
  portfolio_value: number;
  original_capital: number | null;
  suggested_exit: { min_percent: number; max_percent: number };
  suggested_exit_amount: Range;
  remaining_position: Range;
  profit_info: {
    profit: number;
    profit_percentage: number | null;
    profit_exit_min: number;
    profit_exit_max: number;
    profit_remaining_min: number;
    profit_remaining_max: number;
  } | null;
  recover_capital: { amount_to_recover: number; percent_of_portfolio: number; remaining_moonbag: number } | null;
  moonbag: { moonbag_percent: number; moonbag_amount: number; max_removable: number } | null;
  next_threshold: { score: number; label: string } | null;
  what_would_change: string[];
  scenario_table: {
    risk: number;
    signal: string;
    exit_min_percent: number;
    exit_max_percent: number;
    exit_min_amount: number;
    exit_max_amount: number;
    remaining_min: number;
    remaining_max: number;
  }[];
  interpretation: string;
  disclaimer: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

// Parse an exit-ladder percentage string ("5–15%", "20-30%", "5%", "") → range.
export const parsePct = (pct: string | null | undefined): Range | null => {
  const nums = (pct ?? '').match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const a = parseFloat(nums[0]);
  const b = nums[1] != null ? parseFloat(nums[1]) : a;
  return { min: Math.min(a, b), max: Math.max(a, b) };
};

const zoneFor = (zones: RiskZone[], score: number): RiskZone | null => zones.find((z) => score >= z.min && score < z.max) ?? zones[zones.length - 1] ?? null;

// Highest ladder step whose threshold has been reached at `score`.
const reachedStep = (ladder: LadderStep[], score: number): LadderStep | null => {
  const sorted = [...ladder].sort((a, b) => a.risk - b.risk);
  let cur: LadderStep | null = null;
  for (const s of sorted) if (score >= s.risk) cur = s;
  return cur;
};

const nextThreshold = (ladder: LadderStep[], score: number): { score: number; label: string } | null => {
  const next = [...ladder].sort((a, b) => a.risk - b.risk).find((s) => s.risk > score);
  return next ? { score: next.risk, label: next.label } : null;
};

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

interface SimContext {
  current_action: string | null;
  confidence: string | null;
  reason: string | null;
  next_threshold: { score: number; label: string } | null;
  what_would_change: string[];
  used_custom_risk: boolean;
}

// Pure simulation builder — no I/O. Given a resolved profile + score + context.
export const buildSimulation = (profile: ExitProfile, score: number, label: string, ctx: SimContext, input: SimulateInput): SimulationResult => {
  const portfolio = Math.max(0, Number(input.portfolio_value) || 0);
  const original = input.original_capital != null ? Math.max(0, Number(input.original_capital)) : null;
  const profit = original != null ? portfolio - original : null;
  const mode: SimulationMode = input.simulation_mode ?? 'total_portfolio';
  const mbPct = clamp(Number(input.moonbag_percent ?? 0), 0, 100);

  const step = reachedStep(profile.ladder, score);
  const pr = parsePct(step?.pct) ?? { min: 0, max: 0 };

  let moonbag: SimulationResult['moonbag'] = null;
  let recover: SimulationResult['recover_capital'] = null;

  let suggested = { min_percent: pr.min, max_percent: pr.max };
  let exitMin: number;
  let exitMax: number;
  let remMin: number;
  let remMax: number;

  if (mode === 'recover_capital') {
    const amount = original != null ? Math.min(original, portfolio) : 0;
    const percent = portfolio > 0 ? (amount / portfolio) * 100 : 0;
    recover = { amount_to_recover: round2(amount), percent_of_portfolio: round2(percent), remaining_moonbag: round2(Math.max(0, portfolio - amount)) };
    suggested = { min_percent: round2(percent), max_percent: round2(percent) };
    exitMin = exitMax = round2(amount);
    remMin = remMax = round2(Math.max(0, portfolio - amount));
  } else {
    let base = portfolio;
    if (mode === 'profit_only') base = Math.max(0, profit ?? 0);
    else if (mode === 'moonbag') {
      const moonbag_amount = (portfolio * mbPct) / 100;
      const max_removable = Math.max(0, portfolio - moonbag_amount);
      moonbag = { moonbag_percent: mbPct, moonbag_amount: round2(moonbag_amount), max_removable: round2(max_removable) };
      base = max_removable;
    }
    exitMin = (base * pr.min) / 100;
    exitMax = (base * pr.max) / 100;
    if (mode === 'moonbag' && moonbag) {
      exitMin = Math.min(exitMin, moonbag.max_removable);
      exitMax = Math.min(exitMax, moonbag.max_removable);
    }
    remMin = Math.max(0, portfolio - exitMax); // larger exit → smaller remaining
    remMax = Math.max(0, portfolio - exitMin);
    exitMin = round2(exitMin);
    exitMax = round2(exitMax);
    remMin = round2(remMin);
    remMax = round2(remMax);
  }

  // Profit info (independent of mode, shown when original capital is known).
  let profit_info: SimulationResult['profit_info'] = null;
  if (profit != null) {
    const p = Math.max(0, profit);
    const pexMin = round2((p * pr.min) / 100);
    const pexMax = round2((p * pr.max) / 100);
    profit_info = {
      profit: round2(profit),
      profit_percentage: original && original > 0 ? round2((profit / original) * 100) : null,
      profit_exit_min: pexMin,
      profit_exit_max: pexMax,
      profit_remaining_min: round2(Math.max(0, p - pexMax)),
      profit_remaining_max: round2(Math.max(0, p - pexMin))
    };
  }

  // Recover-capital info shown even outside that mode when in profit.
  if (recover == null && original != null && portfolio > original) {
    recover = { amount_to_recover: round2(original), percent_of_portfolio: round2((original / portfolio) * 100), remaining_moonbag: round2(portfolio - original) };
  }

  // Scenario table — total-portfolio scale-out across the ladder steps.
  const scenario_table = [...profile.ladder]
    .sort((a, b) => a.risk - b.risk)
    .map((s) => {
      const p = parsePct(s.pct) ?? { min: 0, max: 0 };
      const eMin = round2((portfolio * p.min) / 100);
      const eMax = round2((portfolio * p.max) / 100);
      return {
        risk: s.risk,
        signal: s.label,
        exit_min_percent: p.min,
        exit_max_percent: p.max,
        exit_min_amount: eMin,
        exit_max_amount: eMax,
        remaining_min: round2(Math.max(0, portfolio - eMax)),
        remaining_max: round2(Math.max(0, portfolio - eMin))
      };
    });

  return {
    current_exit_risk_score: Number(score.toFixed(3)),
    exit_risk_percent: Math.round(score * 100),
    signal: label,
    current_action: ctx.current_action,
    confidence: ctx.confidence,
    used_custom_risk: ctx.used_custom_risk,
    strategy_profile: profile.profile_name,
    portfolio_type: input.portfolio_type ?? 'mixed',
    simulation_mode: mode,
    portfolio_value: round2(portfolio),
    original_capital: original == null ? null : round2(original),
    suggested_exit: suggested,
    suggested_exit_amount: { min: exitMin, max: exitMax },
    remaining_position: { min: remMin, max: remMax },
    profit_info,
    recover_capital: recover,
    moonbag,
    next_threshold: ctx.next_threshold,
    what_would_change: ctx.what_would_change.slice(0, 4),
    scenario_table,
    interpretation: buildInterpretation(score, label, portfolio, profile, pr, mode, ctx, recover),
    disclaimer: SIM_DISCLAIMER
  };
};

const buildInterpretation = (
  score: number,
  label: string,
  portfolio: number,
  profile: ExitProfile,
  pr: Range,
  mode: SimulationMode,
  ctx: SimContext,
  recover: SimulationResult['recover_capital']
): string => {
  if (mode === 'recover_capital') {
    if (!recover || recover.amount_to_recover <= 0) return 'Add your original capital to simulate recovering your initial investment while keeping the rest as a long-term position.';
    return `To simulate recovering your initial capital you would scale out ${usd(recover.amount_to_recover)} (${recover.percent_of_portfolio}% of the portfolio), leaving a remaining position of ${usd(recover.remaining_moonbag)}. ${ctx.reason ?? ''}`.trim();
  }
  if (pr.max <= 0) {
    return `Exit Risk is ${score.toFixed(2)} (${label}). ${ctx.reason ?? ''} The model does not currently support major scale-out simulation — no profit-taking range is suggested yet.`.trim();
  }
  const rangeTxt = pr.min === pr.max ? `${pr.max}%` : `${pr.min}–${pr.max}%`;
  return `Based on your ${usd(portfolio)} portfolio and ${profile.profile_name} profile, the model shows a simulated scale-out range of ${rangeTxt}. ${ctx.reason ?? ''}`.trim();
};

// Resolve the profile + current/custom Exit Risk Score, then build the simulation.
export const runSimulation = async (input: SimulateInput): Promise<SimulationResult> => {
  const profile = await getProfile(input.strategy_profile);

  if (input.custom_risk_score != null) {
    const score = clamp01(Number(input.custom_risk_score));
    const zone = zoneFor(profile.risk_zones, score);
    const label = zone?.label ?? 'Hold';
    const ctx: SimContext = {
      current_action: null,
      confidence: null,
      reason: `Simulated at a custom Exit Risk Score of ${score.toFixed(2)} (${label}).`,
      next_threshold: nextThreshold(profile.ladder, score),
      what_would_change: ['A higher Exit Risk Score moves you into a larger scale-out band', 'BTC risk, on-chain risk and Social Risk rising together', 'Altcoin breadth broadening', 'BTC moving toward upper cycle / risk bands'],
      used_custom_risk: true
    };
    return buildSimulation(profile, score, label, ctx, input);
  }

  const exit = await computeExitStrategy(profile.profile_name);
  const ctx: SimContext = {
    current_action: exit.current_action.action,
    confidence: exit.confidence,
    reason: exit.current_action.reason,
    next_threshold: exit.next_threshold ? { score: exit.next_threshold.score, label: exit.next_threshold.label } : null,
    what_would_change: exit.signal_changes.upgrade,
    used_custom_risk: false
  };
  return buildSimulation(profile, exit.exit_risk_score, exit.strategy_label, ctx, input);
};

// Compact, non-private example for premium reports ($10k generic portfolio).
export interface SimExample {
  portfolio: number;
  profile: string;
  exit_min_percent: number;
  exit_max_percent: number;
  exit_min_amount: number;
  exit_max_amount: number;
  remaining_min: number;
  remaining_max: number;
  label: string;
}
export const buildSimExample = (profile: ExitProfile, score: number, label: string): SimExample => {
  const portfolio = 10000;
  const sim = buildSimulation(profile, score, label, { current_action: null, confidence: null, reason: null, next_threshold: null, what_would_change: [], used_custom_risk: false }, { portfolio_value: portfolio, simulation_mode: 'total_portfolio' });
  return {
    portfolio,
    profile: profile.profile_name,
    exit_min_percent: sim.suggested_exit.min_percent,
    exit_max_percent: sim.suggested_exit.max_percent,
    exit_min_amount: sim.suggested_exit_amount.min,
    exit_max_amount: sim.suggested_exit_amount.max,
    remaining_min: sim.remaining_position.min,
    remaining_max: sim.remaining_position.max,
    label
  };
};
