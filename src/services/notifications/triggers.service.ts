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
