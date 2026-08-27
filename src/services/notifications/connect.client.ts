import { env } from '../../config/env';

// connect.client — the only place that talks to Makutano Connect.
//
// Connect owns everything WhatsApp: the number, the encrypted Meta token, the
// approved templates, the 24-hour window and the opt-out list. Pastatrade owns
// who its members are and what it wants to say. This file is the seam, and it is
// deliberately thin — no retries that could double-send, no queue of its own.
//
// Inert without CONNECT_API_KEY, exactly like the payment and AI providers: no
// key, no call, no error.

export interface TemplateComponent {
  type: 'body' | 'header' | 'button';
  parameters?: Array<{ type: 'text'; text: string }>;
  sub_type?: string;
  index?: string;
}

export interface SendTemplateInput {
  to: string;
  templateName: string;
  language?: string;
  components?: TemplateComponent[];
  /** Same key twice = one message. Connect enforces this server-side. */
  idempotencyKey: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  /** Set when Connect refused: policy, entitlement, or an unknown template. */
  code?: string;
  error?: string;
}

export const isConnectConfigured = (): boolean => Boolean(env.CONNECT_API_KEY);

const post = async (path: string, body: unknown, idempotencyKey?: string): Promise<Response> =>
  fetch(`${env.CONNECT_API_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.CONNECT_API_KEY}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    },
    body: JSON.stringify(body)
  });

/**
 * Send one approved template to one number.
 *
 * Business-initiated messages — which every one of ours is — may only be
 * templates. Connect will reject free text outside a customer's 24-hour window,
 * and that rejection is the correct behaviour, not a bug to work around.
 */
export const sendTemplate = async (input: SendTemplateInput): Promise<SendResult> => {
  if (!isConnectConfigured()) return { ok: false, code: 'NOT_CONFIGURED', error: 'CONNECT_API_KEY is not set' };

  try {
    const res = await post(
      '/api/v1/whatsapp/messages',
      {
        to: input.to,
        content: {
          type: 'template',
          templateName: input.templateName,
          language: input.language ?? 'en',
          ...(input.components?.length ? { components: input.components } : {})
        }
      },
      input.idempotencyKey
    );

    const payload = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { id?: string; messageId?: string };
      error?: { code?: string; message?: string };
    };

    if (!res.ok || payload.success === false) {
      return {
        ok: false,
        code: payload.error?.code ?? `HTTP_${res.status}`,
        error: payload.error?.message ?? `Connect returned ${res.status}`
      };
    }
    return { ok: true, messageId: payload.data?.id ?? payload.data?.messageId };
  } catch (error) {
    // A network failure is not a delivery failure we can reason about; the caller
    // records it and the row can be retried by hand.
    return { ok: false, code: 'NETWORK', error: error instanceof Error ? error.message : String(error) };
  }
};

/** Which templates Connect has, so the admin panel offers real names, not guesses. */
export const listTemplates = async (): Promise<Array<{ name: string; language: string; status: string }>> => {
  if (!isConnectConfigured()) return [];
  try {
    const res = await fetch(`${env.CONNECT_API_URL}/api/v1/whatsapp/templates`, {
      headers: { authorization: `Bearer ${env.CONNECT_API_KEY}` }
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as { data?: { items?: Array<Record<string, unknown>> } };
    return (payload.data?.items ?? []).map((t) => ({
      name: String(t.name ?? ''),
      language: String(t.language ?? 'en'),
      status: String(t.status ?? 'UNKNOWN')
    }));
  } catch {
    return [];
  }
};


/**
 * Tell Connect that something happened with a person — they opted in, they left.
 *
 * This creates a contact and a note in the WhatsApp inbox and buzzes whoever is
 * watching it. It sends nothing to the member: the endpoint has no path to Meta,
 * which is what makes it safe to call on an event the member triggered themselves.
 */
export const recordContactEvent = async (input: {
  phone: string;
  note: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  title?: string;
  idempotencyKey: string;
}): Promise<SendResult> => {
  if (!isConnectConfigured()) return { ok: false, code: 'NOT_CONFIGURED' };
  try {
    const res = await post(
      '/api/v1/contact-events',
      {
        phone: input.phone,
        note: input.note,
        firstName: input.firstName ?? undefined,
        lastName: input.lastName ?? undefined,
        email: input.email ?? undefined,
        title: input.title
      },
      input.idempotencyKey
    );
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      return { ok: false, code: payload.error?.code ?? `HTTP_${res.status}`, error: payload.error?.message };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'NETWORK', error: error instanceof Error ? error.message : String(error) };
  }
};


/**
 * Mirror a completed subscription payment into Connect.
 *
 * Connect's dashboard and phone app answer "how did today go" from its own
 * payments table. Without this, a business whose money arrives through its own
 * checkout sees a permanent zero there — technically accurate, completely
 * useless. Recording the payment makes the number real.
 *
 * Best-effort by design: money is already taken and the member is already
 * activated by the time this runs. A reporting mirror must never be able to
 * fail a payment.
 */
export const recordRevenue = async (input: {
  amount: number | string;
  currency: string;
  description: string;
  /** Connect customer id, when the payer is already a contact there. */
  customerId?: string | null;
  idempotencyKey: string;
}): Promise<SendResult> => {
  if (!isConnectConfigured()) return { ok: false, code: 'NOT_CONFIGURED' };
  try {
    const res = await post(
      '/api/v1/payments',
      {
        amount: Number(input.amount).toFixed(2),
        currency: input.currency.toUpperCase().slice(0, 3),
        description: input.description.slice(0, 500),
        provider: 'MANUAL',
        ...(input.customerId ? { customerId: input.customerId } : {}),
        metadata: { source: 'pastatrade', recordedAt: new Date().toISOString() }
      },
      input.idempotencyKey
    );
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      return { ok: false, code: payload.error?.code ?? `HTTP_${res.status}`, error: payload.error?.message };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'NETWORK', error: error instanceof Error ? error.message : String(error) };
  }
};
