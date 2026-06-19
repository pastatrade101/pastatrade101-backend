import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryNumber } from '../utils/query';
import { getReportWithSections } from '../services/reports/reportPublisher.service';

// Public, SEO-facing view of published reports. Returns only non-premium,
// indexable content (market status + the free sections + teaser). Full premium
// sections, takeaway and the raw data_snapshot are never exposed here.

const LIST_FIELDS = 'id, slug, title, report_type, report_date, published_at, preview, market_status';

// GET /api/v1/insights — published reports (teaser-level), newest first.
export const listInsights = asyncHandler(async (req, res) => {
  const limit = Math.min(getQueryNumber(req.query, 'limit') ?? 30, 50);
  const { data, error } = await supabase
    .from('reports')
    .select(LIST_FIELDS)
    .eq('status', 'published')
    .order('report_date', { ascending: false })
    .limit(limit);
  if (error) throw new AppError('Unable to load insights.', 500, [error]);
  return sendSuccess(res, 'Insights fetched successfully.', { items: data ?? [] });
});

// GET /api/v1/insights/:slug — one published report, public sections only.
export const getInsight = asyncHandler(async (req, res) => {
  const bundle = await getReportWithSections(req.params.slug);
  if (!bundle || bundle.report.status !== 'published') throw new AppError('Insight not found.', 404);
  const r = bundle.report as Record<string, unknown>;

  const sections = bundle.sections
    .filter((s) => s.is_enabled && !s.is_premium)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => ({ section_key: s.section_key, section_title: s.section_title, content: s.content }));

  return sendSuccess(res, 'Insight fetched successfully.', {
    report: {
      id: r.id,
      slug: r.slug,
      title: r.title,
      report_type: r.report_type,
      report_date: r.report_date,
      published_at: r.published_at,
      preview: r.preview,
      market_status: r.market_status,
      language: r.language
    },
    sections
  });
});
