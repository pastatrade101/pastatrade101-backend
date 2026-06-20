import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { limitFor, resolveUserAccess } from '../services/membership/plan-access';
import { getCandidateById, getNarratives, getNetworks, getRadar, getSourceStatus, type RadarQuery } from '../services/early-opportunity/earlyOpportunityView.service';

const parseQuery = (req: Request, cap?: number): RadarQuery => ({
  tab: getQueryString(req.query, 'tab') || undefined,
  view: getQueryString(req.query, 'view') || undefined,
  network: getQueryString(req.query, 'network') || undefined,
  sort: getQueryString(req.query, 'sort') || undefined,
  search: getQueryString(req.query, 'search') || undefined,
  limit: cap
});

// Tier cap: Mid plans get a limited number of candidates, Premium/admin unlimited.
const tierCap = async (sub: string): Promise<number | undefined> => {
  const access = await resolveUserAccess(sub);
  if (access.isAdmin || access.plan.slug === 'premium') return undefined;
  const lim = limitFor(access, 'access_early_opportunity_radar');
  return lim ?? undefined;
};

// GET /api/v1/early-opportunity-radar — full radar dashboard.
export const getRadarCtrl = asyncHandler(async (req: Request, res: Response) => {
  const cap = await tierCap(req.user!.sub);
  const data = await getRadar(parseQuery(req, cap));
  return sendSuccess(res, 'Early Opportunity Radar loaded.', data);
});

// GET /api/v1/early-opportunity-radar/candidates — filtered candidate list.
export const getCandidatesCtrl = asyncHandler(async (req: Request, res: Response) => {
  const cap = await tierCap(req.user!.sub);
  const data = await getRadar(parseQuery(req, cap));
  return sendSuccess(res, 'Candidates loaded.', { candidates: data.candidates });
});

// GET /api/v1/early-opportunity-radar/candidates/:id
export const getCandidateCtrl = asyncHandler(async (req: Request, res: Response) => {
  const data = await getCandidateById(req.params.id);
  return sendSuccess(res, 'Candidate loaded.', data);
});

export const getNetworksCtrl = asyncHandler(async (_req: Request, res: Response) => sendSuccess(res, 'Networks loaded.', await getNetworks()));
export const getNarrativesCtrl = asyncHandler(async (_req: Request, res: Response) => sendSuccess(res, 'Narratives loaded.', await getNarratives()));
export const getSourceStatusCtrl = asyncHandler(async (_req: Request, res: Response) => sendSuccess(res, 'Source status loaded.', await getSourceStatus()));
