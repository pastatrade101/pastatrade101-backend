// Turns raw Alt/BTC numbers into a premium, plain-language read: a verdict,
// a decision-grade "premium signal", trend state, what-this-means narrative,
// score breakdown, and confirmation/failure rules. All ranking-based intelligence
// — never a prediction.

export interface AnalysisInput {
  symbol: string;
  ratio: number;
  ma50: number | null;
  ma200: number | null;
  strength7: number | null; // % change of the ratio
  strength30: number | null;
  strength90: number | null;
  reactionScore: number;
  volumeBreakout: number | null;
}

export type ScoreState = 'Weak' | 'Neutral' | 'Improving' | 'Strong';

export interface Analysis {
  trend_state: string;
  premium_signal: string;
  verdict_label: string;
  verdict_summary: string;
  premium_note: string;
  what_this_means: string;
  confirmation_needed: string[];
  failure_warning: string[];
  reaction_breakdown: { label: string; state: ScoreState }[];
}

const pctState = (v: number | null): ScoreState =>
  v == null ? 'Neutral' : v < -5 ? 'Weak' : v < 5 ? 'Neutral' : v < 15 ? 'Improving' : 'Strong';

// Internal state machine that everything else maps from.
type State = 'avoid' | 'bleeding' | 'weakening' | 'early_recovery' | 'watch' | 'confirmed' | 'leader' | 'overextended';

const resolveState = (i: AnalysisInput): State => {
  const above50 = i.ma50 != null && i.ratio > i.ma50;
  const above200 = i.ma200 != null && i.ratio > i.ma200;
  const osc = i.strength30 ?? 0;
  const overheated = osc > 35 || (i.strength7 ?? 0) > 25;

  if (above200) {
    if (overheated) return 'overextended';
    if (osc > 0) return osc > 8 && (i.strength90 ?? 0) > 15 ? 'leader' : 'confirmed';
    return 'watch';
  }
  // below the 200-day MA
  if (osc < -15 && (i.strength90 ?? 0) < -25) return 'avoid';
  if (osc < -5) return 'bleeding';
  if (osc > 0) return 'early_recovery';
  return 'weakening';
};

const trendState = (i: AnalysisInput): string => {
  const above50 = i.ma50 != null && i.ratio > i.ma50;
  const above200 = i.ma200 != null && i.ratio > i.ma200;
  const osc = i.strength30 ?? 0;
  const nearMa50 = i.ma50 != null && Math.abs(i.ratio / i.ma50 - 1) < 0.03;

  if (nearMa50 && Math.abs(osc) < 3) return 'Sideways vs BTC';
  if (above50 && above200) return osc > 0 ? 'Strong uptrend vs BTC' : 'Weak uptrend vs BTC';
  if (above50 && !above200) return 'Recovery attempt';
  if (!above50 && !above200) return osc < -10 ? 'Strong downtrend vs BTC' : 'Weak downtrend vs BTC';
  return 'Sideways vs BTC';
};

