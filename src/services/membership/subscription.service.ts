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
  note?: string | null;
}

/** Manually (admin) or programmatically (webhook) move a user onto a plan. */
export const assignPlan = async (userId: string, input: AssignPlanInput) => {
  const planId = input.planId ?? (input.planSlug ? await planIdForSlug(input.planSlug) : null);
  if (!planId) throw new Error('Unknown plan.');
  const status = input.status ?? 'active';

  await supabase.from('subscriptions').insert({
    user_id: userId,
    plan_id: planId,
    status,
    billing_interval: input.billing_interval ?? 'manual',
    provider: input.provider ?? 'manual',
    current_period_start: input.current_period_start ?? new Date().toISOString(),
    current_period_end: input.current_period_end ?? null,
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
