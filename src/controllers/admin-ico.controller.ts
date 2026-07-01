import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { withJob } from '../services/sync/sync-jobs';
import { runIcoSync } from '../services/ico-intelligence/icoSync.service';
import { listAdminIcoProjects, getIcoProject, reviewIcoProject, icoProjectsToCsv, type ReviewInput } from '../services/ico-intelligence/icoIntelligence.service';
import { icoSourceStatus } from '../services/sources/icodrops.client';
import { cryptorankSourceStatus } from '../services/sources/cryptorank.client';
import { listWatch, addWatch, removeWatch } from '../services/ico-intelligence/cryptorankWatch.service';

// Admin ICO / Early Project Radar management. Mounted under /api/v1/admin (admin-only).

export const adminListIcoCtrl = asyncHandler(async (req, res) => {
  const items = await listAdminIcoProjects({
    admin_status: getQueryString(req.query, 'admin_status') || undefined,
    status: getQueryString(req.query, 'status') || undefined,
    classification: getQueryString(req.query, 'classification') || undefined,
    search: getQueryString(req.query, 'search') || undefined
  });
  const cryptorank = cryptorankSourceStatus();
  const icodrops = icoSourceStatus();
  const watch = await listWatch().catch(() => []);
  return sendSuccess(res, 'ICO projects loaded.', {
    items,
    watch,
    source: { enabled: cryptorank.enabled || icodrops.enabled, cryptorank, icodrops }
  });
});

// POST /admin/ico-projects/watch — track a CryptoRank project by slug/id/symbol.
export const adminAddWatchCtrl = asyncHandler(async (req, res) => {
  const ref = String((req.body ?? {}).ref ?? '');
  const row = await addWatch(ref, req.user!.sub);
  return sendSuccess(res, 'Tracked project added.', { watch: row });
});

// DELETE /admin/ico-projects/watch/:id — stop tracking.
export const adminRemoveWatchCtrl = asyncHandler(async (req, res) => {
  await removeWatch(req.params.id);
  return sendSuccess(res, 'Tracked project removed.', {});
});

export const adminGetIcoCtrl = asyncHandler(async (req, res) => {
  const project = await getIcoProject(req.params.id);
  return sendSuccess(res, 'ICO project loaded.', { project });
});

export const adminReviewIcoCtrl = asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as ReviewInput;
  const project = await reviewIcoProject(req.params.id, {
    admin_status: body.admin_status,
    admin_note: body.admin_note,
    is_published: body.is_published,
    reviewer: req.user!.sub
  });
  return sendSuccess(res, 'ICO project updated.', { project });
});

export const adminSyncIcoCtrl = asyncHandler(async (req, res) => {
  const result = await withJob('ico-radar', 'ico', req.user!.sub, () => runIcoSync());
  return sendSuccess(res, 'ICO sync completed.', result);
});

export const adminExportIcoCsvCtrl = asyncHandler(async (_req, res) => {
  const items = await listAdminIcoProjects({ limit: 500 });
  const csv = icoProjectsToCsv(items as Record<string, unknown>[]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ico-projects-all.csv"');
  return res.send(csv);
});
