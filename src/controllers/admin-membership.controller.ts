import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { attachFeatures } from './plans.controller';
import { getUsage } from '../services/membership/usage.service';
import { assignPlan, cancelSubscription, extendSubscription, setStatus } from '../services/membership/subscription.service';
import { auditLog, listAuditForUser } from '../services/membership/audit.service';

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

// Plan slug → numeric limits (max_watchlist_items / max_alerts), for usage X/Y.
const loadPlanLimits = async (): Promise<Map<string, { wl: number | null; al: number | null }>> => {
  const { data } = await supabase.from('plan_features').select('limit_value, feature_key, plan:plans(slug)').in('feature_key', ['max_watchlist_items', 'max_alerts']);
  const map = new Map<string, { wl: number | null; al: number | null }>();
  for (const row of data ?? []) {
    const slug = one<{ slug: string }>(row.plan as never)?.slug;
    if (!slug) continue;
    const cur = map.get(slug) ?? { wl: null, al: null };
    if (row.feature_key === 'max_watchlist_items') cur.wl = row.limit_value as number | null;
    else cur.al = row.limit_value as number | null;
    map.set(slug, cur);
  }
  return map;
};

interface UserRow {
  id: string;
  plan?: unknown;
  [k: string]: unknown;
}

// Batch-enrich a page of users with subscription period, usage, latest payment
// and follow-up status — a handful of queries for the whole page (not per user).
const enrichUsers = async (rows: UserRow[], planLimits: Map<string, { wl: number | null; al: number | null }>) => {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];

  const [subsRes, peRes, paRes, wlRes] = await Promise.all([
    supabase.from('subscriptions').select('user_id, status, billing_interval, provider, current_period_start, current_period_end, cancel_at_period_end, created_at').in('user_id', ids).order('created_at', { ascending: false }),
    supabase.from('payment_events').select('user_id, provider, status, event_type, created_at').in('user_id', ids).order('created_at', { ascending: false }),
    supabase.from('payment_attempts').select('user_id, followup_status, status, created_at').in('user_id', ids).order('created_at', { ascending: false }),
    supabase.from('watchlists').select('id, user_id').in('user_id', ids)
  ]);

  const firstByUser = <T extends { user_id: string }>(arr: T[] | null): Map<string, T> => {
    const m = new Map<string, T>();
    for (const x of arr ?? []) if (!m.has(x.user_id)) m.set(x.user_id, x);
    return m;
  };
  const subBy = firstByUser(subsRes.data as { user_id: string; [k: string]: unknown }[] | null);
  const peBy = firstByUser(peRes.data as { user_id: string; [k: string]: unknown }[] | null);
  const paBy = firstByUser(paRes.data as { user_id: string; [k: string]: unknown }[] | null);

  // Usage (watchlist items + alerts) per user.
  const wls = (wlRes.data ?? []) as { id: string; user_id: string }[];
  const listToUser = new Map(wls.map((w) => [w.id, w.user_id]));
  const itemCount = new Map<string, number>();
  const alertCount = new Map<string, number>();
  const itemToUser = new Map<string, string>();
  const allListIds = wls.map((w) => w.id);
  if (allListIds.length) {
    const { data: items } = await supabase.from('watchlist_items').select('id, watchlist_id').in('watchlist_id', allListIds);
    const allItemIds: string[] = [];
    for (const it of (items ?? []) as { id: string; watchlist_id: string }[]) {
      const u = listToUser.get(it.watchlist_id);
      if (!u) continue;
      itemToUser.set(it.id, u);
      itemCount.set(u, (itemCount.get(u) ?? 0) + 1);
      allItemIds.push(it.id);
    }
    if (allItemIds.length) {
      const { data: alerts } = await supabase.from('watchlist_alerts').select('watchlist_item_id').in('watchlist_item_id', allItemIds);
      for (const a of (alerts ?? []) as { watchlist_item_id: string }[]) {
        const u = itemToUser.get(a.watchlist_item_id);
        if (u) alertCount.set(u, (alertCount.get(u) ?? 0) + 1);
      }
    }
  }

  const now = Date.now();
  return rows.map((r) => {
    const sub = subBy.get(r.id) as Record<string, unknown> | undefined;
    const slug = one<{ slug: string }>(r.plan as never)?.slug ?? 'free';
    const lim = planLimits.get(slug) ?? { wl: null, al: null };
    const periodEnd = (sub?.current_period_end as string | null) ?? null;
    const pe = peBy.get(r.id) as Record<string, unknown> | undefined;
    const pa = paBy.get(r.id) as Record<string, unknown> | undefined;
    return {
      ...r,
      subscription: sub
        ? {
            status: sub.status,
            billing_interval: sub.billing_interval,
            provider: sub.provider,
            current_period_start: sub.current_period_start,
            current_period_end: periodEnd,
            cancel_at_period_end: sub.cancel_at_period_end,
            days_remaining: periodEnd ? Math.ceil((Date.parse(periodEnd) - now) / 86_400_000) : null
          }
        : null,
      usage: { watchlist_items: itemCount.get(r.id) ?? 0, alerts: alertCount.get(r.id) ?? 0 },
      limits: { max_watchlist_items: lim.wl, max_alerts: lim.al },
      latest_payment: pe ? { provider: pe.provider, status: pe.status, event_type: pe.event_type, created_at: pe.created_at } : null,
      followup_status: (pa?.followup_status as string | null) ?? null
    };
  });
};

