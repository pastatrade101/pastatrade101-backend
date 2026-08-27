import { supabase } from '../../config/supabase';
import { env } from '../../config/env';
import { dispatch, type DispatchSummary, type RuleKey } from './notifier.service';

// triggers.service — the events that cause a WhatsApp message, and the wording.
//
// Templates are approved by Meta with fixed text and numbered variables, so the
// only thing this file decides is what goes into {{1}}, {{2}}, {{3}}. Keep them
// short: a body variable may not contain a newline, and the whole rendered
// message has to still read like a notification rather than a newsletter.

const reportUrl = (slug: string): string => `${env.FRONTEND_URL.replace(/\/$/, '')}/reports/${slug}`;

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A report was published. Every opted-in member on a matching plan is told once,
 * ever — the report id is the subject, so re-publishing the same report cannot
 * message anybody twice.
 *
 * Template shape this expects (approved in Meta as `pastatrade_report_ready`):
 *
 *   "Your {{1}} market intelligence report is ready. Market posture: {{2}}.
 *    Read it here: {{3}} — Pastatrade. Not financial advice."
 */
export const notifyReportPublished = async (
  report: { id: string; slug: string | null; report_type: string; market_status?: { regime?: string } | null },
  triggeredBy?: string | null
): Promise<DispatchSummary> =>
  dispatch({
    ruleKey: 'report.published',
    subjectType: 'report',
    subjectId: report.id,
    triggeredBy: triggeredBy ?? null,
    variables: [
      titleCase(report.report_type),
      report.market_status?.regime ?? 'see the report',
      reportUrl(report.slug ?? report.id)
    ]
  });

/**
 * A market read has changed state — the risk band, the macro regime, whatever the
 * caller decides is worth interrupting somebody's day for.
 *
 * Change detection lives here rather than in a state table: the last send for
 * this rule carries the previous label as its subject, so a value that has not
 * moved simply produces no message. A member who joins mid-week is not told about
 * a change that happened before they arrived, which is the correct behaviour for
 * an alert (they can see the current state in the app).
 */
export const notifyMarketChange = async (
  kind: 'risk.band_changed' | 'regime.changed',
  input: { label: string; previous?: string | null; url?: string },
  triggeredBy?: string | null
): Promise<DispatchSummary> => {
  const fingerprint = `${kind}:${input.label}`;

  const { data: last } = await supabase
    .from('notification_sends')
    .select('subject_id')
    .eq('rule_key', kind)
    .eq('subject_type', 'signal')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const previousFingerprint = (last as { subject_id?: string } | null)?.subject_id ?? null;
  if (previousFingerprint === fingerprint) {
    return { batchId: null, audience: 0, sent: 0, skipped: 0, failed: 0, reason: 'Nothing changed since the last alert' };
  }

  const what = kind === 'risk.band_changed' ? 'BTC risk' : 'Market regime';
  return dispatch({
    ruleKey: kind as RuleKey,
    subjectType: 'signal',
    subjectId: fingerprint,
    triggeredBy: triggeredBy ?? null,
    variables: [what, input.label, input.url ?? env.FRONTEND_URL]
  });
};

/* ── Risk band ───────────────────────────────────────────────────────────── */

// The same 0–1 bands the risk dashboard draws, so an alert can never name a zone
// the app does not show.
const BANDS: { max: number; label: string }[] = [
  { max: 0.2, label: 'the Aggressive DCA zone' },
  { max: 0.4, label: 'the Good DCA zone' },
  { max: 0.6, label: 'the Neutral zone' },
  { max: 0.8, label: 'the Caution zone' },
  { max: Infinity, label: 'the Distribution zone' }
];
export const bandFor = (risk: number): string => (BANDS.find((b) => risk < b.max) ?? BANDS[BANDS.length - 1]).label;

const humanDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * "Last time it was here: 12 March 2024."
 *
 * This one line is what makes the alert feel like inside knowledge rather than a
 * bot, and it is the reason the rule is worth a notification at all. Walk back
 * through the daily history: skip the CURRENT streak in this band, then return
 * the first earlier day that was also in it. Null when the band has no prior
 * visit in the stored history — the caller then omits the line rather than
 * inventing one.
 */
const lastSeenInBand = async (band: string): Promise<string | null> => {
  const { data } = await supabase
    .from('risk_summary_daily')
    .select('snapshot_date, summary_risk')
    .order('snapshot_date', { ascending: false })
    .limit(1200); // ~3 years of daily rows

  const rows = (data ?? []) as { snapshot_date: string; summary_risk: number | null }[];
  let leftCurrentStreak = false;
  for (const r of rows) {
    if (r.summary_risk == null) continue;
    const inBand = bandFor(Number(r.summary_risk)) === band;
    if (!leftCurrentStreak) {
      // Still inside today's run of this band — keep walking back.
      if (!inBand) leftCurrentStreak = true;
      continue;
    }
    if (inBand) return humanDate(r.snapshot_date);
  }
  return null;
};

