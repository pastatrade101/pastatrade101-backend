import { supabase } from '../../config/supabase';
import type { MoonParams, MoonResult } from './engine';

// Saved backtest runs (table moon_backtests). The full result is a few hundred KB of
// JSON at most; the list view only reads the small `summary`.

const TABLE = 'moon_backtests';
export const RUNS_TABLE_MISSING = `The ${TABLE} table does not exist yet — create it once with backend/database/moon-backtests.sql in the Supabase SQL editor.`;
const isMissingTable = (e: { code?: string; message?: string }) => e.code === 'PGRST205' || e.code === '42P01' || /could not find the table/i.test(e.message ?? '');

export interface RunSummary {
  period: MoonResult['period'];
  universe: MoonResult['universe'];
  metrics: MoonResult['metrics'];
  stats: MoonResult['stats'];
  byYear: MoonResult['byYear'];
}

export interface RunRow {
  id: string;
  created_at: string;
  name: string;
  params: MoonParams;
  summary: RunSummary;
  created_by: string | null;
}

export const summarize = (r: MoonResult): RunSummary => ({ period: r.period, universe: r.universe, metrics: r.metrics, stats: r.stats, byYear: r.byYear });

/** Whether the table exists (false = the SQL file has not been run yet). */
export const runsTableReady = async (): Promise<boolean> => {
  const { error } = await supabase.from(TABLE).select('id').limit(1);
  if (!error) return true;
  if (isMissingTable(error)) return false;
  throw new Error(`Failed to reach ${TABLE}: ${error.message}`);
};

export const saveRun = async (name: string, result: MoonResult, by: string): Promise<string> => {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ name, params: result.params, summary: summarize(result), result, created_by: by })
    .select('id')
    .single();
  if (error) throw new Error(isMissingTable(error) ? RUNS_TABLE_MISSING : `Failed to save the backtest: ${error.message}`);
  return data.id as string;
};

export const listRuns = async (limit = 60): Promise<RunRow[]> => {
  const { data, error } = await supabase.from(TABLE).select('id, created_at, name, params, summary, created_by').order('created_at', { ascending: false }).limit(limit);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`Failed to list backtests: ${error.message}`);
  }
  return (data ?? []) as RunRow[];
};

export const getRun = async (id: string): Promise<(RunRow & { result: MoonResult }) | null> => {
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Failed to read the backtest: ${error.message}`);
  return (data as (RunRow & { result: MoonResult }) | null) ?? null;
};

export const deleteRun = async (id: string): Promise<boolean> => {
  const { data, error } = await supabase.from(TABLE).delete().eq('id', id).select('id');
  if (error) throw new Error(`Failed to delete the backtest: ${error.message}`);
  return !!data?.length;
};
