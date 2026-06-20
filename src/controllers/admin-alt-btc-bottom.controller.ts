import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { runAltBtcBottomSync } from '../services/alt-btc-bottom/altBtcBottomSync.service';

// POST /api/v1/admin/alt-btc-bottom/sync — recompute + store the radar now.
export const adminSyncAltBtcBottom = asyncHandler(async (_req: Request, res: Response) => {
  const stored = await runAltBtcBottomSync();
  return sendSuccess(res, stored ? `Alt/BTC Bottom Radar synced — ${stored} coin(s).` : 'No coins computed (price series unavailable).', { stored });
});
