import { supabase } from '../../config/supabase';
import { env } from '../../config/env';
import { computeExitStrategy } from '../exit-strategy/exitStrategy.service';
import { computeAltcoinSeason, computeAltcoinSeasonHistory } from '../altcoin-btc/altcoin-season.service';
import { computeConfidence, computeQuality, type SignalMetrics } from '../altcoin-btc/signal-quality';
import type { RuleKey } from './notifier.service';

// suggestions.service — fill the announcement form from live data.
//
// An admin typing "0.75" and "Start trimming into strength" into three boxes is
// how a message goes out saying something the dashboard does not. Every value a
// template needs is already computed somewhere in this app, so the form should
// offer it and let the admin correct it rather than the other way round.
//
// Read-only and best-effort: if a source is unavailable the blank comes back
// empty with a note, and the admin can still type. Nothing here sends anything.

const site = (): string => env.FRONTEND_URL.replace(/\/$/, '');

export interface Suggestion {
  /** Values in {{1}}, {{2}}, … order, ready to drop into the form. */
  variables: string[];
  /** What each value is, so the form can label the blanks honestly. */
  labels: string[];
  /** Shown under the form: where these numbers came from, or why they are missing. */
  source: string;
  /** False when live data could not be read — the admin must fill it in by hand. */
  live: boolean;
}

const empty = (labels: string[], source: string): Suggestion => ({
  variables: labels.map(() => ''),
  labels,
  source,
  live: false
});

/* ── BTC risk band ────────────────────────────────────────────────────────── */

const BANDS: { max: number; label: string }[] = [
  { max: 0.2, label: 'the Aggressive DCA zone' },
  { max: 0.4, label: 'the Good DCA zone' },
  { max: 0.6, label: 'the Neutral zone' },
  { max: 0.8, label: 'the Caution zone' },
  { max: Infinity, label: 'the Distribution zone' }
];
const bandFor = (risk: number): string => (BANDS.find((b) => risk < b.max) ?? BANDS[BANDS.length - 1]).label;

const humanDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * "Last time it was here: 12 March 2024" — the line that makes the alert feel
 * like inside knowledge rather than a bot.
 *
 * Walks back through the daily history, skips the CURRENT run in this band, and
 * returns the first earlier day that was also in it. Null when there is no prior
 * visit, so the caller can say so honestly instead of inventing a date.
 */
const lastSeenInBand = async (band: string): Promise<string | null> => {
  const { data } = await supabase
    .from('risk_summary_daily')
    .select('snapshot_date, summary_risk')
    .order('snapshot_date', { ascending: false })
    .limit(1200); // ~3 years of daily rows

  let leftCurrentRun = false;
  for (const r of (data ?? []) as { snapshot_date: string; summary_risk: number | null }[]) {
    if (r.summary_risk == null) continue;
    const inBand = bandFor(Number(r.summary_risk)) === band;
    if (!leftCurrentRun) {
      if (!inBand) leftCurrentRun = true;
      continue;
    }
    if (inBand) return humanDate(r.snapshot_date);
  }
  return null;
};

const riskBandSuggestion = async (): Promise<Suggestion> => {
  const labels = ['Zone', 'Score', 'History line', 'Link'];
  const { data } = await supabase
    .from('risk_summary_daily')
    .select('snapshot_date, summary_risk')
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as { snapshot_date: string; summary_risk: number | null } | null;
  if (!row || row.summary_risk == null) return empty(labels, 'No BTC risk score has been synced yet.');

  const score = Number(row.summary_risk);
  const zone = bandFor(score);
  const seen = await lastSeenInBand(zone);

  return {
    variables: [
      zone,
      score.toFixed(2),
      seen ? `Last time it was here: ${seen}` : 'This is a first in our recorded history',
      `${site()}/app/risk`
    ],
    labels,
    source: `BTC risk ${score.toFixed(2)} as of ${humanDate(row.snapshot_date)}.`,
    live: true
  };
};

/* ── Exit threshold ───────────────────────────────────────────────────────── */

