import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { listPublicIcoProjects, getIcoProject, icoProjectsToCsv } from '../services/ico-intelligence/icoIntelligence.service';
import { ICO_DISCLAIMER } from '../services/ico-intelligence/icoScoring.service';
import { resolveUserAccess, canAccess, cheapestPlanWith, limitFor } from '../services/membership/plan-access';

// Public Early Project Radar API. Approved + published projects only. Soft-gated:
// entitled plans see everything; others get an admin-tunable preview (the
// max_early_project_preview plan limit; default 1, 0 = hidden) + upgrade info.
const DEFAULT_PREVIEW = 1;

export const getIcoProjectsCtrl = asyncHandler(async (req, res) => {
  const access = await resolveUserAccess(req.user!.sub);
  const entitled = canAccess(access, 'access_early_project_radar');

  const items = await listPublicIcoProjects({
    status: entitled ? getQueryString(req.query, 'status') || undefined : undefined,
    classification: entitled ? getQueryString(req.query, 'classification') || undefined : undefined,
    search: entitled ? getQueryString(req.query, 'search') || undefined : undefined
  });

  if (entitled) return sendSuccess(res, 'ICO projects loaded.', { items, locked: false, disclaimer: ICO_DISCLAIMER });

  // Preview size is a per-plan limit the admin controls (null → default).
  const configured = limitFor(access, 'max_early_project_preview');
  const previewCount = Math.max(0, configured ?? DEFAULT_PREVIEW);
  const required_plan = await cheapestPlanWith('access_early_project_radar');
  return sendSuccess(res, 'ICO projects preview.', {
    items: items.slice(0, previewCount),
    locked: true,
    total: items.length,
    required_plan,
    disclaimer: ICO_DISCLAIMER
  });
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
