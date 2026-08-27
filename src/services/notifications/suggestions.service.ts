import { supabase } from '../../config/supabase';
import { env } from '../../config/env';
import { computeExitStrategy } from '../exit-strategy/exitStrategy.service';
import { computeAltcoinSeason, computeAltcoinSeasonHistory } from '../altcoin-btc/altcoin-season.service';
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
 * The values this template would carry if it were sent right now.
 * Unknown templates return nothing — a manual announcement has no live source,
 * and guessing would be worse than an empty form.
 */
export const suggestVariables = async (templateName: string): Promise<Suggestion | null> => {
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
