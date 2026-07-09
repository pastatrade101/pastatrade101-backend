import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { getPaymentProvider } from '../services/payments';
import { assignPlan } from '../services/membership/subscription.service';

// POST /api/v1/payments/webhook/snippe — public; authenticated by HMAC signature.
// Verifies, records to payment_events, and on payment.completed activates the
// subscription. Idempotent on the provider event id.
export const snippeWebhook = asyncHandler(async (req: Request, res: Response) => {
  const provider = getPaymentProvider();
  if (!provider || provider.name !== 'snippe') return res.status(503).send('Payments not configured');

  const headers = {
    'x-webhook-signature': req.header('x-webhook-signature') ?? undefined,
    'x-webhook-timestamp': req.header('x-webhook-timestamp') ?? undefined
  };
  const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  if (!provider.verifyWebhook(raw, headers)) return res.status(400).send('Invalid signature');

  const event = provider.parseEvent(req.body);

  // Idempotency — don't double-process a redelivered event.
  if (event.id) {
    const { data: existing } = await supabase.from('payment_events').select('id').eq('provider', 'snippe').eq('event_payload->>id', event.id).maybeSingle();
    if (existing) return res.status(200).send('OK');
  }

  const userId = (event.metadata.user_id as string | undefined) ?? null;
  const planSlug = event.metadata.plan_slug as string | undefined;
  await supabase.from('payment_events').insert({
    user_id: userId,
    provider: 'snippe',
    event_type: event.type,
    status: event.status || null,
    event_payload: event.raw
  });

  // Advance the matching follow-up attempt (Snippe's webhook reference differs
  // from the session reference, so match the user's latest pending attempt).
  const attemptStatus =
    event.type === 'payment.completed'
      ? 'completed'
      : event.type === 'payment.failed'
        ? 'failed'
        : event.type === 'payment.voided'
          ? 'cancelled'
          : event.type === 'payment.expired'
            ? 'expired'
            : null;
  if (attemptStatus && userId) {
    let q = supabase.from('payment_attempts').select('id').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1);
    if (planSlug) q = q.eq('plan_slug', planSlug);
    const { data: attempt } = await q.maybeSingle();
    if (attempt) await supabase.from('payment_attempts').update({ status: attemptStatus, updated_at: new Date().toISOString() }).eq('id', attempt.id);
  }

  if (event.type === 'payment.completed' && userId) {
    const interval = event.metadata.interval === 'yearly' ? 'yearly' : 'monthly';
    if (planSlug) {
      await assignPlan(userId, {
        planSlug,
        status: 'active',
        provider: 'snippe',
        billing_interval: interval,
        current_period_start: new Date().toISOString(),
        // Add any unused time from the current plan onto the new period.
        carryOverRemaining: true,
        note: `Activated via Snippe (${event.reference})`
      });
    }
  }

  return res.status(200).send('OK');
});