const exitSuggestion = async (): Promise<Suggestion> => {
  const labels = ['Threshold', 'What the ladder says', 'Link'];
  try {
    const r = (await computeExitStrategy()) as {
      exit_risk_score?: number;
      current_action?: { action?: string } | null;
      next_threshold?: { score?: number } | null;
    };
    if (r?.exit_risk_score == null) return empty(labels, 'Exit strategy has not been computed yet.');

    const score = Number(r.exit_risk_score);
    // The threshold this message is ABOUT is the highest ladder step the score has
    // actually reached — never the next one ahead.
    const crossed = [0.9, 0.75, 0.6, 0.5].find((t) => score >= t);

    // Nothing has been crossed. The template says "Exit risk has crossed {{1}} —
    // historically a distribution zone", which would simply be untrue, so the
    // blanks stay empty and the admin is told why. Prefilling 0.75 here is
    // exactly the false message this whole feature exists to prevent.
    if (crossed === undefined) {
      return empty(
        labels,
        `Exit risk is ${score.toFixed(2)} — it has not crossed a ladder threshold, so this alert would not be true right now.`
      );
    }

    return {
      variables: [crossed.toFixed(2), r.current_action?.action ?? 'Review your exit ladder', `${site()}/app/exit-strategy`],
      labels,
      source: `Exit risk is ${score.toFixed(2)}, above ${crossed.toFixed(2)}.`,
      live: true
    };
  } catch {
    return empty(labels, 'Could not read the exit strategy just now.');
  }
};

/* ── Altcoin breadth ──────────────────────────────────────────────────────── */

const altcoinSuggestion = async (): Promise<Suggestion> => {
  const labels = ['Percent now', 'Percent before', 'Breadth label', 'Link'];
  try {
    // Computed live — there is no daily breadth table. The label comes from the
    // module's own regime_label, so the message and the dashboard cannot disagree.
    const now = await computeAltcoinSeason();
    const pct = Math.round(now.outperforming_btc_percent);

    // "Up from" needs a real comparison, and a week back is the honest one —
    // yesterday is noise. If history is unavailable the blank stays empty rather
    // than repeating today's number back as if it were last week's.
    let prev = '';
    try {
      const history = await computeAltcoinSeasonHistory('30d', 'premium_clean', 10);
      const weekAgo = history.at(-8) ?? history.at(0);
      if (weekAgo) prev = String(Math.round(weekAgo.positive_pct));
    } catch {
      /* leave it blank for the admin to fill */
    }

    return {
      variables: [String(pct), prev, now.regime_label, `${site()}/app/altcoin-btc-lab`],
      labels,
      source: `${pct}% of altcoins are beating BTC right now · ${now.regime_label}.`,
      live: true
    };
  } catch {
    return empty(labels, 'Altcoin breadth needs a Lab price-series sync before it can be read.');
  }
};

/* ── Report published ─────────────────────────────────────────────────────── */

const reportSuggestion = async (): Promise<Suggestion> => {
  const labels = ['Report type', 'Market posture', 'Link'];
  const { data } = await supabase
    .from('reports')
    .select('id, slug, report_type, market_status, report_date')
    .eq('status', 'published')
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const r = data as { id: string; slug: string | null; report_type: string; market_status?: { regime?: string } | null } | null;
  if (!r) return empty(labels, 'No published report to point at yet.');

  const type = r.report_type.charAt(0).toUpperCase() + r.report_type.slice(1);
  return {
    variables: [type, r.market_status?.regime ?? 'see the report', `${site()}/reports/${r.slug ?? r.id}`],
    labels,
    source: `Latest published report: ${type}.`,
    live: true
  };
};

/* ── Coins beating BTC ────────────────────────────────────────────────────── */

export interface CoinCandidate {
  symbol: string;
  name: string;
  signal_label: string;
  strength_30d: number | null;
  strength_90d: number | null;
  confidence: string;
  quality: string;
  /**
   * True only when the app's own checks agree it is a real, held move: a clean
   * signal AND high confidence — i.e. liquid, 180+ days of history, no abnormal
   * spike, above the 200-day MA and positive over both 30d and 90d.
   *
   * Anything the dashboard labels "Needs confirmation" (an early recovery still
   * under the 200-day MA) is deliberately NOT confirmed here. Naming those in a
   * broadcast is how a bounce gets sold as a trend.
   */
  confirmed: boolean;
}

/**
 * Coins currently beating BTC, strongest first, each carrying the same
 * confidence/quality verdict the Alt/BTC Lab shows — so a coin named in a
 * message can never contradict its own page.
 */
