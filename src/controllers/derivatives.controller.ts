import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { computeDerivatives, getDerivativesHistory } from '../services/derivatives/derivatives.service';

// GET /api/v1/derivatives — live leverage-risk read from Bitget public data.
export const getDerivatives = asyncHandler(async (_req: Request, res: Response) => {
  const data = await computeDerivatives();
  return sendSuccess(res, 'Derivatives risk computed successfully.', data);
});

// GET /api/v1/derivatives/history?days=90 — stored daily leverage/funding/OI/positioning trend.
export const getDerivativesHistoryCtrl = asyncHandler(async (req: Request, res: Response) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
  const data = await getDerivativesHistory(days);
  return sendSuccess(res, 'Derivatives history loaded.', { days, points: data });
});
