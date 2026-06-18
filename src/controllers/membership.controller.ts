import { supabase } from '../config/supabase';
import { allowedOrigins } from '../config/env';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { resolveUserAccess } from '../services/membership/plan-access';
import { getUsage } from '../services/membership/usage.service';
import { cancelSubscription } from '../services/membership/subscription.service';
import { getPaymentProvider } from '../services/payments';

// GET /api/v1/me/features — the plan access summary the frontend gates on.
export const getMyFeatures = asyncHandler(async (req, res) => {
  const access = await resolveUserAccess(req.user!.sub);
  const usage = await getUsage(req.user!.sub);
  const { data: prof } = await supabase.from('users').select('phone').eq('id', req.user!.sub).maybeSingle();
  return sendSuccess(res, 'Plan access fetched successfully.', {
    plan: access.plan.slug,
    plan_name: access.plan.name,
    badge: access.plan.badge,
    status: access.status,
    is_admin: access.isAdmin,
    phone: prof?.phone ?? null,
    features: access.features,
    limits: access.limits,
    usage: { watchlist_items: usage.watchlist_items, alerts: usage.alerts }
  });
});

// GET /api/v1/me/plan
export const getMyPlan = asyncHandler(async (req, res) => {
  const access = await resolveUserAccess(req.user!.sub);
  return sendSuccess(res, 'Plan fetched successfully.', { ...access.plan, status: access.status });
});

// GET /api/v1/me/usage
export const getMyUsage = asyncHandler(async (req, res) => {
  const access = await resolveUserAccess(req.user!.sub);
  const usage = await getUsage(req.user!.sub);
  return sendSuccess(res, 'Usage fetched successfully.', { usage, limits: access.limits });
});

// POST /api/v1/me/upgrade — starts a hosted checkout when a payment provider is
// configured; otherwise records intent for manual admin activation. Users can
// NEVER self-grant a plan: activation only happens via webhook or admin.
export const requestUpgrade = asyncHandler(async (req, res) => {
  const { plan_slug, billing_interval, phone } = req.body as { plan_slug: string; billing_interval?: 'monthly' | 'yearly'; phone?: string };
  const interval = billing_interval === 'yearly' ? 'yearly' : 'monthly';

  const { data: plan } = await supabase.from('plans').select('id, name, monthly_price, yearly_price, currency').eq('slug', plan_slug).maybeSingle();
  if (!plan) throw new AppError('Plan not found.', 404);

  const amount = interval === 'yearly' ? Number(plan.yearly_price) : Number(plan.monthly_price);
  const provider = getPaymentProvider();

  // Paid plan + provider available → hosted checkout.
  if (provider && amount > 0) {
    const { data: user } = await supabase.from('users').select('full_name, email, phone').eq('id', req.user!.sub).maybeSingle();
    // Use the phone the user just entered, else their saved one. Persist it for next time.
    const phoneNumber = phone?.trim() || user?.phone || undefined;
    if (phone?.trim() && phone.trim() !== user?.phone) {
      await supabase.from('users').update({ phone: phone.trim() }).eq('id', req.user!.sub);
    }
    const successUrl = `${allowedOrigins[0] ?? 'http://localhost:5173'}/app/account?upgrade=success`;
    const checkout = await provider.createCheckout({
      userId: req.user!.sub,
      planSlug: plan_slug,
      planName: plan.name,
      amount,
      currency: plan.currency,
      interval,
      customer: { name: user?.full_name ?? undefined, email: user?.email ?? req.user!.email, phone: phoneNumber },
      successUrl
    });
    await supabase.from('payment_events').insert({
      user_id: req.user!.sub,
      provider: provider.name,
      event_type: 'checkout_created',
      status: 'pending',
      event_payload: { reference: checkout.reference, plan_slug, interval, amount, currency: plan.currency }
    });
    // Track the attempt so admins can follow up if it's abandoned / fails.
    await supabase.from('payment_attempts').insert({
      user_id: req.user!.sub,
      provider: provider.name,
      reference: checkout.reference,
      plan_slug,
      billing_interval: interval,
      amount,
      currency: plan.currency,
      status: 'pending'
    });
    return sendSuccess(res, 'Checkout created.', { checkout_url: checkout.checkout_url, reference: checkout.reference, status: 'pending' });
  }

  // No provider (or free plan) → manual activation path.
  await supabase.from('payment_events').insert({
    user_id: req.user!.sub,
    provider: 'manual',
    event_type: 'upgrade_request',
    status: 'pending',
    event_payload: { plan_slug, interval }
  });
  return sendSuccess(res, `Upgrade request received for ${plan.name}. An admin will activate your subscription shortly.`, { plan_slug, status: 'pending' });
});

// POST /api/v1/me/cancel-subscription — downgrade to free at period end.
export const cancelMySubscription = asyncHandler(async (req, res) => {
  await cancelSubscription(req.user!.sub, true);
  return sendSuccess(res, 'Subscription will be cancelled at the end of the current period.');
});

// GET /api/v1/me/payment-attempts/pending — latest unfinished upgrade attempt
// (recent), so the account page can prompt "did you complete payment?".
export const getMyPendingAttempt = asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('payment_attempts')
    .select('id, plan_slug, billing_interval, amount, currency, status, created_at')
    .eq('user_id', req.user!.sub)
    .eq('status', 'pending')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return sendSuccess(res, 'Pending attempt fetched.', { attempt: data ?? null });
});

// POST /api/v1/me/payment-attempts/cancel — user abandoned checkout; capture why.
export const cancelMyAttempt = asyncHandler(async (req, res) => {
  const reason = (req.body.reason as string | undefined)?.trim() || null;
  const { data: attempt } = await supabase
    .from('payment_attempts')
    .select('id')
    .eq('user_id', req.user!.sub)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!attempt) return sendSuccess(res, 'No pending attempt to cancel.');
  await supabase.from('payment_attempts').update({ status: 'cancelled', cancel_reason: reason, updated_at: new Date().toISOString() }).eq('id', attempt.id);
  return sendSuccess(res, 'Thanks — we’ve noted that. An admin may follow up to help.');
});
