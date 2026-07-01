import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { listPublicIcoProjects, getIcoProject, icoProjectsToCsv } from '../services/ico-intelligence/icoIntelligence.service';
import { ICO_DISCLAIMER } from '../services/ico-intelligence/icoScoring.service';

// Public Early Project Radar API — approved + published projects only.
// Mounted behind requireFeature('access_early_project_radar').

export const getIcoProjectsCtrl = asyncHandler(async (req, res) => {
  const items = await listPublicIcoProjects({
    status: getQueryString(req.query, 'status') || undefined,
    classification: getQueryString(req.query, 'classification') || undefined,
    search: getQueryString(req.query, 'search') || undefined
  });
  return sendSuccess(res, 'ICO projects loaded.', { items, disclaimer: ICO_DISCLAIMER });
});

export const getIcoProjectCtrl = asyncHandler(async (req, res) => {
  const p = await getIcoProject(req.params.id);
  if (!p || p.admin_status !== 'approved' || !p.is_published) throw new AppError('ICO project not found.', 404);
  return sendSuccess(res, 'ICO project loaded.', { project: p, disclaimer: ICO_DISCLAIMER });
});

export const exportIcoCsvCtrl = asyncHandler(async (_req, res) => {
  const items = await listPublicIcoProjects({ limit: 200 });
  const csv = icoProjectsToCsv(items as Record<string, unknown>[]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="early-project-radar.csv"');
  return res.send(csv);
});
