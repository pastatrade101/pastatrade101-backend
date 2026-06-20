import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getQueryString, getQueryNumber } from '../utils/query';
import { limitFor, resolveUserAccess } from '../services/membership/plan-access';
import { getBreadth, getCoinDetail, getCoins, getRadar, getRotationWave, type AbbQuery } from '../services/alt-btc-bottom/altBtcBottomView.service';

const tierCap = async (sub: string): Promise<number | undefined> => {
  const access = await resolveUserAccess(sub);
  if (access.isAdmin || access.plan.slug === 'premium') return undefined;
  return limitFor(access, 'access_alt_btc_bottom_radar') ?? undefined;
};

const parseQuery = (req: Request, cap?: number): AbbQuery => ({
  tab: getQueryString(req.query, 'tab') || undefined,
  sort: getQueryString(req.query, 'sort') || undefined,
  search: getQueryString(req.query, 'search') || undefined,
  minScore: getQueryNumber(req.query, 'minScore'),
  limit: cap
});

export const getRadarCtrl = asyncHandler(async (req: Request, res: Response) => {
  const data = await getRadar(parseQuery(req, await tierCap(req.user!.sub)));
  return sendSuccess(res, 'Alt/BTC Bottom Radar loaded.', data);
});

export const getCoinsCtrl = asyncHandler(async (req: Request, res: Response) => {
  const data = await getCoins(parseQuery(req, await tierCap(req.user!.sub)));
  return sendSuccess(res, 'Coins loaded.', { coins: data });
});

export const getCoinCtrl = asyncHandler(async (req: Request, res: Response) => {
  const data = await getCoinDetail(req.params.coinId);
  return sendSuccess(res, 'Coin loaded.', data);
});

export const getBreadthCtrl = asyncHandler(async (_req: Request, res: Response) => sendSuccess(res, 'Breadth loaded.', await getBreadth()));
export const getRotationWaveCtrl = asyncHandler(async (_req: Request, res: Response) => sendSuccess(res, 'Rotation wave loaded.', await getRotationWave()));
