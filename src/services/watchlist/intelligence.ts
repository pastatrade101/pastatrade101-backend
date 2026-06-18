// Watchlist intelligence — turns a tracked item's "when added" snapshot and its
// current metrics into status, change narrative, confirmation/risk checklists,
// auto-notes and a portfolio-level summary + premium takeaway. Pure functions so
// they can be unit-tested without a database.

export interface WlMetrics {
  tvl: number | null;
  tvl_change_30d: number | null;
  stablecoin_mcap: number | null;
  dex_volume_change_7d: number | null;
  native_token_30d: number | null;
  strength_score: number | null;
}

export type Confidence = 'High' | 'Medium' | 'Low';

const n = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : v);
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const dir = (v: number | null, band: number): -1 | 0 | 1 => (v == null ? 0 : v > band ? 1 : v < -band ? -1 : 0);

// ── Ecosystem rich signal + confidence (mirrors the Ecosystems page) ────────
export const ecoSignal = (m: WlMetrics | null): string => {
  if (!m) return 'No data';
  const tvl = n(m.tvl_change_30d);
  const dex = n(m.dex_volume_change_7d);
  const nat = n(m.native_token_30d);
  const score = m.strength_score ?? 50;
  const present = [tvl, dex, nat].filter((v): v is number => v != null);
  if (!present.length) return 'No data';

  const tvlD = dir(tvl, 2);
  const natD = dir(nat, 2);
  const dexD = dir(dex, 4);
  const dirs = [tvl != null ? tvlD : null, dex != null ? dexD : null, nat != null ? natD : null].filter((d): d is -1 | 0 | 1 => d != null);
  const pos = dirs.filter((d) => d > 0).length;
  const neg = dirs.filter((d) => d < 0).length;
  const allKnown = tvl != null && dex != null && nat != null;
  const allPos = allKnown && tvlD > 0 && dexD > 0 && natD > 0;
  const allNeg = allKnown && tvl < 0 && dex < 0 && nat < 0;

  if (allPos && score >= 66) return 'Strong rotation';
  if (allNeg && tvl <= -15 && dex <= -30 && nat <= -15) return 'Deteriorating';
  if (tvlD > 0 && natD > 0) return 'Improving';
  if (neg >= 2) return 'Weak';
  if (pos >= 1 && ((tvl ?? 0) >= 8 || (nat ?? 0) >= 15)) return 'Selective strength';
  if (neg >= 1) return 'Under pressure';
  return 'Neutral';
};

export const ecoConfidence = (m: WlMetrics | null): Confidence => {
  if (!m) return 'Low';
  const tvl = n(m.tvl_change_30d);
  const dex = n(m.dex_volume_change_7d);
  const nat = n(m.native_token_30d);
  const stable = n(m.stablecoin_mcap);
  const missingCore = [tvl, dex, nat].filter((v) => v == null).length;
  const missingTotal = missingCore + (stable == null ? 1 : 0);
  if (missingCore >= 2 || missingTotal >= 2) return 'Low';
  if (missingTotal === 1) return 'Medium';
  const known = [tvl, dex, nat].filter((v): v is number => v != null);
  if (known.some((v) => v > 15) && known.some((v) => v < -15)) return 'Medium';
  return 'High';
};

// ── Signal ladder (covers ecosystem + coin/alt-btc vocabularies) ────────────
const RANK: Record<string, number> = {
  Deteriorating: 0,
  Overheated: 0,
  Distribution: 0,
  Weak: 1,
  'Very weak vs BTC': 1,
  'Not attractive': 1,
  'Under pressure': 2,
  'Cool-off': 2,
  'Watch zone': 2,
  Neutral: 3,
  'Selective strength': 4,
  Accumulation: 4,
  'Accumulation possible': 4,
  Improving: 5,
  'Strong vs BTC': 5,
  'Strong rotation': 6,
  Strong: 6,
  Hot: 6,
  'Very strong vs BTC': 6,
  'Risk-on': 6
};
const rank = (s: string | null | undefined): number => (s != null && s in RANK ? RANK[s] : 3);

export interface ItemState {
  name: string;
  type: string;
  metrics: WlMetrics | null;
  scoreWhenAdded: number | null;
  signalWhenAdded: string | null;
  previousSignal: string | null;
  currentScore: number | null;
  currentSignal: string;
  confidence: Confidence;
}

// ── Confirmation checklist: what still needs to happen to confirm strength ───
export const confirmationNeeded = (m: WlMetrics | null): string[] => {
  if (!m) return [];
  const out: string[] = [];
  if ((m.tvl_change_30d ?? 0) <= 2) out.push('30D TVL growth turns / stays positive');
  if ((m.dex_volume_change_7d ?? 0) <= 0) out.push('DEX volume stops falling (7D turns positive)');
  if ((m.native_token_30d ?? 0) <= 2) out.push('Native-token momentum turns positive');
  if (m.stablecoin_mcap == null) out.push('Stablecoin depth data improves');
  return out;
};