export const listOutperformers = async (): Promise<{ items: CoinCandidate[]; as_of: string | null }> => {
  const { data: latest } = await supabase
    .from('altcoin_btc_signals')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return { items: [], as_of: null };

  const asOf = (latest as { date: string }).date;
  const { data } = await supabase
    .from('altcoin_btc_signals')
    .select('signal_type, signal_label, details, coin:coins(symbol, name)')
    .eq('date', asOf);

  const items: CoinCandidate[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const coinRaw = r.coin as { symbol?: string; name?: string } | Array<{ symbol?: string; name?: string }> | null;
    const coin = Array.isArray(coinRaw) ? coinRaw[0] : coinRaw;
    if (!coin?.symbol) continue;

    const d = (r.details ?? {}) as Record<string, number | boolean | null>;
    const metrics: SignalMetrics = {
      strength_7d: (d.strength_7d as number) ?? null,
      strength_30d: (d.strength_30d as number) ?? null,
      strength_90d: (d.strength_90d as number) ?? null,
      above_ma50: Boolean(d.above_ma50),
      above_ma200: Boolean(d.above_ma200),
      volume_breakout: (d.volume_breakout as number) ?? null,
      market_cap: (d.market_cap as number) ?? null,
      total_volume: (d.total_volume as number) ?? null,
      market_cap_rank: (d.market_cap_rank as number) ?? null,
      history_days: (d.history_days as number) ?? 0
    };

    // Beating BTC means positive 30-day strength. The signal_type is the app's
    // own breakout call and is kept as the label, but the number is the filter.
    if ((metrics.strength_30d ?? 0) <= 0) continue;

    const confidence = computeConfidence(metrics);
    const quality = computeQuality(metrics);
    items.push({
      symbol: String(coin.symbol).toUpperCase(),
      name: String(coin.name ?? coin.symbol),
      signal_label: String(r.signal_label ?? r.signal_type ?? ''),
      strength_30d: metrics.strength_30d,
      strength_90d: metrics.strength_90d,
      confidence,
      quality,
      confirmed: quality === 'Clean signal' && confidence === 'High confidence'
    });
  }

  items.sort((a, b) => (b.strength_30d ?? -1e9) - (a.strength_30d ?? -1e9));
  return { items, as_of: asOf };
};

/* ── Entry point ──────────────────────────────────────────────────────────── */

/** Template name → the rule it belongs to. Templates are named after their rule. */
export const ruleForTemplate = (templateName: string): RuleKey | null => {
  const n = templateName.toLowerCase();
  if (n.includes('risk_band')) return 'risk.band_changed';
  if (n.includes('exit')) return 'exit.threshold_crossed';
  if (n.includes('altcoin') || n.includes('breadth')) return 'altcoin.signal';
  if (n.includes('report')) return 'report.published';
  return null;
};

/**
 * The coin-list template has no RULE — it is sent by hand, because which coins
 * to name is a judgement call. Matched separately, and loosely, so whatever the
 * template ends up being called ("beating_btc", "alt_leaders", "leaders") still
 * gets its blanks filled.
 */
const isLeadersTemplate = (templateName: string): boolean =>
  /beating[_-]?btc|alt[_-]?leaders|leaders|outperform/i.test(templateName);

/**
 * "Confirmed stronger than BTC right now: PUMP, ENA, SPX, ZEC, SOL"
 *
 * Only confirmed coins are offered — clean signal AND high confidence. The
 * strongest 30-day number on the board is usually a coin with three weeks of
 * history, and naming that sells a bounce as a trend.
 */
const leadersSuggestion = async (): Promise<Suggestion> => {
  const labels = ['Coins (confirmed)', 'Breadth', 'Link'];
  const { items } = await listOutperformers();
  const confirmed = items.filter((c) => c.confirmed);
  if (!confirmed.length) {
    return empty(
      labels,
      items.length
        ? `${items.length} coins are beating BTC, but none are confirmed right now — pick manually below if you still want to send.`
        : 'No Alt/BTC signals yet — run a Lab price-series sync.'
    );
  }

  // Five is the practical ceiling: more reads as a shill and WhatsApp truncates
  // the preview anyway.
  const top = confirmed.slice(0, 5);

  let breadth = '';
  try {
    const season = await computeAltcoinSeason();
    breadth = `${Math.round(season.outperforming_btc_percent)}%`;
  } catch {
    /* the admin can fill it in; the coin list is the point of this message */
  }

  return {
    variables: [top.map((c) => c.symbol).join(', '), breadth, `${site()}/app/altcoin-btc-lab`],
    labels,
    source: `${confirmed.length} of ${items.length} coins beating BTC are confirmed; the strongest ${top.length} are filled in.`,
    live: true
  };
};

/**
 * The values this template would carry if it were sent right now.
 * Unknown templates return nothing — a manual announcement has no live source,
 * and guessing would be worse than an empty form.
 */
export const suggestVariables = async (templateName: string): Promise<Suggestion | null> => {
  // Checked first: "beating_btc" contains none of the rule keywords, and this
  // template is the one that most needs filling — a hand-typed ticker list is
  // how a coin that already rolled over reaches every opted-in member.
  if (isLeadersTemplate(templateName)) return leadersSuggestion();

  switch (ruleForTemplate(templateName)) {
    case 'risk.band_changed':
      return riskBandSuggestion();
    case 'exit.threshold_crossed':
      return exitSuggestion();
    case 'altcoin.signal':
      return altcoinSuggestion();
    case 'report.published':
      return reportSuggestion();
    default:
      return null;
  }
};
