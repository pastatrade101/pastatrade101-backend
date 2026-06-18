import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { attachFeatures } from './plans.controller';
import { getUsage } from '../services/membership/usage.service';
import { assignPlan, cancelSubscription, extendSubscription, setStatus } from '../services/membership/subscription.service';

// ── Admin: Plans ─────────────────────────────────────────────────────────────

// GET /api/v1/admin/plans — all plans (incl. hidden / archived) + features.
export const adminListPlans = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from('plans').select('*').order('sort_order', { ascending: true });
  if (error) throw new AppError('Unable to load plans.', 500, [error]);
  return sendSuccess(res, 'Plans fetched successfully.', { items: await attachFeatures(data ?? []) });
});

// POST /api/v1/admin/plans
export const adminCreatePlan = asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('plans').insert(req.body).select('*').single();
  if (error) throw new AppError('Unable to create plan.', 500, [error]);
  return sendSuccess(res, 'Plan created successfully.', data, 201);
});

// GET /api/v1/admin/plans/:id
export const adminGetPlan = asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('plans').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw new AppError('Unable to load plan.', 500, [error]);
  if (!data) throw new AppError('Plan not found.', 404);
  const [withFeatures] = await attachFeatures([data]);
  return sendSuccess(res, 'Plan fetched successfully.', withFeatures);
});

// PUT /api/v1/admin/plans/:id
export const adminUpdatePlan = asyncHandler(async (req, res) => {
  const { error } = await supabase
    .from('plans')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) throw new AppError('Unable to update plan.', 500, [error]);
  return sendSuccess(res, 'Plan updated successfully.');
});

