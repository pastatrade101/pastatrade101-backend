import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { computeExitStrategy } from '../services/exit-strategy/exitStrategy.service';
import { computeExitHistory } from '../services/exit-strategy/exitStrategyHistory.service';
import { getProfile } from '../services/exit-strategy/exitStrategySettings.service';

// User-facing Dynamic Exit Strategy (Premium-gated in the route).

// GET /api/v1/exit-strategy?profile=balanced
export const getExitStrategy = asyncHandler(async (req: Request, res: Response) => {
  const profile = getQueryString(req.query, 'profile') || undefined;
  const data = await computeExitStrategy(profile);
  return sendSuccess(res, 'Exit strategy computed successfully.', data);
});

// GET /api/v1/exit-strategy/history
export const getExitHistory = asyncHandler(async (_req: Request, res: Response) => {
  const data = await computeExitHistory();
  return sendSuccess(res, 'Exit strategy history computed successfully.', data);
});

// GET /api/v1/exit-strategy/ladder?profile=balanced
export const getExitLadder = asyncHandler(async (req: Request, res: Response) => {
  const profile = await getProfile(getQueryString(req.query, 'profile') || undefined);
  return sendSuccess(res, 'Exit ladder fetched successfully.', {
    profile: profile.profile_name,
    show_percentages: profile.show_percentages,
    ladder: profile.ladder,
    risk_zones: profile.risk_zones
  });
});

// GET /api/v1/exit-strategy/events
export const getExitEvents = asyncHandler(async (_req: Request, res: Response) => {
  const { data } = await supabase.from('exit_strategy_events').select('*').order('date', { ascending: false }).limit(30);
  return sendSuccess(res, 'Exit strategy events fetched successfully.', { items: data ?? [] });
});
