import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { supabase } from '../config/supabase';
import { getSettings, updateSettings } from '../services/early-opportunity/earlyOpportunitySettings.service';
import { runEarlyOpportunitySync } from '../services/early-opportunity/earlyOpportunitySync.service';

// GET /api/v1/admin/early-opportunity/settings
export const adminGetSettings = asyncHandler(async (_req: Request, res: Response) => sendSuccess(res, 'Settings loaded.', await getSettings()));

// PUT /api/v1/admin/early-opportunity/settings
export const adminUpdateSettings = asyncHandler(async (req: Request, res: Response) => {
  const updated = await updateSettings(req.body ?? {});
  return sendSuccess(res, 'Settings updated.', updated);
});

// POST /api/v1/admin/early-opportunity/sync — run the discovery scan now.
export const adminSync = asyncHandler(async (_req: Request, res: Response) => {
  const stored = await runEarlyOpportunitySync();
  return sendSuccess(res, stored ? `Radar synced — ${stored} candidate(s).` : 'No candidates returned (sources unavailable).', { stored });
});

// POST /api/v1/admin/early-opportunity/recalculate — re-fetch + rescore (alias of sync; raw data is not retained).
export const adminRecalculate = asyncHandler(async (_req: Request, res: Response) => {
  const stored = await runEarlyOpportunitySync();
  return sendSuccess(res, `Recalculated — ${stored} candidate(s).`, { stored });
});

// GET /api/v1/admin/early-opportunity/sync-logs
export const adminSyncLogs = asyncHandler(async (_req: Request, res: Response) => {
  const { data } = await supabase.from('early_opportunity_sync_logs').select('*').order('started_at', { ascending: false }).limit(50);
  return sendSuccess(res, 'Sync logs loaded.', data ?? []);
});
