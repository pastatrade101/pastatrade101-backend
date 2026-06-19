import { supabase } from '../../config/supabase';

export interface RiskZone {
  min: number;
  max: number;
  label: string;
  meaning: string;
}
export interface Weights {
  btc: number;
  onchain: number;
  social: number;
  altcoin: number;
  cycle: number;
}
export interface LadderStep {
  risk: number;
  label: string;
  action: string;
  pct: string;
}
export interface ExitProfile {
  id: string | null;
  profile_name: string;
  is_default: boolean;
  is_active: boolean;
  show_percentages: boolean;
  risk_zones: RiskZone[];
  weights: Weights;
  ladder: LadderStep[];
  disclaimer: string;
}

export const DEFAULT_DISCLAIMER =
  'Not financial advice. Pastatrade provides ranking-based market intelligence and probability-style scoring. Exit Strategy signals describe current risk conditions; they are not instructions to buy or sell and do not guarantee future performance. This model is inspired by risk-based scaling frameworks, not any proprietary external model. Always do your own research.';

const CANON_ZONES: RiskZone[] = [
  { min: 0, max: 0.3, label: 'Accumulation', meaning: 'Market risk is low. This zone favours DCA/accumulation rather than exits.' },
  { min: 0.3, max: 0.5, label: 'Hold', meaning: 'Risk is moderate. No major exit pressure yet.' },
  { min: 0.5, max: 0.65, label: 'Reduce DCA', meaning: 'Risk is rising. Avoid aggressive new buying and watch overheating signals.' },
  { min: 0.65, max: 0.75, label: 'Light profit-taking', meaning: 'Risk is becoming elevated. Consider small partial profit-taking if already in profit.' },
  { min: 0.75, max: 0.85, label: 'Scale-out zone', meaning: 'Risk is high. Gradual profit-taking becomes more important.' },
  { min: 0.85, max: 0.95, label: 'Major distribution', meaning: 'Risk is very high. Historically favours reducing exposure.' },
  { min: 0.95, max: 1.01, label: 'Extreme exit risk', meaning: 'Conditions are extremely overheated. Not a zone for aggressive buying.' }
];
const DEFAULT_WEIGHTS: Weights = { btc: 0.35, onchain: 0.25, social: 0.15, altcoin: 0.15, cycle: 0.1 };
const BALANCED_LADDER: LadderStep[] = [
  { risk: 0.5, label: 'Stop aggressive DCA', action: 'Stop aggressive DCA', pct: '' },
  { risk: 0.6, label: 'Partial scale-out', action: 'Small partial profit-taking', pct: '5–10%' },
  { risk: 0.7, label: 'Scale-out', action: 'Scale out gradually', pct: '10–20%' },
  { risk: 0.8, label: 'Scale-out zone', action: 'Scale out more', pct: '20–30%' },
  { risk: 0.9, label: 'Major distribution', action: 'Reduce exposure', pct: '30–50%' },
  { risk: 0.95, label: 'Keep only moonbag', action: 'Keep only long-term moonbag (optional)', pct: '' }
];

// Used when the table isn't seeded yet — the module still works.
export const FALLBACK_PROFILE: ExitProfile = {
  id: null,
  profile_name: 'balanced',
  is_default: true,
  is_active: true,
  show_percentages: true,
  risk_zones: CANON_ZONES,
  weights: DEFAULT_WEIGHTS,
  ladder: BALANCED_LADDER,
  disclaimer: DEFAULT_DISCLAIMER
};

const rowToProfile = (r: Record<string, unknown>): ExitProfile => ({
  id: (r.id as string) ?? null,
  profile_name: (r.profile_name as string) ?? 'balanced',
  is_default: Boolean(r.is_default),
  is_active: r.is_active !== false,
  show_percentages: r.show_percentages !== false,
  risk_zones: (r.risk_zones as RiskZone[]) ?? CANON_ZONES,
  weights: (r.weights as Weights) ?? DEFAULT_WEIGHTS,
  ladder: (r.ladder as LadderStep[]) ?? BALANCED_LADDER,
  disclaimer: (r.disclaimer as string) ?? DEFAULT_DISCLAIMER
});

export const listProfiles = async (): Promise<ExitProfile[]> => {
  const { data } = await supabase.from('exit_strategy_settings').select('*').order('profile_name', { ascending: true });
  if (!data?.length) return [FALLBACK_PROFILE];
  return data.map(rowToProfile);
};

/** Resolve a profile by name, falling back to the default, then the code fallback. */
export const getProfile = async (name?: string): Promise<ExitProfile> => {
  const profiles = await listProfiles();
  if (name) {
    const byName = profiles.find((p) => p.profile_name === name && p.is_active);
    if (byName) return byName;
  }
  return profiles.find((p) => p.is_default && p.is_active) ?? profiles.find((p) => p.is_active) ?? FALLBACK_PROFILE;
};

export const saveProfile = async (profileName: string, patch: Partial<ExitProfile>): Promise<ExitProfile> => {
  const allowed = ['is_default', 'is_active', 'show_percentages', 'risk_zones', 'weights', 'ladder', 'disclaimer'];
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in patch) update[k] = (patch as Record<string, unknown>)[k];
  // If this profile is set default, clear the others.
  if (update.is_default === true) await supabase.from('exit_strategy_settings').update({ is_default: false }).neq('profile_name', profileName);
  const { data, error } = await supabase.from('exit_strategy_settings').update(update).eq('profile_name', profileName).select('*').single();
  if (error) throw error;
  return rowToProfile(data);
};
