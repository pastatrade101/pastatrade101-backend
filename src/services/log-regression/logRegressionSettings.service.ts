import { supabase } from '../../config/supabase';

// Per-asset logarithmic regression settings. BTC and ETH have separate band
// multipliers because ETH has a shorter, more volatile history.

export type AssetSymbol = 'BTC' | 'ETH';

export interface LogRegressionSettings {
  asset_symbol: AssetSymbol;
  start_date: string | null;
  lower_multiplier: number;
  upper_multiplier: number;
  bubble_lower_multiplier: number;
  bubble_upper_multiplier: number;
  fitting_method: string;
  is_active: boolean;
}

const DEFAULTS: Record<AssetSymbol, LogRegressionSettings> = {
  BTC: { asset_symbol: 'BTC', start_date: null, lower_multiplier: 0.65, upper_multiplier: 1.5, bubble_lower_multiplier: 2.8, bubble_upper_multiplier: 4.2, fitting_method: 'log_log', is_active: true },
  ETH: { asset_symbol: 'ETH', start_date: null, lower_multiplier: 0.55, upper_multiplier: 1.7, bubble_lower_multiplier: 3.0, bubble_upper_multiplier: 5.0, fitting_method: 'log_log', is_active: true }
};

export const ASSET_IDS: Record<AssetSymbol, string> = { BTC: 'bitcoin', ETH: 'ethereum' };

const rowToSettings = (r: Record<string, unknown>): LogRegressionSettings => ({
  asset_symbol: (r.asset_symbol as AssetSymbol) ?? 'BTC',
  start_date: (r.start_date as string | null) ?? null,
  lower_multiplier: Number(r.lower_multiplier ?? 0.65),
  upper_multiplier: Number(r.upper_multiplier ?? 1.5),
  bubble_lower_multiplier: Number(r.bubble_lower_multiplier ?? 2.8),
  bubble_upper_multiplier: Number(r.bubble_upper_multiplier ?? 4.2),
  fitting_method: (r.fitting_method as string) ?? 'log_log',
  is_active: r.is_active !== false
});

export const getSettings = async (asset: AssetSymbol): Promise<LogRegressionSettings> => {
  const { data } = await supabase.from('log_regression_settings').select('*').eq('asset_symbol', asset).maybeSingle();
  return data ? rowToSettings(data) : DEFAULTS[asset];
};

export const listSettings = async (): Promise<LogRegressionSettings[]> => {
  const { data } = await supabase.from('log_regression_settings').select('*').order('asset_symbol', { ascending: true });
  if (!data?.length) return [DEFAULTS.BTC, DEFAULTS.ETH];
  return data.map(rowToSettings);
};

export const saveSettings = async (asset: AssetSymbol, patch: Partial<LogRegressionSettings>): Promise<LogRegressionSettings> => {
  const allowed = ['start_date', 'lower_multiplier', 'upper_multiplier', 'bubble_lower_multiplier', 'bubble_upper_multiplier', 'fitting_method', 'is_active'];
  const update: Record<string, unknown> = { asset_symbol: asset, updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in patch) update[k] = (patch as Record<string, unknown>)[k];
  const { data, error } = await supabase.from('log_regression_settings').upsert(update, { onConflict: 'asset_symbol' }).select('*').single();
  if (error) throw error;
  return rowToSettings(data);
};
