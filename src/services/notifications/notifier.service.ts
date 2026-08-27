import { supabase } from '../../config/supabase';
import { env } from '../../config/env';
import { isConnectConfigured, sendTemplate, type TemplateComponent } from './connect.client';

// notifier.service — who gets told, and the rules that stop us telling them twice.
//
// The order below is the whole design, and it is deliberately conservative:
//
//   rule enabled → has an approved template → member opted IN → not opted out
//   → plan matches → not already sent this exact thing → within their own rate
//   limits → within this run's ceiling → send
//
// Anything that fails a step is RECORDED as skipped with a reason rather than
// silently dropped, because "why didn't Amina get it?" is the question this
// system will actually be asked.
//
// Note what is NOT here: any way to message someone who has not opted in. A phone
// number in `users.phone` was collected for mobile-money checkout, and reusing it
// for broadcasts is exactly the thing that gets a WhatsApp number banned.

/** The rules that ship. `regime.changed` was dropped — no template covers it. */
export type RuleKey =
  | 'risk.band_changed'
  | 'exit.threshold_crossed'
  | 'altcoin.signal'
  | 'report.published'
  | 'manual';

export interface NotificationRule {
  id: string;
  key: string;
  label: string;
  enabled: boolean;
  plan_codes: string[];
  template_name: string | null;
  template_language: string;
  min_hours_between: number;
  max_per_day: number;
}

export interface Recipient {
  id: string;
  email: string;
  whatsapp_number: string;
  plan_code: string | null;
}

export interface DispatchInput {
  ruleKey: RuleKey;
  /** What this is about — a report id, a signal fingerprint, an admin batch id. */
  subjectType: 'report' | 'signal' | 'manual';
  subjectId: string;
  /** Values for the template's {{1}}, {{2}}… in order. No newlines: Meta rejects them. */
  variables: string[];
  triggeredBy?: string | null;
  note?: string;
  /** Overrides the rule's template — used by a manual admin send. */
  templateName?: string;
  templateLanguage?: string;
}

export interface DispatchSummary {
  batchId: string | null;
  audience: number;
  sent: number;
  skipped: number;
  failed: number;
  reason?: string;
}

const nothing = (reason: string): DispatchSummary => ({
  batchId: null,
  audience: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  reason
});

export const getRule = async (key: string): Promise<NotificationRule | null> => {
  const { data } = await supabase.from('notification_rules').select('*').eq('key', key).maybeSingle();
  return (data as NotificationRule) ?? null;
};

/**
 * Everyone who may receive this rule right now.
 *
 * Opt-in is the first filter, not the last, so a plan change or a mis-typed rule
 * can never widen the audience beyond people who actually agreed.
 */
export const resolveAudience = async (rule: NotificationRule): Promise<Recipient[]> => {
  let query = supabase
    .from('users')
    .select('id, email, whatsapp_number, whatsapp_opted_in_at, whatsapp_opted_out_at, plans(code)')
    .not('whatsapp_opted_in_at', 'is', null)
    .is('whatsapp_opted_out_at', null)
    .not('whatsapp_number', 'is', null)
    .eq('subscription_status', 'active');

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      id: String(r.id),
      email: String(r.email ?? ''),
      whatsapp_number: String(r.whatsapp_number ?? ''),
      plan_code: ((r.plans as { code?: string } | null)?.code as string) ?? null
    }))
    .filter((r) => r.whatsapp_number.length > 5)
    // An empty plan list on the rule means "every opted-in member".
    .filter((r) => rule.plan_codes.length === 0 || (r.plan_code !== null && rule.plan_codes.includes(r.plan_code)));
};

/** Has this person had too much from us lately? */
const withinRateLimits = async (rule: NotificationRule, userId: string): Promise<string | null> => {
  const since = new Date(Date.now() - rule.min_hours_between * 3600_000).toISOString();
  const dayStart = new Date(new Date().toISOString().slice(0, 10)).toISOString();

  const [{ count: recent }, { count: today }] = await Promise.all([
    supabase
      .from('notification_sends')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('rule_key', rule.key)
      .eq('status', 'sent')
      .gte('created_at', since),
    supabase
      .from('notification_sends')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'sent')
      .gte('created_at', dayStart)
  ]);

  if ((recent ?? 0) > 0) return 'rate_limited';
  if ((today ?? 0) >= rule.max_per_day) return 'rate_limited';
  return null;
};

