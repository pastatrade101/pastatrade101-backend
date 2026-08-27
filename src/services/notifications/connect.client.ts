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
