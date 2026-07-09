import { supabase } from '../../config/supabase';

// Subscription lifecycle. Payment providers are intentionally NOT referenced
// here — a provider webhook (Stripe / mobile money) simply calls assignPlan() /
// setStatus(). Subscription status drives access; payments only update status.

const planIdForSlug = async (slug: string): Promise<string | null> => {
  const { data } = await supabase.from('plans').select('id').eq('slug', slug).maybeSingle();
  return data?.id ?? null;
};

/** Assign a user to the free plan (called right after registration). Best-effort. */
export const assignDefaultFreePlan = async (userId: string): Promise<void> => {
  const freeId = await planIdForSlug('free');
  if (!freeId) return;
  await supabase.from('users').update({ plan_id: freeId, subscription_status: 'active' }).eq('id', userId);
  await supabase.from('subscriptions').insert({ user_id: userId, plan_id: freeId, status: 'active', billing_interval: 'manual', provider: 'system' });
};

export interface AssignPlanInput {
  planId?: string;
  planSlug?: string;
  status?: string;
  billing_interval?: string;
  provider?: string;
  current_period_start?: string | null;
  current_period_end?: string | null;
  // When true (and no explicit current_period_end is given), any time still left
  // on the user's current plan is added on top of the new period. So a Mid user
  // with 12 days left who upgrades to Premium gets 30 + 12 = 42 days of Premium.
  carryOverRemaining?: boolean;
  note?: string | null;
}

/** Manually (admin) or programmatically (webhook) move a user onto a plan. */
export const assignPlan = async (userId: string, input: AssignPlanInput) => {
  const planId = input.planId ?? (input.planSlug ? await planIdForSlug(input.planSlug) : null);
  if (!planId) throw new Error('Unknown plan.');
  const status = input.status ?? 'active';

  // Carry over unused time from the current plan. Read it BEFORE the supersede
  // below wipes it. Never let an already-expired end shorten the new period.
  let periodEnd = input.current_period_end ?? null;
  if (input.carryOverRemaining && !input.current_period_end) {
    const { data: prev } = await supabase
      .from('subscriptions')
      .select('current_period_end')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing', 'past_due', 'manual'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const days = input.billing_interval === 'yearly' ? 365 : 30;
    const prevEnd = prev?.current_period_end ? new Date(prev.current_period_end).getTime() : 0;
    const base = Math.max(prevEnd, Date.now());
    periodEnd = new Date(base + days * 86_400_000).toISOString();
  }

  // Retire any existing live subscriptions first so a user only ever has ONE
  // active row (the signup `system` free row + each assignment used to stack up
  // and show the same user twice on the admin Subscriptions page). History is
  // kept as `superseded` rather than deleted.
  await supabase
    .from('subscriptions')
    .update({ status: 'superseded', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('status', ['active', 'trialing', 'past_due', 'manual']);

  await supabase.from('subscriptions').insert({
    user_id: userId,
    plan_id: planId,
    status,
    billing_interval: input.billing_interval ?? 'manual',
    provider: input.provider ?? 'manual',
    current_period_start: input.current_period_start ?? new Date().toISOString(),
    current_period_end: periodEnd,
    note: input.note ?? null
  });
  await supabase.from('users').update({ plan_id: planId, subscription_status: status }).eq('id', userId);
};

export const setStatus = async (userId: string, status: string) => {
  await supabase.from('users').update({ subscription_status: status }).eq('id', userId);
  const { data: latest } = await supabase.from('subscriptions').select('id').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (latest) await supabase.from('subscriptions').update({ status, updated_at: new Date().toISOString() }).eq('id', latest.id);
};

/** Extend the current period by N days (manual renewal for local payments). */
export const extendSubscription = async (userId: string, days: number) => {
  const { data: latest } = await supabase.from('subscriptions').select('id, current_period_end').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const base = latest?.current_period_end ? new Date(latest.current_period_end) : new Date();
  const end = new Date(Math.max(base.getTime(), Date.now()) + days * 86_400_000).toISOString();
  if (latest) await supabase.from('subscriptions').update({ current_period_end: end, status: 'active', updated_at: new Date().toISOString() }).eq('id', latest.id);
  await supabase.from('users').update({ subscription_status: 'active' }).eq('id', userId);
};

export const cancelSubscription = async (userId: string, atPeriodEnd = false) => {
  const { data: latest } = await supabase.from('subscriptions').select('id').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (latest) {
    await supabase
      .from('subscriptions')
      .update({ cancel_at_period_end: atPeriodEnd, cancelled_at: new Date().toISOString(), status: atPeriodEnd ? 'active' : 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', latest.id);
  }
  if (!atPeriodEnd) {
    const freeId = await planIdForSlug('free');
    await supabase.from('users').update({ subscription_status: 'cancelled', plan_id: freeId }).eq('id', userId);
  }
};

/** Expire subscriptions whose period has ended (call from a cron/admin trigger). */
export const expireDueSubscriptions = async (): Promise<number> => {
  const now = new Date().toISOString();
  const { data: due } = await supabase
    .from('subscriptions')
    .select('id, user_id')
    .lt('current_period_end', now)
    .in('status', ['active', 'trialing', 'past_due', 'manual']);
  const freeId = await planIdForSlug('free');
  for (const s of due ?? []) {
    await supabase.from('subscriptions').update({ status: 'expired', updated_at: now }).eq('id', s.id);
    await supabase.from('users').update({ subscription_status: 'expired', plan_id: freeId }).eq('id', s.user_id);
  }
  return (due ?? []).length;
};
