import { supabase } from '../../config/supabase';

// Live usage counters. Watchlist items and alerts are derived from their own
// tables (always accurate); counter-style features (reports/exports) can be
// tracked in usage_limits via increment().

export interface Usage {
  watchlist_items: number;
  alerts: number;
}

const userWatchlistIds = async (userId: string): Promise<string[]> => {
  const { data } = await supabase.from('watchlists').select('id').eq('user_id', userId);
  return (data ?? []).map((r) => r.id as string);
};

export const getUsage = async (userId: string): Promise<Usage> => {
  const listIds = await userWatchlistIds(userId);
  if (!listIds.length) return { watchlist_items: 0, alerts: 0 };

  const { data: items } = await supabase.from('watchlist_items').select('id').in('watchlist_id', listIds);
  const itemIds = (items ?? []).map((r) => r.id as string);

  let alerts = 0;
  if (itemIds.length) {
    const { count } = await supabase.from('watchlist_alerts').select('id', { count: 'exact', head: true }).in('watchlist_item_id', itemIds);
    alerts = count ?? 0;
  }
  return { watchlist_items: itemIds.length, alerts };
};

// Maps a plan limit key → the matching live usage count.
const LIMIT_TO_USAGE: Record<string, keyof Usage> = {
  max_watchlist_items: 'watchlist_items',
  max_alerts: 'alerts'
};

export const usageForLimit = async (userId: string, limitKey: string): Promise<number> => {
  const field = LIMIT_TO_USAGE[limitKey];
  if (!field) return 0;
  const usage = await getUsage(userId);
  return usage[field];
};

/** How many times a counter-style feature was used in the current month. */
export const countUsageThisMonth = async (userId: string, featureKey: string): Promise<number> => {
  const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data } = await supabase
    .from('usage_limits')
    .select('used_count')
    .eq('user_id', userId)
    .eq('feature_key', featureKey)
    .eq('period_start', periodStart)
    .maybeSingle();
  return (data?.used_count as number | undefined) ?? 0;
};

/** Increment a counter-style feature's usage in the current period (best-effort). */
export const incrementUsage = async (userId: string, featureKey: string): Promise<void> => {
  const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data: existing } = await supabase
    .from('usage_limits')
    .select('id, used_count')
    .eq('user_id', userId)
    .eq('feature_key', featureKey)
    .eq('period_start', periodStart)
    .maybeSingle();
  if (existing) {
    await supabase.from('usage_limits').update({ used_count: (existing.used_count ?? 0) + 1, updated_at: new Date().toISOString() }).eq('id', existing.id);
  } else {
    await supabase.from('usage_limits').insert({ user_id: userId, feature_key: featureKey, used_count: 1, period_start: periodStart });
  }
};