const bodyComponents = (variables: string[]): TemplateComponent[] =>
  variables.length
    ? [
        {
          type: 'body',
          // Meta rejects newlines and tabs inside a variable, and a 4-space run
          // reads as a tab to their validator. Collapse rather than fail late.
          parameters: variables.map((v) => ({ type: 'text' as const, text: v.replace(/\s+/g, ' ').trim().slice(0, 900) }))
        }
      ]
    : [];

/**
 * Send one rule to its audience. Returns what happened, in numbers an admin can
 * read back. Never throws for a single failed recipient — one bad number must not
 * stop the other four hundred.
 */
export const dispatch = async (input: DispatchInput): Promise<DispatchSummary> => {
  if (!isConnectConfigured()) return nothing('CONNECT_API_KEY is not set — nothing was sent');

  const rule = await getRule(input.ruleKey);
  if (!rule) return nothing(`No rule named ${input.ruleKey}`);
  if (!rule.enabled) return nothing(`The "${rule.label}" rule is switched off`);

  const templateName = input.templateName ?? rule.template_name;
  const templateLanguage = input.templateLanguage ?? rule.template_language;
  if (!templateName) {
    // Not a technicality: outside a 24-hour window Meta permits nothing else.
    return nothing(`The "${rule.label}" rule has no approved template, so it cannot send`);
  }

  const audience = await resolveAudience(rule);
  const { data: batch } = await supabase
    .from('notification_batches')
    .insert({
      rule_key: rule.key,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      triggered_by: input.triggeredBy ?? null,
      audience_count: audience.length,
      note: input.note ?? null
    })
    .select('id')
    .single();

  const batchId = (batch as { id: string } | null)?.id ?? null;
  const components = bodyComponents(input.variables);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const person of audience) {
    if (sent >= env.WHATSAPP_MAX_PER_RUN) {
      skipped += 1;
      continue;
    }

    // Claim the slot first. The unique index means a second scheduler tick, a
    // double-clicked admin button and a retry all collide here rather than in
    // somebody's WhatsApp.
    const { data: claim, error: claimError } = await supabase
      .from('notification_sends')
      .insert({
        rule_key: rule.key,
        user_id: person.id,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        to_number: person.whatsapp_number,
        status: 'queued'
      })
      .select('id')
      .single();

    if (claimError || !claim) {
      skipped += 1; // already sent to this person for this subject
      continue;
    }
    const sendId = (claim as { id: string }).id;

    const limited = await withinRateLimits(rule, person.id);
    if (limited) {
      await supabase.from('notification_sends').update({ status: 'skipped', skip_reason: limited }).eq('id', sendId);
      skipped += 1;
      continue;
    }

    const result = await sendTemplate({
      to: person.whatsapp_number,
      templateName,
      language: templateLanguage,
      components,
      idempotencyKey: `pastatrade:${rule.key}:${input.subjectType}:${input.subjectId}:${person.id}`
    });

    if (result.ok) {
      await supabase
        .from('notification_sends')
        .update({ status: 'sent', sent_at: new Date().toISOString(), connect_message_id: result.messageId ?? null })
        .eq('id', sendId);
      sent += 1;
    } else {
      const policy = result.code === 'WHATSAPP_POLICY_BLOCKED';
      await supabase
        .from('notification_sends')
        .update({
          status: policy ? 'skipped' : 'failed',
          skip_reason: policy ? 'policy_blocked' : null,
          error: `${result.code ?? ''} ${result.error ?? ''}`.trim()
        })
        .eq('id', sendId);
      if (policy) skipped += 1;
      else failed += 1;
    }
  }

  if (batchId) {
    await supabase
      .from('notification_batches')
      .update({
        sent_count: sent,
        skipped_count: skipped,
        failed_count: failed,
        status: failed > 0 && sent === 0 ? 'failed' : 'done',
        finished_at: new Date().toISOString()
      })
      .eq('id', batchId);
  }

  return { batchId, audience: audience.length, sent, skipped, failed };
};