// ── Risk warnings: conditions currently true that threaten the thesis ────────
export const riskWarnings = (m: WlMetrics | null): string[] => {
  if (!m) return [];
  const out: string[] = [];
  if ((m.tvl_change_30d ?? 0) < 0) out.push(`TVL is negative over 30D (${pct(m.tvl_change_30d as number)})`);
  if ((m.dex_volume_change_7d ?? 0) < 0) out.push(`DEX volume is falling over 7D (${pct(m.dex_volume_change_7d as number)})`);
  if ((m.native_token_30d ?? 0) < 0) out.push(`Native token underperforming (${pct(m.native_token_30d as number)})`);
  return out;
};

// Strongest driver phrase for "what changed" narratives.
const changeReason = (m: WlMetrics | null): string => {
  if (!m) return '';
  const tvl = m.tvl_change_30d ?? 0;
  const nat = m.native_token_30d ?? 0;
  const dex = m.dex_volume_change_7d ?? 0;
  if (tvl >= 20) return `30D TVL growth rose to ${pct(tvl)}`;
  if (nat >= 20) return `native-token momentum turned strongly positive (${pct(nat)})`;
  if (tvl > 2 && nat > 2) return `TVL and native-token momentum both turned positive`;
  if (dex <= -30) return `DEX volume kept falling (${pct(dex)})`;
  if (tvl <= -15) return `30D TVL contracted to ${pct(tvl)}`;
  return '';
};

// ── Status label ─────────────────────────────────────────────────────────────
export const statusOf = (s: ItemState): string => {
  const addedR = rank(s.signalWhenAdded ?? s.currentSignal);
  const curR = rank(s.currentSignal);
  const dScore = s.currentScore != null && s.scoreWhenAdded != null ? s.currentScore - s.scoreWhenAdded : null;
  const risks = riskWarnings(s.metrics);
  const confirm = confirmationNeeded(s.metrics);

  if (['Strong rotation', 'Strong', 'Hot'].includes(s.currentSignal)) return 'Confirmed strength';
  if (s.currentSignal === 'Overheated' || (s.metrics && (s.metrics.native_token_30d ?? 0) > 80 && (s.currentScore ?? 0) > 85)) return 'Overextended';

  if (curR >= addedR + 1) {
    if (addedR <= 1 && curR >= 3) return 'Early recovery';
    return 'Signal upgraded';
  }
  if (curR <= addedR - 1) {
    if (curR <= 1) return 'Risk warning';
    return 'Signal downgraded';
  }
  if (curR <= 1) return risks.length ? 'Risk warning' : 'Still weak';
  if (s.currentSignal === 'Improving' && confirm.length) return 'Needs confirmation';
  if (s.currentSignal === 'Selective strength') return 'Breakout watch';
  if (dScore != null && dScore >= 3) return 'Improving';
  if (dScore != null && dScore <= -3) return 'Weakening';
  return 'No change';
};

// ── "What changed" narrative ────────────────────────────────────────────────
export const whatChanged = (s: ItemState): string => {
  const moved = s.signalWhenAdded && s.signalWhenAdded !== s.currentSignal;
  const reason = changeReason(s.metrics);
  if (moved) return `${s.name} moved from ${s.signalWhenAdded} to ${s.currentSignal}${reason ? ` after ${reason}` : ''}.`;

  const drift = s.currentScore != null && s.scoreWhenAdded != null ? s.currentScore - s.scoreWhenAdded : null;
  const driftTxt =
    drift == null || drift === 0
      ? ' Score is roughly unchanged since added.'
      : drift > 0
        ? ` Score improved +${drift.toFixed(0)} since added.`
        : ` Score fell ${drift.toFixed(0)} since added.`;
  let nuance = '';
  if (s.metrics) {
    if ((s.metrics.dex_volume_change_7d ?? 0) < 0) nuance = ' DEX volume is still weak, so the move is unconfirmed.';
    else if ((s.metrics.tvl_change_30d ?? 0) > 0 && (s.metrics.native_token_30d ?? 0) > 0) nuance = ' Capital and token momentum remain positive.';
  }
  return `${s.name} remains ${s.currentSignal}.${driftTxt}${nuance}`;
};

// ── Auto "why watching" when the user gives no reason ───────────────────────
export const autoWhyWatching = (name: string, currentSignal: string, m: WlMetrics | null): string => {
  if (m) {
    const pos: string[] = [];
    if ((m.tvl_change_30d ?? 0) > 0) pos.push('TVL growth is positive');
    if ((m.native_token_30d ?? 0) > 0) pos.push('native-token momentum has turned positive');
    if ((m.dex_volume_change_7d ?? 0) > 0) pos.push('DEX volume is rising');
    if (pos.length) return `Watching ${name} because ${pos.join(' and ')}.`;
    return `Watching ${name} for a recovery in TVL and on-chain activity.`;
  }
  return `Watching ${name} — current signal is ${currentSignal}.`;
};