const COPY: Record<State, { signal: string; verdict: string; summary: string; note: (s: string) => string; means: (s: string) => string }> = {
  avoid: {
    signal: 'Avoid',
    verdict: 'Bleeding against BTC',
    summary: 'Deeply underperforming BTC across every timeframe.',
    note: (s) => `${s} is cheap against BTC for a reason — no reclaim of its moving averages yet.`,
    means: (s) => `${s} is losing badly to BTC: the Alt/BTC ratio is below its 200-day MA and momentum is sharply negative on 30d and 90d. Simply holding BTC has outperformed it.`
  },
  bleeding: {
    signal: 'Bleeding against BTC',
    verdict: 'Bleeding against BTC',
    summary: 'Losing ground to BTC — no recovery signal yet.',
    note: (s) => `Avoid adding on "it looks cheap" until ${s}/BTC reclaims its moving averages.`,
    means: (s) => `${s} is bleeding against BTC: the ratio is below its 200-day MA and the oscillator is negative. Holding it has meant underperforming Bitcoin.`
  },
  weakening: {
    signal: 'Weakening',
    verdict: 'Watch only',
    summary: 'Drifting lower vs BTC, momentum flat-to-negative.',
    note: () => `No action signal yet — wait for the oscillator to turn positive.`,
    means: (s) => `${s} is drifting against BTC. The Alt/BTC ratio is below its 200-day MA and momentum is flat to slightly negative — not weak enough to call capitulation, not strong enough to call recovery.`
  },
  early_recovery: {
    signal: 'Early recovery',
    verdict: 'Early recovery',
    summary: 'Short-term strength, long-term trend still weak.',
    note: (s) => `${s} is not yet confirmed strong against BTC until it reclaims the 200-day moving average.`,
    means: (s) => `${s} has shown short-term strength against BTC, but the bigger trend still favors Bitcoin. It may be recovering, but it has not confirmed a full rotation — the ratio is still below its 200-day MA.`
  },
  watch: {
    signal: 'Watch only',
    verdict: 'Neutral',
    summary: 'Above long-term trend but momentum has cooled.',
    note: () => `Watch only — needs the oscillator back above 0 to re-confirm.`,
    means: (s) => `${s} is above its 200-day MA, so the longer-term picture isn't broken, but momentum vs BTC has cooled and it isn't actively outperforming right now.`
  },
  confirmed: {
    signal: 'Confirmed strength',
    verdict: 'Confirmed strength',
    summary: 'Above the 200-day MA with positive momentum.',
    note: () => `Strength holds while the ratio stays above the 200-day MA and the oscillator stays positive.`,
    means: (s) => `${s} is outperforming BTC and the Alt/BTC ratio is above its 200-day MA, so the strength is supported rather than a short-lived bounce.`
  },
  leader: {
    signal: 'Strong leader',
    verdict: 'Market leader',
    summary: 'One of the strongest alts vs BTC right now.',
    note: () => `A leader vs BTC — watch for overextension if the oscillator spikes.`,
    means: (s) => `${s} is a clear leader against BTC: above its 200-day MA with firmly positive 30d and 90d strength. Capital is rotating into it relative to Bitcoin.`
  },
  overextended: {
    signal: 'Overextended',
    verdict: 'Overextended',
    summary: 'Strong but stretched — moved too far, too fast.',
    note: () => `Strong but stretched — chasing here carries elevated pullback risk vs BTC.`,
    means: (s) => `${s} has run hard against BTC very quickly. It is strong, but the move looks stretched and is prone to mean-revert against Bitcoin.`
  }
};

const confirmationRules = (i: AnalysisInput, state: State): { needed: string[]; failure: string[] } => {
  const s = i.symbol;
  const confirmedSide = state === 'confirmed' || state === 'leader' || state === 'overextended';

  const needed = confirmedSide
    ? [`Hold above the 200-day Alt/BTC MA`, `Keep the 30d oscillator above 0`, `Make a higher high to extend leadership`]
    : [
        `${s}/BTC must reclaim the 200-day moving average`,
        `30d oscillator must turn — and stay — above 0`,
        (i.strength90 ?? 0) <= 0 ? `90d strength should turn positive` : `90d strength should hold positive`,
        `Ratio should make a higher high`
      ];

  const failure = [
    `If ${s}/BTC loses the 50-day moving average`,
    `If the 30d oscillator drops below -5%`,
    `If BTC dominance rises while TOTAL3/BTC weakens`
  ];

  return { needed, failure };
};

export const premiumSignal = (i: AnalysisInput): string => COPY[resolveState(i)].signal;

export const buildAnalysis = (i: AnalysisInput): Analysis => {
  const state = resolveState(i);
  const copy = COPY[state];
  const above50 = i.ma50 != null && i.ratio > i.ma50;
  const { needed, failure } = confirmationRules(i, state);

  return {
    trend_state: trendState(i),
    premium_signal: copy.signal,
    verdict_label: copy.verdict,
    verdict_summary: copy.summary,
    premium_note: copy.note(i.symbol),
    what_this_means: copy.means(i.symbol),
    confirmation_needed: needed,
    failure_warning: failure,
    reaction_breakdown: [
      { label: 'Alt/BTC trend', state: above50 ? (i.ma50 && i.ratio > i.ma50 * 1.05 ? 'Strong' : 'Improving') : 'Weak' },
      { label: 'Short-term (7d)', state: pctState(i.strength7) },
      { label: '30d relative strength', state: pctState(i.strength30) },
      { label: '90d relative strength', state: pctState(i.strength90) },
      { label: 'MA200 position', state: i.ma200 != null && i.ratio > i.ma200 ? 'Strong' : 'Weak' },
      { label: 'Oscillator (30d)', state: pctState(i.strength30) },
      { label: 'Volume support', state: (i.volumeBreakout ?? 0) > 1.5 ? 'Strong' : (i.volumeBreakout ?? 0) > 1 ? 'Improving' : 'Neutral' },
      { label: 'Sector support', state: 'Neutral' }
    ]
  };
};
