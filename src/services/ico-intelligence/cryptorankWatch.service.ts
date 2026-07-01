import { supabase } from '../../config/supabase';
import { AppError } from '../../utils/api-response';
import { resolveRef } from '../sources/cryptorank.client';
import { cryptorank as crConfig } from '../../config/env';

// The admin-managed list of CryptoRank projects to track (free-plan ICO radar).
// A ref (slug/id/symbol) is resolved to a CryptoRank id at add-time so the sync
// can fetch /currencies/{id} directly.

export interface WatchRow {
  id: string;
  cr_id: number;
  slug: string | null;
  name: string | null;
  created_at: string;
}

export const listWatch = async (): Promise<WatchRow[]> => {
  const { data, error } = await supabase.from('cryptorank_watch').select('*').order('created_at', { ascending: false });
  if (error) throw new AppError('Unable to load tracked projects.', 500, [error]);
  return (data ?? []) as WatchRow[];
};

/** Env seed (CRYPTORANK_TRACK) + DB watchlist → the set of ids to enrich. */
export const watchedIds = async (): Promise<number[]> => {
  const rows = await listWatch().catch(() => [] as WatchRow[]);
  const ids = new Set<number>(rows.map((r) => r.cr_id));
  // Optional env seed of numeric ids (slugs are resolved via the UI, not env).
  for (const t of crConfig.track) if (/^\d+$/.test(t)) ids.add(Number(t));
  return [...ids];
};

export const addWatch = async (ref: string, createdBy?: string): Promise<WatchRow> => {
  const clean = (ref ?? '').trim();
  if (!clean) throw new AppError('Provide a CryptoRank slug, id or symbol.', 400);
  if (!crConfig.configured) throw new AppError('CryptoRank is not configured (CRYPTORANK_API_KEY missing).', 400);
  const entry = await resolveRef(clean);
  if (!entry) throw new AppError(`No CryptoRank project found for "${clean}". Try the slug from its cryptorank.io URL.`, 404);
  const { data, error } = await supabase
    .from('cryptorank_watch')
    .upsert({ cr_id: entry.id, slug: entry.slug || null, name: entry.name || null, created_by: createdBy ?? null }, { onConflict: 'cr_id' })
    .select('*')
    .maybeSingle();
  if (error) throw new AppError('Failed to add tracked project.', 500, [error]);
  return data as WatchRow;
};

export const removeWatch = async (id: string): Promise<void> => {
  const { error } = await supabase.from('cryptorank_watch').delete().eq('id', id);
  if (error) throw new AppError('Failed to remove tracked project.', 500, [error]);
};
