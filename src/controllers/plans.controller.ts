import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';

interface FeatureRow {
  plan_id: string;
  feature_key: string;
  is_enabled: boolean;
  limit_value: number | null;
}

// Attach { features, limits } to each plan from a single plan_features query.
export const attachFeatures = async <T extends { id: string }>(plans: T[]) => {
  if (!plans.length) return [] as (T & { features: Record<string, boolean>; limits: Record<string, number | null> })[];
  const { data } = await supabase
    .from('plan_features')
    .select('plan_id, feature_key, is_enabled, limit_value')
    .in(
      'plan_id',
      plans.map((p) => p.id)
    );
  const byPlan = new Map<string, FeatureRow[]>();
  for (const r of (data ?? []) as FeatureRow[]) {
    if (!byPlan.has(r.plan_id)) byPlan.set(r.plan_id, []);
    byPlan.get(r.plan_id)!.push(r);
  }
  return plans.map((p) => {
    const features: Record<string, boolean> = {};
    const limits: Record<string, number | null> = {};
    for (const r of byPlan.get(p.id) ?? []) {
      if (r.feature_key.startsWith('access_')) features[r.feature_key] = r.is_enabled;
      else limits[r.feature_key] = r.limit_value;
    }
    return { ...p, features, limits };
  });
};

// GET /api/v1/plans — public, active & visible plans for the pricing page.
export const listPlans = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('plans')
    .select('id, name, slug, description, badge, monthly_price, yearly_price, currency, billing_interval, is_popular, trial_days, sort_order')
    .eq('is_active', true)
    .eq('is_hidden', false)
    .eq('is_archived', false)
    .order('sort_order', { ascending: true });
  if (error) throw new AppError('Unable to load plans.', 500, [error]);
  return sendSuccess(res, 'Plans fetched successfully.', { items: await attachFeatures(data ?? []) });
});

// GET /api/v1/plans/:slug
export const getPlanBySlug = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('plans')
    .select('id, name, slug, description, badge, monthly_price, yearly_price, currency, billing_interval, is_popular, trial_days')
    .eq('slug', req.params.slug)
    .eq('is_archived', false)
    .maybeSingle();
  if (error) throw new AppError('Unable to load plan.', 500, [error]);
  if (!data) throw new AppError('Plan not found.', 404);
  const [withFeatures] = await attachFeatures([data]);
  return sendSuccess(res, 'Plan fetched successfully.', withFeatures);
});
