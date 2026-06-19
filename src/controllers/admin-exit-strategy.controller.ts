import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { supabase } from '../config/supabase';
import { listProfiles, saveProfile } from '../services/exit-strategy/exitStrategySettings.service';
import { storeExitStrategyDaily } from '../services/exit-strategy/exitStrategy.service';
import { readLatestSocialRisk } from '../services/social/social-latest.service';
import { withJob } from '../services/sync/sync-jobs';

// GET /api/v1/admin/exit-strategy/settings — profiles + Social Risk diagnostics
export const getExitSettings = asyncHandler(async (_req: Request, res: Response) => {
  const [items, social] = await Promise.all([listProfiles(), readLatestSocialRisk()]);
  const { data: lastSocialLog } = await supabase
    .from('social_metric_sync_logs')
    .select('source_name, status, finished_at, records_processed')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: lastDaily } = await supabase.from('exit_strategy_daily').select('date, updated_at, confidence').order('date', { ascending: false }).limit(1).maybeSingle();
  const diagnostics = {
    social_last_synced: social.as_of,
    social_score: social.score,
    social_label: social.label,
    social_status: social.status,
    sources_active: social.sources_active,
    sources_missing: social.sources_missing,
    exit_uses_social: social.score != null,
    last_social_sync_log: lastSocialLog ?? null,
    last_recalc: lastDaily?.updated_at ?? null,
    last_snapshot_date: lastDaily?.date ?? null,
    last_confidence: lastDaily?.confidence ?? null
  };
  return sendSuccess(res, 'Exit strategy settings fetched successfully.', { items, diagnostics });
});

// PUT /api/v1/admin/exit-strategy/settings  body: { profile_name, ...patch }
export const updateExitSettings = asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const profileName = b.profile_name as string;
  if (!profileName) throw new AppError('profile_name is required.', 400);
  const updated = await saveProfile(profileName, b);
  return sendSuccess(res, 'Exit strategy settings updated successfully.', updated);
});

// POST /api/v1/admin/exit-strategy/sync — recompute + store today's snapshot
export const triggerExitSync = asyncHandler(async (req: Request, res: Response) => {
  const result = await withJob('exit-strategy', 'exit-strategy', req.user!.sub, () => storeExitStrategyDaily());
  return sendSuccess(res, 'Exit strategy sync completed.', result);
});

// POST /api/v1/admin/exit-strategy/recalculate — alias for a manual recompute
export const recalcExit = asyncHandler(async (req: Request, res: Response) => {
  const result = await withJob('exit-strategy', 'exit-strategy-recalc', req.user!.sub, () => storeExitStrategyDaily());
  return sendSuccess(res, 'Exit strategy recalculated successfully.', result);
});
