import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { generateDraft, getReportWithSections, updateReport, publishReport, archiveReport, buildShareExport, type ExportType } from '../services/reports/reportPublisher.service';
import type { ReportType } from '../services/reports/reportData.service';
import type { Audience, Language, Tone } from '../services/reports/reportGenerator.service';

// Admin report management: generate, edit, publish, archive, export + templates.
// Mounted under /api/v1/admin (admin-only middleware applied by the router).

const ADMIN_LIST_FIELDS = 'id, slug, title, report_type, audience, language, tone, status, report_date, published_at, created_at, quality';

export const adminListReports = asyncHandler(async (req: Request, res: Response) => {
  const status = getQueryString(req.query, 'status');
  const type = getQueryString(req.query, 'type');
  let q = supabase.from('reports').select(ADMIN_LIST_FIELDS).order('created_at', { ascending: false }).limit(100);
  if (status) q = q.eq('status', status);
  if (type) q = q.eq('report_type', type);
  const { data, error } = await q;
  if (error) throw new AppError('Unable to load reports.', 500, [error]);
  return sendSuccess(res, 'Reports fetched successfully.', { items: data ?? [] });
});

export const adminGenerateReport = asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const report = await generateDraft({
    type: (typeof b.type === 'string' ? b.type : 'daily') as ReportType,
    audience: b.audience as Audience | undefined,
    language: b.language as Language | undefined,
    tone: b.tone as Tone | undefined,
    report_date: typeof b.report_date === 'string' ? b.report_date : undefined,
    sections: Array.isArray(b.sections) ? (b.sections as string[]) : undefined,
    userId: req.user!.sub
  });
  return sendSuccess(res, 'Report draft generated successfully.', report, 201);
});

export const adminGetReport = asyncHandler(async (req: Request, res: Response) => {
  const bundle = await getReportWithSections(req.params.id);
  if (!bundle) throw new AppError('Report not found.', 404);
  return sendSuccess(res, 'Report fetched successfully.', bundle);
});

export const adminUpdateReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await updateReport(req.params.id, (req.body ?? {}) as Record<string, unknown>);
  return sendSuccess(res, 'Report updated successfully.', data);
});

export const adminPublishReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await publishReport(req.params.id, req.user!.sub);
  return sendSuccess(res, 'Report published successfully.', data);
});

export const adminArchiveReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await archiveReport(req.params.id);
  return sendSuccess(res, 'Report archived successfully.', data);
});

export const adminExportReport = asyncHandler(async (req: Request, res: Response) => {
  const bundle = await getReportWithSections(req.params.id);
  if (!bundle) throw new AppError('Report not found.', 404);
  const type = ((req.body?.type as string) ?? 'whatsapp') as ExportType;
  const content = await buildShareExport(bundle.report, type);
  return sendSuccess(res, 'Export generated successfully.', { export_type: type, content });
});

// ── Templates CRUD ──
export const adminListTemplates = asyncHandler(async (_req: Request, res: Response) => {
  const { data, error } = await supabase.from('report_templates').select('*').order('created_at', { ascending: true });
  if (error) throw new AppError('Unable to load templates.', 500, [error]);
  return sendSuccess(res, 'Templates fetched successfully.', { items: data ?? [] });
});

export const adminCreateTemplate = asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!b.name || !b.report_type) throw new AppError('Template name and report_type are required.', 400);
  const { data, error } = await supabase
    .from('report_templates')
    .insert({
      name: b.name,
      report_type: b.report_type,
      audience: b.audience ?? 'premium',
      language: b.language ?? 'en',
      tone: b.tone ?? 'professional',
      sections: b.sections ?? null,
      prompt_template: b.prompt_template ?? null,
      is_active: b.is_active ?? true
    })
    .select('*')
    .single();
  if (error) throw new AppError('Unable to create template.', 500, [error]);
  return sendSuccess(res, 'Template created successfully.', data, 201);
});

export const adminUpdateTemplate = asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const allowed = ['name', 'report_type', 'audience', 'language', 'tone', 'sections', 'prompt_template', 'is_active'];
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in b) patch[k] = b[k];
  const { data, error } = await supabase.from('report_templates').update(patch).eq('id', req.params.id).select('*').single();
  if (error) throw new AppError('Unable to update template.', 500, [error]);
  return sendSuccess(res, 'Template updated successfully.', data);
});

export const adminDeleteTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { error } = await supabase.from('report_templates').delete().eq('id', req.params.id);
  if (error) throw new AppError('Unable to delete template.', 500, [error]);
  return sendSuccess(res, 'Template deleted successfully.', { id: req.params.id });
});