// GET /api/v1/admin/users?search=&plan=&status=&role=&joined=&page=&limit=
export const adminListUsers = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
  const search = ((req.query.search ?? req.query.q) as string | undefined)?.trim();
  const planSlug = req.query.plan as string | undefined;
  const status = req.query.status as string | undefined;
  const role = req.query.role as string | undefined;
  const joined = req.query.joined as string | undefined; // today | 7d | 30d

  const { data: plans } = await supabase.from('plans').select('id, slug');
  const planIdBySlug = new Map((plans ?? []).map((p) => [p.slug as string, p.id as string]));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyFilters = (q: any) => {
    if (search) q = q.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
    if (planSlug && planSlug !== 'all') q = q.eq('plan_id', planIdBySlug.get(planSlug) ?? '00000000-0000-0000-0000-000000000000');
    if (status && status !== 'all') q = q.eq('subscription_status', status);
    if (role && role !== 'all') q = q.eq('role', role);
    if (joined && joined !== 'all') {
      const days = joined === 'today' ? 1 : joined === '7d' ? 7 : joined === '30d' ? 30 : 0;
      if (days) q = q.gte('created_at', new Date(Date.now() - days * 86_400_000).toISOString());
    }
    return q;
  };

  const { count } = await applyFilters(supabase.from('users').select('id', { count: 'exact', head: true }));
  const total = count ?? 0;

  const { data, error } = await applyFilters(
    supabase
      .from('users')
      .select('id, email, full_name, role, is_active, subscription_status, created_at, last_login_at, plan_id, plan:plans(slug, name)')
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, (page - 1) * limit + limit - 1)
  );
  if (error) throw new AppError('Unable to load users.', 500, [error]);

  const items = await enrichUsers((data ?? []) as UserRow[], await loadPlanLimits());
  return sendSuccess(res, 'Users fetched successfully.', { items, total, page, limit, total_pages: Math.max(1, Math.ceil(total / limit)) });
});

