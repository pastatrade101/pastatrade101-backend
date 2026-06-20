import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { computeDerivatives } from '../services/derivatives/derivatives.service';

// GET /api/v1/derivatives — live leverage-risk read from Bitget public data.
export const getDerivatives = asyncHandler(async (_req: Request, res: Response) => {
  const data = await computeDerivatives();
  return sendSuccess(res, 'Derivatives risk computed successfully.', data);
});
