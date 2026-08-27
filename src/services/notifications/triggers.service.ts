import { supabase } from '../../config/supabase';
import { env } from '../../config/env';
import { dispatch, type DispatchSummary, type RuleKey } from './notifier.service';

// triggers.service — the events that cause a WhatsApp message, and the wording.
//
// Templates are approved by Meta with fixed text and numbered variables, so the
// only thing this file decides is what goes into {{1}}, {{2}}, {{3}}, {{4}} — and,
// more importantly, WHETHER TO SEND AT ALL.
//
// That second job is the whole point. A market number moves constantly; a person's
// phone must not. Each trigger below therefore compares against the last thing we
// said, and stays silent when nothing has genuinely changed. There is no state
// table for this: the last send's `subject_id` IS the previous state, which means
// the record of what we told someone and the logic deciding what to tell them next
// can never drift apart.

const site = (): string => env.FRONTEND_URL.replace(/\/$/, '');
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The subject of the most recent send for a rule — i.e. what we last said. */
const lastSubject = async (ruleKey: string): Promise<string | null> => {
  const { data } = await supabase
    .from('notification_sends')
    .select('subject_id')
    .eq('rule_key', ruleKey)
    .eq('subject_type', 'signal')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { subject_id?: string } | null)?.subject_id ?? null;
};

const unchanged = (reason: string): DispatchSummary => ({
  batchId: null,
  audience: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  reason
});

/* ── 1. BTC risk band ─────────────────────────────────────────────────────── */

/**
 * BTC risk has moved into a different zone.
 *
 * Template `pastatrade_risk_band`:
 *   {{1}} zone · {{2}} score · {{3}} the history clause · {{4}} link
 *
 * {{3}} is the whole clause rather than a bare date because it has to read
 * correctly when there is no earlier visit — "This is a first in our recorded
 * history" is a sentence, not a null date.
 */
export const notifyRiskBand = async (
  input: { zone: string; score: number | string; lastVisit?: string | null },
  triggeredBy?: string | null
): Promise<DispatchSummary> => {
  const fingerprint = `risk:${input.zone}`;
  if ((await lastSubject('risk.band_changed')) === fingerprint) {
    return unchanged(`BTC risk is still in ${input.zone} — nothing sent`);
  }

  const history = input.lastVisit
    ? `Last time it was here: ${input.lastVisit}`
    : 'This is a first in our recorded history';

  return dispatch({
    ruleKey: 'risk.band_changed',
    subjectType: 'signal',
    subjectId: fingerprint,
    triggeredBy: triggeredBy ?? null,
    variables: [input.zone, String(input.score), history, `${site()}/app/risk`]
  });
};

/* ── 2. Exit threshold ────────────────────────────────────────────────────── */

/**
 * Exit risk crossed the threshold.
 *
 * Fires on the way UP only. Coming back down is not news, and treating it as news
 * would double the traffic on the one alert that most needs to stay rare — the
 * message says "historically a distribution zone", which is meaningless when the
 * value is falling out of it.
 *
 * Template `pastatrade_exit_threshold`:
 *   {{1}} threshold · {{2}} what the ladder says · {{3}} link
 */
export const notifyExitThreshold = async (
  input: { threshold: number | string; above: boolean; ladder: string },
  triggeredBy?: string | null
): Promise<DispatchSummary> => {
  const previous = await lastSubject('exit.threshold_crossed');
  const wasAbove = previous?.endsWith(':above') ?? false;

  if (!input.above) {
    // Record the descent so the next climb counts as a crossing, but say nothing.
    if (wasAbove) {
      await supabase.from('notification_batches').insert({
        rule_key: 'exit.threshold_crossed',
        subject_type: 'signal',
        subject_id: `exit:${input.threshold}:below`,
        audience_count: 0,
        status: 'done',
        note: 'Exit risk fell back below the threshold — state recorded, nothing sent.',
        finished_at: new Date().toISOString()
      });
    }
    return unchanged('Exit risk is below the threshold — nothing sent');
  }

  if (wasAbove) return unchanged('Exit risk was already above the threshold — nothing sent');

  return dispatch({
    ruleKey: 'exit.threshold_crossed',
    subjectType: 'signal',
    subjectId: `exit:${input.threshold}:above`,
    triggeredBy: triggeredBy ?? null,
    variables: [String(input.threshold), input.ladder, `${site()}/app/exit-strategy`]
  });
};

/* ── 3. Altcoin breadth ───────────────────────────────────────────────────── */

/**
 * The share of altcoins beating BTC has moved into a different breadth regime.
 *
 * Keyed on the LABEL, never the percentage: 43% drifting to 44% is noise and must
 * stay silent, while "Narrow" becoming "Broad strength" is the thing worth a
 * message. The percentages still travel in the text — they are the evidence for
 * the label, not the trigger for the send.
 *
 * Template `pastatrade_altcoin_breadth`:
 *   {{1}} percent now · {{2}} percent before · {{3}} breadth label · {{4}} link
 */
export const notifyAltcoinBreadth = async (
  input: { percent: number | string; previousPercent: number | string; label: string },
  triggeredBy?: string | null
): Promise<DispatchSummary> => {
  const fingerprint = `altcoin:${input.label}`;
  if ((await lastSubject('altcoin.signal')) === fingerprint) {
    return unchanged(`Breadth is still "${input.label}" — nothing sent`);
  }

  return dispatch({
    ruleKey: 'altcoin.signal',
    subjectType: 'signal',
    subjectId: fingerprint,
    triggeredBy: triggeredBy ?? null,
    variables: [
      String(input.percent),
      String(input.previousPercent),
      input.label,
      `${site()}/app/altcoin-btc-lab`
    ]
  });
};

/* ── 4. Report published ──────────────────────────────────────────────────── */

/**
 * A report was published. Every opted-in member on a matching plan is told once,
 * ever — the report id is the subject, so re-publishing the same report cannot
 * message anybody twice.
 *
 * Template `pastatrade_report_ready`:
 *   {{1}} report type · {{2}} market posture · {{3}} link
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
      `${site()}/reports/${report.slug ?? report.id}`
    ]
  });

/* ── 5. By hand ───────────────────────────────────────────────────────────── */

/** An admin writing to the membership directly, through an approved template. */
export const sendAnnouncement = async (input: {
  templateName: string;
  templateLanguage?: string;
  variables: string[];
  note?: string;
  triggeredBy: string;
}): Promise<DispatchSummary> =>
  dispatch({
    ruleKey: 'manual' as RuleKey,
    subjectType: 'manual',
    // A fresh subject each time: an announcement is deliberately repeatable.
    subjectId: `${Date.now()}`,
    triggeredBy: input.triggeredBy,
    templateName: input.templateName,
    templateLanguage: input.templateLanguage,
    variables: input.variables,
    note: input.note
  });
