import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { resolveUserAccess } from '../services/membership/plan-access';
import { resolveReportView, canExportReports } from '../services/reports/reportAccess.service';
import { getReportWithSections, buildShareExport, type ExportType } from '../services/reports/reportPublisher.service';

// User-facing report endpoints. Everything is plan-gated via reportAccess:
// Free → preview; Mid → daily/weekly full; Premium → all full; admins → full.

const LIST_FIELDS = 'id, slug, title, report_type, audience, language, tone, report_date, published_at, preview, status, cover_image_url';

export const listReports = asyncHandler(async (req: Request, res: Response) => {
  const type = getQueryString(req.query, 'type');
  let q = supabase.from('reports').select(LIST_FIELDS).eq('status', 'published').order('report_date', { ascending: false }).limit(50);
  if (type) q = q.eq('report_type', type);
  const { data, error } = await q;
  if (error) throw new AppError('Unable to load reports.', 500, [error]);

  const access = await resolveUserAccess(req.user!.sub);
  const items = (data ?? []).map((r) => ({ ...r, view: resolveReportView(access, r) }));
  return sendSuccess(res, 'Reports fetched successfully.', { items });
});

const respondWithView = async (req: Request, res: Response, idOrSlug: string) => {
  const bundle = await getReportWithSections(idOrSlug);
  if (!bundle || bundle.report.status !== 'published') throw new AppError('Report not found.', 404);

  const access = await resolveUserAccess(req.user!.sub);
  const view = resolveReportView(access, bundle.report);

  if (view === 'full') {
    return sendSuccess(res, 'Report fetched successfully.', {
      view,
      report: bundle.report,
      sections: bundle.sections.filter((s) => s.is_enabled),
      can_export: canExportReports(access)
    });
  }

  // Preview: keep non-premium sections, lock premium ones, hide full content.
  const sections = bundle.sections
    .filter((s) => s.is_enabled)
    .map((s) => (s.is_premium ? { ...s, content: null, locked: true } : { ...s, locked: false }));
  const report = { ...bundle.report, content: null, premium_takeaway: null, data_snapshot: null };
  return sendSuccess(res, 'Report preview fetched.', { view, report, sections, can_export: false });
};

export const getReportBySlug = asyncHandler(async (req: Request, res: Response) => respondWithView(req, res, req.params.slug));

const latestOfType = async (type: string | null): Promise<string | null> => {
  let q = supabase.from('reports').select('slug').eq('status', 'published').order('report_date', { ascending: false }).limit(1);
  if (type) q = q.eq('report_type', type);
  const { data } = await q.maybeSingle();
  return data?.slug ?? null;
};

const latestHandler = (type: string | null) =>
  asyncHandler(async (req: Request, res: Response) => {
    const slug = await latestOfType(type);
    if (!slug) throw new AppError('No published report available yet.', 404);
    return respondWithView(req, res, slug);
  });

export const getLatest = latestHandler(null);
export const getLatestDaily = latestHandler('daily');
export const getLatestWeekly = latestHandler('weekly');
export const getLatestMonthly = latestHandler('monthly');

// Share/export — public preview is open to any member; whatsapp/telegram need
// full view (and the export feature) so previews aren't leaked as full copy.
const shareHandler = (type: ExportType) =>
  asyncHandler(async (req: Request, res: Response) => {
    const bundle = await getReportWithSections(req.params.id);
    if (!bundle || bundle.report.status !== 'published') throw new AppError('Report not found.', 404);

    const access = await resolveUserAccess(req.user!.sub);
    if (type !== 'public_preview') {
      const view = resolveReportView(access, bundle.report);
      if (view !== 'full' || !canExportReports(access)) throw new AppError('Exports require a plan with full report access.', 403);
    }
    const content = await buildShareExport(bundle.report, type);
    return sendSuccess(res, 'Share export generated.', { export_type: type, content });
  });

export const shareWhatsapp = shareHandler('whatsapp');
export const shareTelegram = shareHandler('telegram');
export const sharePublicPreview = shareHandler('public_preview');