// ── Auto note generated when a signal changes ───────────────────────────────
export const autoNote = (s: ItemState): string | null => {
  if (!s.signalWhenAdded || s.signalWhenAdded === s.currentSignal) return null;
  const up = rank(s.currentSignal) > rank(s.signalWhenAdded);
  const scorePart =
    s.currentScore != null && s.scoreWhenAdded != null ? ` because score moved from ${s.scoreWhenAdded.toFixed(0)} to ${s.currentScore.toFixed(0)}` : '';
  return `Signal ${up ? 'upgraded' : 'downgraded'} from ${s.signalWhenAdded} to ${s.currentSignal}${scorePart}.`;
};

// ── Portfolio summary + premium takeaway ────────────────────────────────────
export type Bucket = 'improving' | 'confirmed' | 'weakening' | 'risk' | 'confirm' | 'neutral';

export const bucketOf = (status: string): Bucket => {
  if (status === 'Confirmed strength') return 'confirmed';
  if (['Signal upgraded', 'Improving', 'Early recovery'].includes(status)) return 'improving';
  if (['Signal downgraded', 'Weakening'].includes(status)) return 'weakening';
  if (['Risk warning', 'Still weak'].includes(status)) return 'risk';
  if (['Needs confirmation', 'Breakout watch'].includes(status)) return 'confirm';
  return 'neutral';
};

export interface WatchlistSummary {
  total: number;
  improving: number;
  confirmed: number;
  weakening: number;
  needsConfirmation: number;
  riskWarnings: number;
  neutral: number;
  highConfidence: number;
  mostImportantChange: string | null;
  takeaway: string;
}

export const summarize = (items: { state: ItemState; status: string }[]): WatchlistSummary => {
  const total = items.length;
  const count = (b: Bucket) => items.filter((i) => bucketOf(i.status) === b).length;
  const improving = count('improving');
  const confirmed = count('confirmed');
  const weakening = count('weakening');
  const risk = count('risk');
  const confirm = count('confirm');
  const neutral = count('neutral');
  const highConfidence = items.filter((i) => i.state.confidence === 'High').length;

  // Most important change: prefer a signal change, ranked by score move magnitude.
  let most: { msg: string; weight: number } | null = null;
  for (const { state: s, status } of items) {
    const changed = s.signalWhenAdded && s.signalWhenAdded !== s.currentSignal;
    const dScore = s.currentScore != null && s.scoreWhenAdded != null ? Math.abs(s.currentScore - s.scoreWhenAdded) : 0;
    const weight = (changed ? 100 : 0) + dScore;
    if (weight <= 0) continue;
    const up = rank(s.currentSignal) >= rank(s.signalWhenAdded);
    const msg = changed
      ? `${s.name} ${up ? 'upgraded' : 'downgraded'} from ${s.signalWhenAdded} to ${s.currentSignal}.`
      : `${s.name} score moved to ${s.currentScore?.toFixed(0)} (${status}).`;
    if (!most || weight > most.weight) most = { msg, weight };
  }

  // Premium takeaway.
  let takeaway: string;
  if (!total) {
    takeaway = 'Your watchlist is empty. Add ecosystems, coins or pairs to start tracking whether the thesis is improving or breaking.';
  } else {
    const positive = improving + confirmed;
    const tone =
      positive > total / 2
        ? 'Your watchlist is improving'
        : risk + weakening > total / 2
          ? 'Your watchlist is weakening'
          : 'Your watchlist is mostly neutral';
    const leader = items
      .filter((i) => bucketOf(i.status) === 'improving' || bucketOf(i.status) === 'confirmed')
      .sort((a, b) => (b.state.currentScore ?? 0) - (a.state.currentScore ?? 0))[0];
    const leaderTxt = leader ? ` ${leader.state.name} is showing the strongest improvement.` : '';
    const closer =
      confirmed > 0
        ? ' Some items have confirmed strength — keep watching the rest for confirmation.'
        : positive > 0
          ? ' No broad confirmation yet — continue watching for DEX-volume recovery and signal confirmation.'
          : ' Continue watching for early-recovery signals before adding exposure.';
    takeaway = `${tone} — ${improving + confirmed} improving, ${neutral} neutral, ${risk + weakening} weak/at-risk.${leaderTxt}${closer}`;
  }

  return {
    total,
    improving,
    confirmed,
    weakening,
    needsConfirmation: confirm,
    riskWarnings: risk,
    neutral,
    highConfidence,
    mostImportantChange: most?.msg ?? null,
    takeaway
  };
};