// GET /api/v1/admin/users/metrics — summary cards.
export const adminUserMetrics = asyncHandler(async (_req, res) => {
  const { data: plans } = await supabase.from('plans').select('id, slug');
  const idBySlug = new Map((plans ?? []).map((p) => [p.slug as string, p.id as string]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headCount = async (build: (q: any) => any): Promise<number> => {
    const { count } = await build(supabase.from('users').select('id', { count: 'exact', head: true }));
    return count ?? 0;
  };
  const planCount = async (slug: string): Promise<number> => {
    const id = idBySlug.get(slug);
    if (!id) return 0;
    const { count } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('plan_id', id);
    return count ?? 0;
  };
  const [total, active, free, mid, premium, expired, cancelled, suspended] = await Promise.all([
    headCount((q) => q),
    headCount((q) => q.eq('subscription_status', 'active')),
    planCount('free'),
    planCount('mid'),
    planCount('premium'),
    headCount((q) => q.eq('subscription_status', 'expired')),
    headCount((q) => q.eq('subscription_status', 'cancelled')),
    headCount((q) => q.eq('subscription_status', 'suspended'))
  ]);
  const { count: followupsDue } = await supabase.from('payment_attempts').select('id', { count: 'exact', head: true }).in('followup_status', ['open', 'contacted']);
  const { count: paymentsPending } = await supabase.from('payment_events').select('id', { count: 'exact', head: true }).eq('reviewed', false);
  return sendSuccess(res, 'User metrics fetched.', {
    total_users: total,
    active,
    free,
    mid,
    premium,
    expired,
    cancelled,
    suspended,
    expired_cancelled: expired + cancelled,
    followups_due: followupsDue ?? 0,
    payments_pending: paymentsPending ?? 0
  });
});

// GET /api/v1/admin/users/:id — full profile + subscription history, usage, payments, audit, follow-ups.
export const adminGetUser = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, role, is_active, subscription_status, created_at, last_login_at, plan:plans(id, slug, name)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new AppError('Unable to load user.', 500, [error]);
  if (!data) throw new AppError('User not found.', 404);
  const [usage, { data: subs }, { data: events }, audit, { data: attempts }] = await Promise.all([
    getUsage(id),
    supabase.from('subscriptions').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(5),
    supabase.from('payment_events').select('id, provider, event_type, status, reviewed, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(10),
    listAuditForUser(id),
    supabase.from('payment_attempts').select('id, provider, plan_slug, amount, currency, status, followup_status, followup_note, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(10)
  ]);
  return sendSuccess(res, 'User fetched successfully.', { ...data, usage, subscriptions: subs ?? [], payments: events ?? [], audit, followups: attempts ?? [] });
});

// POST /api/v1/admin/users/:id/note — internal admin note (recorded in the audit trail).
export const adminAddUserNote = asyncHandler(async (req, res) => {
  const note = (req.body.note as string | undefined)?.trim();
  if (!note) throw new AppError('Note is required.', 400);
  await auditLog(req.user!.sub, 'note', req.params.id, null, null, note);
  return sendSuccess(res, 'Note added.');
});

// Current plan slug + subscription status, for audit before/after values.
const userPlanState = async (id: string): Promise<{ plan: string | null; status: string | null }> => {
  const { data } = await supabase.from('users').select('subscription_status, plan:plans(slug)').eq('id', id).maybeSingle();
  return { plan: one<{ slug: string }>(data?.plan as never)?.slug ?? null, status: (data?.subscription_status as string | null) ?? null };
};

// PUT /api/v1/admin/users/:id/plan — manual plan assignment (local payments / direct sales).
export const adminSetUserPlan = asyncHandler(async (req, res) => {
  const { plan_id, plan_slug, status, current_period_start, current_period_end, note, billing_interval } = req.body;
  const before = await userPlanState(req.params.id);
  await assignPlan(req.params.id, { planId: plan_id, planSlug: plan_slug, status, current_period_start, current_period_end, note, billing_interval, provider: 'manual' });
  await auditLog(req.user!.sub, 'plan_change', req.params.id, before, { plan: plan_slug ?? plan_id, status: status ?? null, billing_interval: billing_interval ?? null, current_period_end: current_period_end ?? null }, note);
  return sendSuccess(res, 'User plan updated successfully.');
});

// PUT /api/v1/admin/users/:id/status — subscription status &/or suspend/reactivate.
export const adminSetUserStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body as { status: string; note?: string };
  const before = await userPlanState(req.params.id);
  await setStatus(req.params.id, status);
  if (status === 'suspended') await supabase.from('users').update({ is_active: false }).eq('id', req.params.id);
  if (status === 'active') await supabase.from('users').update({ is_active: true }).eq('id', req.params.id);
  const action = status === 'suspended' ? 'suspend' : status === 'active' && before.status === 'suspended' ? 'reactivate' : 'status_change';
  await auditLog(req.user!.sub, action, req.params.id, { status: before.status }, { status }, note);
  return sendSuccess(res, 'User status updated successfully.');
});

