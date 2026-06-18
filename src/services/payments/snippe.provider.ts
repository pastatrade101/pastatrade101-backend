import crypto from 'crypto';
import { snippe } from '../../config/env';
import { AppError } from '../../utils/api-response';
import type { CheckoutInput, CheckoutResult, NormalizedEvent, PaymentProvider } from './provider';

// Snippe adapter (https://docs.snippe.sh, API version 2026-01-25). Uses hosted
// Payment Sessions so Pastatrade never handles card / mobile-money credentials.

interface SnippeSessionResponse {
  code?: number;
  message?: string;
  error?: string;
  data?: { reference?: string; checkout_url?: string; status?: string; message?: string };
}

interface SnippeEvent {
  id?: string;
  type?: string;
  data?: {
    reference?: string;
    status?: string;
    amount?: { value?: number; currency?: string };
    metadata?: Record<string, unknown>;
  };
}

export const snippeProvider: PaymentProvider = {
  name: 'snippe',

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const amount = Math.round(input.amount);
    // Snippe's minimum is 500 (TZS). A plan priced in USD (e.g. 49) trips this —
    // surface a clear message instead of a raw provider error.
    if (amount < 500) {
      throw new AppError(
        `Snippe requires a minimum amount of 500. This plan is ${amount} ${input.currency} — price it in TZS to sell it via Snippe.`,
        400
      );
    }

    const payload: Record<string, unknown> = {
      amount,
      currency: input.currency,
      customer: { name: input.customer.name, email: input.customer.email, phone: input.customer.phone },
      redirect_url: input.successUrl,
      description: `Pastatrade ${input.planName} (${input.interval})`,
      // Echoed back on the webhook so we know who/what to activate.
      metadata: { user_id: input.userId, plan_slug: input.planSlug, interval: input.interval, kind: 'subscription' },
      expires_in: 3600
    };
    // Snippe rejects non-public webhook URLs. In dev (http://localhost) omit it
    // and rely on the webhook configured in the Snippe dashboard.
    if (snippe.webhookUrl.startsWith('https://')) payload.webhook_url = snippe.webhookUrl;

    let res: Awaited<ReturnType<typeof fetch>>;
    let text = '';
    try {
      res = await fetch(`${snippe.baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${snippe.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      text = await res.text();
    } catch (err) {
      console.error('[snippe] network error creating session:', err);
      throw new AppError('Could not reach Snippe to start checkout.', 502, [String(err)]);
    }

    let json: SnippeSessionResponse = {};
    try {
      json = text ? (JSON.parse(text) as SnippeSessionResponse) : {};
    } catch {
      /* non-JSON response body */
    }

    if (!res.ok || !json.data?.checkout_url) {
      const detail = json.message || json.error || json.data?.message || text || `HTTP ${res.status}`;
      console.error(`[snippe] session create failed (${res.status}) ${snippe.baseUrl}/api/v1/sessions:`, detail);
      throw new AppError(`Snippe checkout failed (${res.status}): ${detail}`, 502, [json.data ?? text]);
    }

    return { provider: 'snippe', reference: json.data.reference ?? '', checkout_url: json.data.checkout_url };
  },

  verifyWebhook(rawBody, headers): boolean {
    const signature = headers['x-webhook-signature'];
    const timestamp = headers['x-webhook-timestamp'];
    if (!snippe.webhookSecret || !signature || !timestamp) return false;

    // Reject events older than 5 minutes (replay protection).
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    const expected = crypto.createHmac('sha256', snippe.webhookSecret).update(`${timestamp}.${body}`).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  parseEvent(body: unknown): NormalizedEvent {
    const e = (body ?? {}) as SnippeEvent;
    return {
      id: e.id ?? '',
      type: e.type ?? 'unknown',
      status: e.data?.status ?? '',
      reference: e.data?.reference ?? '',
      amount: e.data?.amount?.value ?? null,
      currency: e.data?.amount?.currency ?? null,
      metadata: (e.data?.metadata ?? {}) as Record<string, unknown>,
      raw: body
    };
  }
};