// DELETE /api/v1/admin/plans/:id — archive (never hard-delete; users may reference it).
export const adminArchivePlan = asyncHandler(async (req, res) => {
  const { error } = await supabase.from('plans').update({ is_archived: true, is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  if (error) throw new AppError('Unable to archive plan.', 500, [error]);
  return sendSuccess(res, 'Plan archived successfully.');
});

// POST /api/v1/admin/plans/:id/features — upsert a feature/limit row.
export const adminUpsertFeature = asyncHandler(async (req, res) => {
  const { feature_key, is_enabled, limit_value, metadata } = req.body;
  const { data, error } = await supabase
    .from('plan_features')
    .upsert(
      { plan_id: req.params.id, feature_key, is_enabled: is_enabled ?? false, limit_value: limit_value ?? null, metadata: metadata ?? null },
      { onConflict: 'plan_id,feature_key' }
    )
    .select('*')
    .single();
  if (error) throw new AppError('Unable to save feature.', 500, [error]);
  return sendSuccess(res, 'Feature saved successfully.', data, 201);
});

// PUT /api/v1/admin/plans/:id/features/:featureId
export const adminUpdateFeature = asyncHandler(async (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body.is_enabled === 'boolean') patch.is_enabled = req.body.is_enabled;
  if ('limit_value' in req.body) patch.limit_value = req.body.limit_value;
  if ('metadata' in req.body) patch.metadata = req.body.metadata;
  const { error } = await supabase.from('plan_features').update(patch).eq('id', req.params.featureId).eq('plan_id', req.params.id);
  if (error) throw new AppError('Unable to update feature.', 500, [error]);
  return sendSuccess(res, 'Feature updated successfully.');
});

// ── Admin: Users ─────────────────────────────────────────────────────────────

// GET /api/v1/admin/users?q=
export const adminListUsers = asyncHandler(async (req, res) => {
  let query = supabase
    .from('users')
    .select('id, email, full_name, role, is_active, subscription_status, created_at, last_login_at, plan:plans(slug, name)')
    .order('created_at', { ascending: false })
    .limit(200);
  const q = (req.query.q as string | undefined)?.trim();
  if (q) query = query.or(`email.ilike.%${q}%,full_name.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) throw new AppError('Unable to load users.', 500, [error]);
  return sendSuccess(res, 'Users fetched successfully.', { items: data ?? [] });
});

// GET /api/v1/admin/users/:id
export const adminGetUser = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, role, is_active, subscription_status, created_at, last_login_at, plan:plans(id, slug, name)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) throw new AppError('Unable to load user.', 500, [error]);
  if (!data) throw new AppError('User not found.', 404);
  const [usage, { data: subs }] = await Promise.all([
    getUsage(req.params.id),
    supabase.from('subscriptions').select('*').eq('user_id', req.params.id).order('created_at', { ascending: false }).limit(5)
  ]);
  return sendSuccess(res, 'User fetched successfully.', { ...data, usage, subscriptions: subs ?? [] });
});

// PUT /api/v1/admin/users/:id/plan — manual plan assignment (local payments / direct sales).
export const adminSetUserPlan = asyncHandler(async (req, res) => {
  const { plan_id, plan_slug, status, current_period_start, current_period_end, note, billing_interval } = req.body;
  await assignPlan(req.params.id, { planId: plan_id, planSlug: plan_slug, status, current_period_start, current_period_end, note, billing_interval, provider: 'manual' });
  return sendSuccess(res, 'User plan updated successfully.');
});

// PUT /api/v1/admin/users/:id/status — subscription status &/or suspend/reactivate.
export const adminSetUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body as { status: string };
  await setStatus(req.params.id, status);
  if (status === 'suspended') await supabase.from('users').update({ is_active: false }).eq('id', req.params.id);
  if (status === 'active') await supabase.from('users').update({ is_active: true }).eq('id', req.params.id);
  return sendSuccess(res, 'User status updated successfully.');
});

// POST /api/v1/admin/users/:id/extend-subscription
export const adminExtendSubscription = asyncHandler(async (req, res) => {
  const days = Number(req.body.days);
  if (!Number.isFinite(days) || days <= 0) throw new AppError('days must be a positive number.', 400);
  await extendSubscription(req.params.id, days);
  return sendSuccess(res, `Subscription extended by ${days} days.`);
});

// POST /api/v1/admin/users/:id/cancel-subscription
export const adminCancelSubscription = asyncHandler(async (req, res) => {
  await cancelSubscription(req.params.id, false);
  return sendSuccess(res, 'Subscription cancelled and user downgraded to Free.');
});

// ── Admin: Subscriptions visibility layer ────────────────────────────────────

// Supabase embeds can come back as an object or a single-element array.
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

// GET /api/v1/admin/subscriptions?status=&plan=&q=
export const adminListSubscriptions = asyncHandler(async (req, res) => {
  let query = supabase
    .from('subscriptions')
    .select(
      'id, user_id, status, billing_interval, provider, current_period_start, current_period_end, trial_end, cancel_at_period_end, cancelled_at, note, created_at, updated_at, user:users(email, full_name, role, is_active), plan:plans(slug, name)'
    )
    .order('created_at', { ascending: false })
    .limit(300);
  if (req.query.status && req.query.status !== 'all') query = query.eq('status', req.query.status as string);

  const { data, error } = await query;
  if (error) throw new AppError('Unable to load subscriptions.', 500, [error]);

  let items = data ?? [];
  const planSlug = req.query.plan as string | undefined;
  if (planSlug && planSlug !== 'all') items = items.filter((s) => one<{ slug: string }>(s.plan as never)?.slug === planSlug);
  const q = (req.query.q as string | undefined)?.trim().toLowerCase();
  if (q)
    items = items.filter((s) => {
      const u = one<{ email: string; full_name: string | null }>(s.user as never);
      return (u?.email ?? '').toLowerCase().includes(q) || (u?.full_name ?? '').toLowerCase().includes(q);
    });

  return sendSuccess(res, 'Subscriptions fetched successfully.', { items });
});

// GET /api/v1/admin/subscriptions/:id — record + that user's full history + recent events.
export const adminGetSubscription = asyncHandler(async (req, res) => {
  const { data: sub, error } = await supabase
    .from('subscriptions')
    .select('*, user:users(id, email, full_name, role, is_active, subscription_status), plan:plans(slug, name)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) throw new AppError('Unable to load subscription.', 500, [error]);
  if (!sub) throw new AppError('Subscription not found.', 404);

  const userId = one<{ id: string }>(sub.user as never)?.id ?? (sub.user_id as string);
  const [{ data: history }, { data: events }] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('id, status, billing_interval, provider, current_period_start, current_period_end, cancel_at_period_end, note, created_at, plan:plans(slug, name)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    supabase.from('payment_events').select('id, provider, event_type, status, reviewed, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20)
  ]);

  return sendSuccess(res, 'Subscription fetched.', { subscription: sub, history: history ?? [], events: events ?? [] });
});

// ── Admin: Payment events visibility layer ───────────────────────────────────

// GET /api/v1/admin/payments?provider=&status=&event_type=&q=
export const adminListPayments = asyncHandler(async (req, res) => {
  let query = supabase
    .from('payment_events')
    .select('id, user_id, provider, event_type, status, event_payload, reviewed, reviewed_at, created_at, user:users(email, full_name)')
    .order('created_at', { ascending: false })
    .limit(300);
  if (req.query.provider && req.query.provider !== 'all') query = query.eq('provider', req.query.provider as string);
  if (req.query.status && req.query.status !== 'all') query = query.eq('status', req.query.status as string);
  if (req.query.event_type && req.query.event_type !== 'all') query = query.eq('event_type', req.query.event_type as string);

  const { data, error } = await query;
  if (error) throw new AppError('Unable to load payment events.', 500, [error]);

  let items = data ?? [];
  const q = (req.query.q as string | undefined)?.trim().toLowerCase();
  if (q)
    items = items.filter((e) => {
      const u = one<{ email: string; full_name: string | null }>(e.user as never);
      return (u?.email ?? '').toLowerCase().includes(q) || (u?.full_name ?? '').toLowerCase().includes(q);
    });

  // Distinct provider / status / event_type for the filter dropdowns.
  const distinct = (key: 'provider' | 'status' | 'event_type') => [...new Set((data ?? []).map((e) => e[key]).filter(Boolean))] as string[];
  return sendSuccess(res, 'Payment events fetched successfully.', {
    items,
    facets: { providers: distinct('provider'), statuses: distinct('status'), event_types: distinct('event_type') }
  });
});

// ── Admin: Upgrade follow-ups (payment_attempts) ─────────────────────────────

// GET /api/v1/admin/payment-attempts?status=&followup=&q=
export const adminListPaymentAttempts = asyncHandler(async (req, res) => {
  let query = supabase
    .from('payment_attempts')
    .select(
      'id, provider, reference, plan_slug, billing_interval, amount, currency, status, cancel_reason, followup_status, followup_note, created_at, updated_at, user:users(email, full_name)'
    )
    .order('created_at', { ascending: false })
    .limit(300);
  if (req.query.status && req.query.status !== 'all') query = query.eq('status', req.query.status as string);
  if (req.query.followup && req.query.followup !== 'all') query = query.eq('followup_status', req.query.followup as string);

  const { data, error } = await query;
  if (error) throw new AppError('Unable to load payment attempts.', 500, [error]);

  let items = data ?? [];
  const q = (req.query.q as string | undefined)?.trim().toLowerCase();
  if (q)
    items = items.filter((a) => {
      const u = one<{ email: string; full_name: string | null }>(a.user as never);
      return (u?.email ?? '').toLowerCase().includes(q) || (u?.full_name ?? '').toLowerCase().includes(q);
    });

  return sendSuccess(res, 'Payment attempts fetched successfully.', { items });
});

// PUT /api/v1/admin/payment-attempts/:id/followup
export const adminUpdateAttemptFollowup = asyncHandler(async (req, res) => {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (req.body.followup_status) patch.followup_status = req.body.followup_status;
  if (typeof req.body.followup_note === 'string') patch.followup_note = req.body.followup_note.trim();
  const { error } = await supabase.from('payment_attempts').update(patch).eq('id', req.params.id);
  if (error) throw new AppError('Unable to update follow-up.', 500, [error]);
  return sendSuccess(res, 'Follow-up updated.');
});

// PUT /api/v1/admin/payments/:id/reviewed — toggle the admin review flag.
export const adminMarkPaymentReviewed = asyncHandler(async (req, res) => {
  const reviewed = req.body.reviewed !== false;
  const { error } = await supabase
    .from('payment_events')
    .update({ reviewed, reviewed_at: reviewed ? new Date().toISOString() : null })
    .eq('id', req.params.id);
  if (error) throw new AppError('Unable to update payment event.', 500, [error]);
  return sendSuccess(res, reviewed ? 'Marked as reviewed.' : 'Marked as unreviewed.');
});
