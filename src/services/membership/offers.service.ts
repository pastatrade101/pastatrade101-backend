import { supabase } from '../../config/supabase';

// Pricing offers are a temporary override on top of a plan's real price. The
// real price is NEVER mutated — an offer just discounts the charged/displayed
// amount while it is live. This service is the single source of truth for
// "is an offer live right now" so the pricing page, the checkout and the admin
// list all agree.

export interface OfferRow {
  id: string;
  plan_id: string;
  billing_interval: string;
  offer_price: number;
  original_price: number;
  offer_label: string;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type OfferStatus = 'active' | 'scheduled' | 'expired' | 'disabled';

/** Derive an offer's lifecycle status at a given moment. */
export const offerStatus = (o: Pick<OfferRow, 'is_active' | 'starts_at' | 'ends_at'>, now = Date.now()): OfferStatus => {
  if (!o.is_active) return 'disabled';
  const start = new Date(o.starts_at).getTime();
  const end = new Date(o.ends_at).getTime();
  if (now < start) return 'scheduled';
  if (now >= end) return 'expired';
  return 'active';
};

/**
 * Currently-live offers (is_active AND now within the window), deduped so each
 * plan+interval yields at most ONE offer — the most recently created wins if an
 * admin left overlapping offers. This is what the public pricing surfaces use.
 */
export const getActiveOffers = async (): Promise<OfferRow[]> => {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from('pricing_offers')
    .select('*')
    .eq('is_active', true)
    .lte('starts_at', nowIso)
    .gt('ends_at', nowIso)
    .order('created_at', { ascending: false });
  const seen = new Set<string>();
  const out: OfferRow[] = [];
  for (const o of (data ?? []) as OfferRow[]) {
    const key = `${o.plan_id}:${o.billing_interval}`;
    if (seen.has(key)) continue; // keep the newest (query is created_at desc)
    seen.add(key);
    out.push(o);
  }
  return out;
};

/** The single live offer for a plan+interval right now, or null. Used at checkout. */
export const getActiveOfferForPlan = async (planId: string, billingInterval: string): Promise<OfferRow | null> => {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from('pricing_offers')
    .select('*')
    .eq('plan_id', planId)
    .eq('billing_interval', billingInterval)
    .eq('is_active', true)
    .lte('starts_at', nowIso)
    .gt('ends_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as OfferRow | null) ?? null;
};

/** All offers with their computed status + plan name, for the admin list. */
export const listOffersAdmin = async (): Promise<(OfferRow & { plan_name: string | null; plan_slug: string | null; status: OfferStatus })[]> => {
  const { data } = await supabase
    .from('pricing_offers')
    .select('*, plans(name, slug)')
    .order('created_at', { ascending: false });
  const now = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((o) => ({
    ...o,
    plan_name: o.plans?.name ?? null,
    plan_slug: o.plans?.slug ?? null,
    plans: undefined,
    status: offerStatus(o, now)
  }));
};
