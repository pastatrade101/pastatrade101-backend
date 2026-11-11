import type { Request, Response } from 'express';
import type { RunRotationBody } from '../schemas/rotation-backtest.schema';
import { getRotationMeta, runRotationBacktest } from '../services/rotation-backtest/rotationBacktest.service';
import { sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';

// GET /api/v1/rotation-backtest/meta — coins with saved data, data range, defaults.
export const rotationMeta = asyncHandler(async (_req: Request, res: Response) => {
  return sendSuccess(res, 'Rotation backtest options fetched.', await getRotationMeta());
});

// POST /api/v1/rotation-backtest/run — body validated by runRotationSchema.
export const rotationRun = asyncHandler(async (req: Request, res: Response) => {
  const result = await runRotationBacktest(req.body as RunRotationBody);
  return sendSuccess(res, 'Rotation backtest computed.', result);
});
