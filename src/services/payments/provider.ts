// Provider-agnostic payment contract. Membership/access logic must never depend
// on a specific provider — providers only create a checkout and emit webhook
// events that update subscription_status + payment_events.

export interface CheckoutInput {
  userId: string;
  planSlug: string;
  planName: string;
  amount: number; // whole units in `currency` (e.g. 22000 TZS)
  currency: string; // ISO 4217, e.g. TZS / USD
  interval: 'monthly' | 'yearly';
  customer: { name?: string; email?: string; phone?: string };
  successUrl: string; // where the hosted checkout returns the user
}

export interface CheckoutResult {
  provider: string;
  reference: string; // provider session/payment reference
  checkout_url: string; // hosted page the user is redirected to
}

// A normalized webhook event after verification.
export interface NormalizedEvent {
  id: string; // provider event id (for idempotency)
  type: string; // e.g. payment.completed
  status: string;
  reference: string;
  amount: number | null;
  currency: string | null;
  metadata: Record<string, unknown>;
  raw: unknown; // full original payload for the audit trail
}

// Pull-based status check (so a missed/delayed webhook never strands a payer).
export interface PaymentStatus {
  reference: string;
  status: string;
  paid: boolean;
  metadata: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  /** Verify signature headers against the raw body. Returns false when invalid. */
  verifyWebhook(rawBody: Buffer | string, headers: Record<string, string | undefined>): boolean;
  /** Parse an already-verified payload into a normalized event. */
  parseEvent(body: unknown): NormalizedEvent;
  /** Query the provider for a session/payment status by reference. Null on error. */
  fetchStatus?(reference: string): Promise<PaymentStatus | null>;
}
