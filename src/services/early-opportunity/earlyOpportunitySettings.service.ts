import { supabase } from '../../config/supabase';
import { DEFAULT_SETTINGS, type RadarSettings } from './earlyOpportunity.service';

// Settings live in a single row. Always merged over DEFAULT_SETTINGS so a missing
// table/row never breaks the radar (it just uses sane defaults).

export interface RadarSettingsRow extends RadarSettings {
  id?: string;
  is_active: boolean;
}

export const getSettings = async (): Promise<RadarSettingsRow> => {
  try {
    const { data } = await supabase.from('early_opportunity_settings').select('*').limit(1).maybeSingle();
    if (!data) return { ...DEFAULT_SETTINGS, is_active: true };
    return {
      id: data.id,
      min_liquidity_usd: Number(data.min_liquidity_usd ?? DEFAULT_SETTINGS.min_liquidity_usd),
      min_volume_24h: Number(data.min_volume_24h ?? DEFAULT_SETTINGS.min_volume_24h),
      min_transactions_24h: Number(data.min_transactions_24h ?? DEFAULT_SETTINGS.min_transactions_24h),
      min_pool_age_hours: Number(data.min_pool_age_hours ?? DEFAULT_SETTINGS.min_pool_age_hours),
      max_vol_liq_ratio: Number(data.max_vol_liq_ratio ?? DEFAULT_SETTINGS.max_vol_liq_ratio),
      exclude_stablecoins: data.exclude_stablecoins ?? true,
      exclude_wrapped_tokens: data.exclude_wrapped_tokens ?? true,
      exclude_abnormal_spikes: data.exclude_abnormal_spikes ?? true,
      allowed_networks: Array.isArray(data.allowed_networks) ? data.allowed_networks : DEFAULT_SETTINGS.allowed_networks,
      scoring_weights: { ...DEFAULT_SETTINGS.scoring_weights, ...(data.scoring_weights ?? {}) },
      risk_weights: { ...DEFAULT_SETTINGS.risk_weights, ...(data.risk_weights ?? {}) },
      is_active: data.is_active ?? true
    };
  } catch {
    return { ...DEFAULT_SETTINGS, is_active: true };
  }
};

export const updateSettings = async (patch: Partial<RadarSettingsRow>): Promise<RadarSettingsRow> => {
  const current = await getSettings();
  const merged = { ...current, ...patch };
  const payload = {
    min_liquidity_usd: merged.min_liquidity_usd,
    min_volume_24h: merged.min_volume_24h,
    min_transactions_24h: merged.min_transactions_24h,
    min_pool_age_hours: merged.min_pool_age_hours,
    max_vol_liq_ratio: merged.max_vol_liq_ratio,
    exclude_stablecoins: merged.exclude_stablecoins,
    exclude_wrapped_tokens: merged.exclude_wrapped_tokens,
    exclude_abnormal_spikes: merged.exclude_abnormal_spikes,
    allowed_networks: merged.allowed_networks,
    scoring_weights: merged.scoring_weights,
    risk_weights: merged.risk_weights,
    is_active: merged.is_active,
    updated_at: new Date().toISOString()
  };
  if (current.id) {
    const { error } = await supabase.from('early_opportunity_settings').update(payload).eq('id', current.id);
    if (error) throw new Error(`Failed to update radar settings: ${error.message}`);
  } else {
    const { error } = await supabase.from('early_opportunity_settings').insert(payload);
    if (error) throw new Error(`Failed to create radar settings: ${error.message}`);
  }
  return getSettings();
};
