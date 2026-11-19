import type { Request, Response } from 'express';
import { myInvestmentModes, readMyInvestments } from '../services/rotation-bot/fund-books';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';

// A signed-in account's own share of the rotation sleeve, when the admin has linked it
// to a person in the investor books. View only, and only that account's own figures.

const me = (req: Request): string => req.user?.sub ?? (() => { throw new AppError('Authentication is required.', 401); })();

// GET /api/v1/me/investments/linked — whether this account has a share to look at (no prices read).
export const getMyInvestmentLinked = asyncHandler(async (req: Request, res: Response) => {
  const modes = await myInvestmentModes(me(req));
  return sendSuccess(res, 'Investment link fetched.', { linked: modes.length > 0, modes });
});

// GET /api/v1/me/investments — this account's share: value, gain, holdings slice, own money in and out.
export const getMyInvestments = asyncHandler(async (req: Request, res: Response) => {
  return sendSuccess(res, 'Investments fetched.', { items: await readMyInvestments(me(req)) });
});