/**
 * BTC risk moved into a new band. Fires a handful of times a year, which is
 * exactly why it is worth interrupting someone for.
 *
 * Template `pastatrade_risk_band`:
 *   {{1}} band · {{2}} score · {{3}} last-seen phrase · {{4}} url
 */
export const notifyRiskBand = async (
  input: { risk: number; url?: string },
  triggeredBy?: string | null
): Promise<DispatchSummary> => {
  const band = bandFor(input.risk);
  const fingerprint = `risk.band_changed:${band}`;

  const { data: last } = await supabase
    .from('notification_sends')
    .select('subject_id')
    .eq('rule_key', 'risk.band_changed')
    .eq('subject_type', 'signal')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if ((last as { subject_id?: string } | null)?.subject_id === fingerprint) {
    return { batchId: null, audience: 0, sent: 0, skipped: 0, failed: 0, reason: 'BTC risk is still in the same band' };
  }

  const seen = await lastSeenInBand(band);
  return dispatch({
    ruleKey: 'risk.band_changed',
    subjectType: 'signal',
    subjectId: fingerprint,
    triggeredBy: triggeredBy ?? null,
    // A body variable cannot contain a newline, so the "last seen" clause is a
    // whole phrase — including its fallback — rather than a bare date.
    variables: [band, input.risk.toFixed(2), seen ? `Last time it was here: ${seen}` : 'This is a first in our recorded history', input.url ?? `${env.FRONTEND_URL}/app/risk`]
  });
};

/* ── Exit risk ───────────────────────────────────────────────────────────── */

/**
 * Exit risk crossed a ladder threshold. The rarest and highest-stakes message we
 * send, so it is deliberately one-way: crossing UP alerts, drifting back down
 * does not (that is not news, and it would double the traffic).
 *
 * Template `pastatrade_exit_threshold`:
 *   {{1}} threshold · {{2}} action · {{3}} url
 */
export const notifyExitThreshold = async (
  input: { score: number; threshold?: number; action: string; url?: string },
  triggeredBy?: string | null
): Promise<DispatchSummary> => {
  const threshold = input.threshold ?? 0.75;
  if (input.score < threshold) {
    return { batchId: null, audience: 0, sent: 0, skipped: 0, failed: 0, reason: `Exit risk ${input.score.toFixed(2)} is below ${threshold}` };
  }
  return dispatch({
    ruleKey: 'exit.threshold_crossed',
    subjectType: 'signal',
    // One alert per threshold per crossing — re-entering later is a new subject.
    subjectId: `exit.threshold_crossed:${threshold}`,
    triggeredBy: triggeredBy ?? null,
    variables: [threshold.toFixed(2), input.action, input.url ?? `${env.FRONTEND_URL}/app/exit-strategy`]
  });
};

/* ── Altcoin breadth ─────────────────────────────────────────────────────── */

/**
 * The share of altcoins beating BTC flipped regime. Keyed on the LABEL, not the
 * percentage, so a number drifting 43% → 44% is silent and only a genuine change
 * of state ("Selective strength" → "Broad strength") sends.
 *
 * Template `pastatrade_altcoin_breadth`:
 *   {{1}} pct now · {{2}} pct before · {{3}} label · {{4}} url
 */
export const notifyAltcoinBreadth = async (
  input: { pct: number; previousPct?: number | null; label: string; url?: string },
  triggeredBy?: string | null
): Promise<DispatchSummary> => {
  const fingerprint = `altcoin.signal:${input.label}`;

  const { data: last } = await supabase
    .from('notification_sends')
    .select('subject_id')
    .eq('rule_key', 'altcoin.signal')
    .eq('subject_type', 'signal')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if ((last as { subject_id?: string } | null)?.subject_id === fingerprint) {
    return { batchId: null, audience: 0, sent: 0, skipped: 0, failed: 0, reason: 'Altcoin breadth is still in the same regime' };
  }

  return dispatch({
    ruleKey: 'altcoin.signal',
    subjectType: 'signal',
    subjectId: fingerprint,
    triggeredBy: triggeredBy ?? null,
    variables: [
      Math.round(input.pct).toString(),
      input.previousPct == null ? 'n/a' : Math.round(input.previousPct).toString(),
      input.label,
      input.url ?? `${env.FRONTEND_URL}/app/altcoin-btc-lab`
    ]
  });
};

/** An admin writing to the membership directly, through an approved template. */
export const sendAnnouncement = async (input: {
  templateName: string;
  templateLanguage?: string;
  variables: string[];
  note?: string;
  triggeredBy: string;
}): Promise<DispatchSummary> =>
  dispatch({
    ruleKey: 'manual',
    subjectType: 'manual',
    // A fresh subject each time: an announcement is deliberately repeatable.
    subjectId: `${Date.now()}`,
    triggeredBy: input.triggeredBy,
    templateName: input.templateName,
    templateLanguage: input.templateLanguage,
    variables: input.variables,
    note: input.note
  });
