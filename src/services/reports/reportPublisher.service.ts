import { randomBytes } from 'crypto';
import { supabase } from '../../config/supabase';
import { AppError } from '../../utils/api-response';
import { buildSnapshot, type ReportSnapshot, type ReportType } from './reportData.service';
import { generateReport, marketPosture, type Audience, type GenerateOptions, type Language, type Tone } from './reportGenerator.service';

// reportPublisher.service — persistence + lifecycle for reports: generate a
// draft (pull snapshot → generate → store report + sections + log), update,
// publish, archive, and build shareable exports (WhatsApp / Telegram / public
// preview / Swahili).

const DEFAULT_SECTIONS: Record<ReportType, string[]> = {
  // Daily — short + tactical, easy to share.
  daily: ['market_status', 'what_changed', 'btc_risk', 'altcoin_btc', 'ecosystem', 'exit_strategy', 'risk_warnings', 'premium_takeaway', 'disclaimer'],
  // Weekly — trend development.
  weekly: ['market_status', 'what_changed', 'btc_risk', 'onchain', 'social', 'altcoin_btc', 'ecosystem', 'strongest_signals', 'weakest_areas', 'exit_strategy', 'confirmation_needed', 'risk_warnings', 'premium_takeaway', 'data_coverage', 'disclaimer'],
  // Monthly — full market structure.
  monthly: ['market_status', 'executive_summary', 'what_changed', 'market_posture', 'btc_risk', 'btc_cycle', 'onchain', 'social', 'altcoin_btc', 'ecosystem', 'strongest_signals', 'weakest_areas', 'exit_strategy', 'exit_simulation_example', 'confirmation_needed', 'risk_warnings', 'premium_takeaway', 'data_coverage', 'disclaimer'],
  special: ['market_status', 'executive_summary', 'what_changed', 'btc_risk', 'risk_warnings', 'premium_takeaway', 'disclaimer'],
  premium: ['market_status', 'executive_summary', 'what_changed', 'market_posture', 'btc_risk', 'btc_cycle', 'onchain', 'social', 'altcoin_btc', 'ecosystem', 'strongest_signals', 'weakest_areas', 'exit_strategy', 'exit_simulation_example', 'confirmation_needed', 'risk_warnings', 'premium_takeaway', 'data_coverage', 'disclaimer'],
  preview: ['market_status', 'executive_summary', 'market_posture', 'disclaimer']
};

const slugify = (type: string, date: string): string => `${type}-${date}-${randomBytes(2).toString('hex')}`;

export interface GenerateInput {
  type: ReportType;
  audience?: Audience;
  language?: Language;
  tone?: Tone;
  report_date?: string; // defaults to today
  sections?: string[]; // overrides defaults
  userId: string;
}

export const generateDraft = async (input: GenerateInput) => {
  const type = input.type;
  const reportDate = input.report_date ?? new Date().toISOString().slice(0, 10);
  const audience: Audience = input.audience ?? 'premium';
  const language: Language = input.language ?? 'en';
  const tone: Tone = input.tone ?? 'professional';
  const sections = input.sections?.length ? input.sections : DEFAULT_SECTIONS[type] ?? DEFAULT_SECTIONS.daily;

  const snapshot = await buildSnapshot(type, reportDate);
  const opts: GenerateOptions = { type, audience, language, tone, sections, report_date: reportDate };
  const gen = generateReport(snapshot, opts);

  const { data: report, error } = await supabase
    .from('reports')
    .insert({
      title: gen.title,
      slug: slugify(type, reportDate),
      report_type: type,
      audience,
      language,
      tone,
      status: 'generated',
      summary: gen.summary,
      premium_takeaway: gen.premium_takeaway,
      market_status: gen.market_status,
      scorecard: gen.scorecard,
      content: gen.content,
      preview: gen.preview,
      quality: gen.quality,
      data_snapshot: snapshot,
      generated_by: input.userId,
      report_date: reportDate,
      period_start: snapshot.period.start,
      period_end: snapshot.period.end
    })
    .select('*')
    .single();
  if (error || !report) throw new AppError('Failed to save report draft.', 500, error ? [error] : []);

  const sectionRows = gen.sections.map((s) => ({
    report_id: report.id,
    section_key: s.section_key,
    section_title: s.section_title,
    content: s.content,
    data: s.data,
    sort_order: s.sort_order,
    is_enabled: true,
    is_premium: s.is_premium
  }));
  if (sectionRows.length) await supabase.from('report_sections').insert(sectionRows);

  await supabase.from('report_generation_logs').insert({
    report_id: report.id,
    status: gen.quality.passed ? 'success' : 'success_with_warnings',
    source_modules: snapshot.availability,
    error_message: gen.quality.warnings.length ? gen.quality.warnings.join(' | ') : null
  });

  return report;
};

export const getReportWithSections = async (idOrSlug: string) => {
  const column = /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(idOrSlug) ? 'id' : 'slug';
  const { data: report } = await supabase.from('reports').select('*').eq(column, idOrSlug).maybeSingle();
  if (!report) return null;
  const { data: sections } = await supabase.from('report_sections').select('*').eq('report_id', report.id).order('sort_order', { ascending: true });
  return { report, sections: sections ?? [] };
};