// POST /api/v1/admin/users/:id/extend-subscription
export const adminExtendSubscription = asyncHandler(async (req, res) => {
  const days = Number(req.body.days);
  if (!Number.isFinite(days) || days <= 0) throw new AppError('days must be a positive number.', 400);
  await extendSubscription(req.params.id, days);
  await auditLog(req.user!.sub, 'extend', req.params.id, null, { days }, (req.body.note as string | undefined)?.trim() || null);
  return sendSuccess(res, `Subscription extended by ${days} days.`);
});

// POST /api/v1/admin/users/:id/cancel-subscription
export const adminCancelSubscription = asyncHandler(async (req, res) => {
  const before = await userPlanState(req.params.id);
  await cancelSubscription(req.params.id, false);
  await auditLog(req.user!.sub, 'cancel', req.params.id, before, { plan: 'free', status: 'cancelled' }, (req.body?.note as string | undefined)?.trim() || null);
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

  // One row per user — the latest subscription (data is ordered created_at desc).
  // Historical/superseded rows remain visible in the per-subscription drawer.
  const seen = new Set<string>();
  items = items.filter((s) => {
    const uid = s.user_id as string;
    if (seen.has(uid)) return false;
    seen.add(uid);
    return true;
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

// ── Admin: Revenue (Snippe) ──────────────────────────────────────────────────
// GET /api/v1/admin/revenue — revenue analytics built from COMPLETED payment
// attempts (written by both the Snippe webhook and the pull-based verify
// fallback, so it covers every confirmed payment regardless of path).
export const adminRevenue = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('payment_attempts')
    .select('id, provider, reference, plan_slug, billing_interval, amount, currency, created_at, user:users(email, full_name)')
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) throw new AppError('Unable to load revenue.', 500, [error]);

  const rows = (data ?? []).filter((r) => r.amount != null);
  const amt = (r: { amount: unknown }) => Number(r.amount) || 0;

  // Dominant currency (Snippe is TZS today; stays correct if that ever changes).
  const byCurrency = new Map<string, number>();
  for (const r of rows) byCurrency.set(r.currency ?? 'TZS', (byCurrency.get(r.currency ?? 'TZS') ?? 0) + 1);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'TZS';

  const now = new Date();
  const dayMs = 86_400_000;
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const sum = (from: Date, to?: Date) =>
    rows.reduce((s, r) => {
      const t = new Date(r.created_at as string);
      return t >= from && (!to || t < to) ? s + amt(r) : s;
    }, 0);

  const total = rows.reduce((s, r) => s + amt(r), 0);
  const this_month = sum(startOfMonth);
  const last_month = sum(startOfLastMonth, startOfMonth);
  const growth_pct = last_month > 0 ? Math.round(((this_month - last_month) / last_month) * 100) : null;

  // Last 12 calendar months for the chart.
  const monthly: { month: string; total: number; count: number }[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const inMonth = rows.filter((r) => {
      const t = new Date(r.created_at as string);
      return t >= from && t < to;
    });
    monthly.push({ month: from.toISOString().slice(0, 7), total: inMonth.reduce((s, r) => s + amt(r), 0), count: inMonth.length });
  }

  const groupBy = (key: 'plan_slug' | 'billing_interval') => {
    const m = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const k = (r[key] as string) ?? 'unknown';
      const g = m.get(k) ?? { total: 0, count: 0 };
      g.total += amt(r);
      g.count += 1;
      m.set(k, g);
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.total - a.total);
  };

  return sendSuccess(res, 'Revenue fetched successfully.', {
    currency,
    summary: {
      total,
      count: rows.length,
      avg: rows.length ? Math.round(total / rows.length) : 0,
      today: sum(new Date(now.getTime() - ((now.getTime() % dayMs))), undefined),
      last_7d: sum(new Date(now.getTime() - 7 * dayMs)),
      last_30d: sum(new Date(now.getTime() - 30 * dayMs)),
      this_month,
      last_month,
      growth_pct
    },
    monthly,
    by_plan: groupBy('plan_slug'),
    by_interval: groupBy('billing_interval'),
    transactions: rows.slice(0, 100)
  });
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
