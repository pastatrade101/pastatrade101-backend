import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { computeDerivatives, getDerivativesHistory } from '../services/derivatives/derivatives.service';

// GET /api/v1/derivatives — leverage-risk read from BGeometrics derivatives data
// (funding, open interest, top-trader positioning, taker flow, liquidations).
export const getDerivatives = asyncHandler(async (_req: Request, res: Response) => {
  const data = await computeDerivatives();
  return sendSuccess(res, 'Derivatives risk computed successfully.', data);
});

// GET /api/v1/derivatives/history?days=N — daily series for the charts (all
// history when `days` is omitted): leverage score, funding, open interest,
// positioning, taker flow, liquidations, Coinbase premium, BTC price.
export const getDerivativesHistoryCtrl = asyncHandler(async (req: Request, res: Response) => {
  const raw = Number(req.query.days);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(3650, Math.max(7, raw)) : undefined;
  const data = await getDerivativesHistory(days);
  return sendSuccess(res, 'Derivatives history loaded.', { days: days ?? null, ...data });
});
