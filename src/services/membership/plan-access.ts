import { supabase } from '../../config/supabase';

// Resolves a user's effective plan, feature flags and numeric limits from the
// database. Everything is DB-driven — nothing is hardcoded. A user with no plan
// row (or an unknown plan) falls back to the seeded `free` plan.

export interface PlanInfo {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  monthly_price: number;
  yearly_price: number;
  currency: string;
  badge: string | null;
}

export interface PlanAccess {
  plan: PlanInfo;
  status: string; // subscription_status on the user row
  isAdmin: boolean;
  features: Record<string, boolean>; // access_* keys
  limits: Record<string, number | null>; // max_* / data_refresh_minutes (null = unlimited)
}

interface FeatureRow {
  feature_key: string;
  is_enabled: boolean;
  limit_value: number | null;
}

const splitFeatures = (rows: FeatureRow[]) => {
  const features: Record<string, boolean> = {};
  const limits: Record<string, number | null> = {};
  for (const r of rows) {
    if (r.feature_key.startsWith('access_')) features[r.feature_key] = r.is_enabled;
    else limits[r.feature_key] = r.limit_value;
  }
  return { features, limits };
};

const loadPlanBySlug = async (slug: string) => {
  const { data } = await supabase
    .from('plans')
    .select('id, slug, name, description, monthly_price, yearly_price, currency, badge')
    .eq('slug', slug)
    .maybeSingle();
  return data as PlanInfo | null;
};

/** Effective access for a user. Defaults to the free plan when none is set. */
export const resolveUserAccess = async (userId: string): Promise<PlanAccess> => {
  const { data: user } = await supabase.from('users').select('plan_id, subscription_status, role').eq('id', userId).maybeSingle();

  let plan: PlanInfo | null = null;
  if (user?.plan_id) {
    const { data } = await supabase
      .from('plans')
      .select('id, slug, name, description, monthly_price, yearly_price, currency, badge')
      .eq('id', user.plan_id)
      .maybeSingle();
    plan = data as PlanInfo | null;
  }
  if (!plan) plan = await loadPlanBySlug('free');
  if (!plan) {
    // Membership not seeded yet — return an empty-but-safe access object.
    return { plan: { id: '', slug: 'free', name: 'Free', description: null, monthly_price: 0, yearly_price: 0, currency: 'USD', badge: null }, status: user?.subscription_status ?? 'active', isAdmin: user?.role === 'admin', features: {}, limits: {} };
  }

  const { data: rows } = await supabase.from('plan_features').select('feature_key, is_enabled, limit_value').eq('plan_id', plan.id);
  const { features, limits } = splitFeatures((rows ?? []) as FeatureRow[]);

  return { plan, status: user?.subscription_status ?? 'active', isAdmin: user?.role === 'admin', features, limits };
};

/** True when the plan grants the feature. Admins bypass plan gating. */
export const canAccess = (access: PlanAccess, featureKey: string): boolean => {
  if (access.isAdmin) return true;
  return access.features[featureKey] === true;
};

/** Numeric limit for a key, or null when unlimited / unknown. Admins → unlimited. */
export const limitFor = (access: PlanAccess, limitKey: string): number | null => {
  if (access.isAdmin) return null;
  const v = access.limits[limitKey];
  return v === undefined ? null : v;
};

/** Cheapest active, non-hidden plan that enables a feature — used for upgrade prompts. */
export const cheapestPlanWith = async (featureKey: string): Promise<string> => {
  const { data } = await supabase
    .from('plan_features')
    .select('is_enabled, plans!inner(slug, monthly_price, is_active, is_hidden)')
    .eq('feature_key', featureKey)
    .eq('is_enabled', true);
  const candidates = (data ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => (Array.isArray(r.plans) ? r.plans[0] : r.plans))
    .filter((p: { is_active: boolean; is_hidden: boolean } | null) => p && p.is_active && !p.is_hidden)
    .sort((a: { monthly_price: number }, b: { monthly_price: number }) => a.monthly_price - b.monthly_price);
  return candidates[0]?.slug ?? 'premium';
};

/** Cheapest active plan whose limit for `limitKey` is higher than `current`. */
export const cheapestPlanWithLimitAbove = async (limitKey: string, current: number): Promise<string> => {
  const { data } = await supabase
    .from('plan_features')
    .select('limit_value, plans!inner(slug, monthly_price, is_active, is_hidden)')
    .eq('feature_key', limitKey);
  const candidates = (data ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({ limit: r.limit_value as number | null, plan: Array.isArray(r.plans) ? r.plans[0] : r.plans }))
    .filter((r: { limit: number | null; plan: { is_active: boolean; is_hidden: boolean } | null }) => r.plan && r.plan.is_active && !r.plan.is_hidden && (r.limit === null || r.limit > current))
    .sort((a: { plan: { monthly_price: number } }, b: { plan: { monthly_price: number } }) => a.plan.monthly_price - b.plan.monthly_price);
  return candidates[0]?.plan?.slug ?? 'premium';
};