export const updateReport = async (id: string, fields: Record<string, unknown>) => {
  const allowed = ['title', 'summary', 'premium_takeaway', 'content', 'status', 'audience', 'tone', 'market_status', 'cover_image_url'];
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in fields) patch[k] = fields[k];
  const { data, error } = await supabase.from('reports').update(patch).eq('id', id).select('*').single();
  if (error) throw new AppError('Failed to update report.', 500, [error]);

  // Optional per-section edits: [{ id, content, is_enabled, section_title }]
  const sectionEdits = fields.sections as { id: string; content?: string; is_enabled?: boolean; section_title?: string }[] | undefined;
  if (Array.isArray(sectionEdits)) {
    for (const s of sectionEdits) {
      const sp: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (s.content !== undefined) sp.content = s.content;
      if (s.is_enabled !== undefined) sp.is_enabled = s.is_enabled;
      if (s.section_title !== undefined) sp.section_title = s.section_title;
      await supabase.from('report_sections').update(sp).eq('id', s.id).eq('report_id', id);
    }
  }
  return data;
};

export const publishReport = async (id: string, userId: string) => {
  const { data, error } = await supabase
    .from('reports')
    .update({ status: 'published', published_at: new Date().toISOString(), reviewed_by: userId, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new AppError('Failed to publish report.', 500, [error]);
  return data;
};

export const archiveReport = async (id: string) => {
  const { data, error } = await supabase.from('reports').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
  if (error) throw new AppError('Failed to archive report.', 500, [error]);
  return data;
};

export type ExportType = 'whatsapp' | 'telegram' | 'public_preview' | 'swahili';

interface ReportRow {
  id: string;
  title: string;
  report_type: ReportType;
  language: Language;
  summary: string | null;
  premium_takeaway: string | null;
  preview: string | null;
  market_status: { regime: string; btc_risk: string; altcoin: string; social: string } | null;
  data_snapshot: unknown;
}

const DISCLAIMER_SHORT = 'Not financial advice.';

export const buildShareExport = async (report: ReportRow, type: ExportType): Promise<string> => {
  let content: string;
  const ms = report.market_status;
  const snap = (report.data_snapshot ?? null) as ReportSnapshot | null;
  const typeLabel = report.report_type.charAt(0).toUpperCase() + report.report_type.slice(1);

  if (type === 'whatsapp') {
    const signals = (snap?.altcoin?.strongest ?? []).slice(0, 4).map((c, i) => `${i + 1}. ${c.symbol}/BTC — ${c.label || 'Strength'}`);
    const posture = snap ? marketPosture(snap, 'en').label : ms?.regime ?? '';
    content = [
      `Pastatrade Market Intelligence — ${typeLabel} Update`,
      '',
      report.summary ?? '',
      ...(signals.length ? ['', 'Strongest signals:', ...signals] : []),
      ...(posture ? ['', `Market posture: ${posture}`] : []),
      '',
      `Premium takeaway:\n${report.premium_takeaway ?? ''}`,
      '',
      DISCLAIMER_SHORT
    ].join('\n');
  } else if (type === 'telegram') {
    content = [
      `*${report.title}*`,
      '',
      ms ? `• Market regime: ${ms.regime}` : '',
      ms ? `• BTC risk: ${ms.btc_risk}` : '',
      ms ? `• Altcoin: ${ms.altcoin}` : '',
      ms ? `• Social: ${ms.social}` : '',
      '',
      report.summary ?? '',
      '',
      `Premium takeaway: ${report.premium_takeaway ?? ''}`,
      '',
      DISCLAIMER_SHORT
    ]
      .filter((l) => l !== '')
      .join('\n');
  } else if (type === 'public_preview') {
    content = `${report.preview ?? report.summary ?? ''}\n\n${DISCLAIMER_SHORT}`;
  } else {
    // Swahili: regenerate the summary/takeaway in natural Kiswahili from the snapshot.
    if (snap) {
      const gen = generateReport(snap, { type: report.report_type, audience: 'public', language: 'sw', tone: 'whatsapp', sections: ['market_status', 'executive_summary', 'premium_takeaway', 'disclaimer'], report_date: new Date().toISOString().slice(0, 10) });
      const signals = (snap.altcoin?.strongest ?? []).slice(0, 3).map((c, i) => `${i + 1}. ${c.symbol}/BTC — ${c.label || 'Nguvu'}`);
      const posture = marketPosture(snap, 'sw').label;
      content = [
        `Pastatrade — Taarifa ya Soko (${typeLabel})`,
        '',
        gen.summary,
        ...(signals.length ? ['', 'Ishara imara:', ...signals] : []),
        '',
        `Msimamo wa soko: ${posture}`,
        '',
        `Hitimisho: ${gen.premium_takeaway}`,
        '',
        'Si ushauri wa kifedha.'
      ].join('\n');
    } else {
      content = report.summary ?? '';
    }
  }

  await supabase.from('report_share_exports').insert({ report_id: report.id, export_type: type, content });
  return content;
};
