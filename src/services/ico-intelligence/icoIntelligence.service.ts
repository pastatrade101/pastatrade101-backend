import { supabase } from '../../config/supabase';
import { AppError } from '../../utils/api-response';
import type { IcoRawProject } from '../sources/icodrops.client';
import { scoreIcoProject } from './icoScoring.service';

// ─────────────────────────────────────────────────────────────────────────────
// ICO intelligence store — dedup, review-preserving upsert, reads + CSV export.
// Projects land as admin_status='pending'; only approved + published rows are
// ever exposed to users.
// ─────────────────────────────────────────────────────────────────────────────

const host = (url: string | null): string => {
  if (!url) return '';
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
};

// Dedup key: project name + token symbol + website host. Matching any renamed
// listing or re-scrape to the same row.
export const dedupKey = (p: { project_name: string; token_symbol: string | null; website: string | null }): string =>
  `${p.project_name.trim().toLowerCase()}|${(p.token_symbol ?? '').trim().toLowerCase()}|${host(p.website)}`;

// Columns refreshed on every ingest. Review columns (admin_status, admin_note,
// reviewed_by, reviewed_at, is_published) are deliberately NOT here — an approved
// project stays approved across re-scrapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dataRow = (p: IcoRawProject, source: string): Record<string, any> => {
  const s = scoreIcoProject(p);
  return {
    dedup_key: dedupKey(p),
    project_name: p.project_name,
    token_symbol: p.token_symbol,
    image_url: p.image_url,
    website: p.website,
    category: p.category,
    description: p.description,
    sale_status: p.sale_status,
    sale_type: p.sale_type,
    sale_date: p.sale_date,
    raise_amount: p.raise_amount,
    raise_amount_text: p.raise_amount_text,
    backers: p.backers,
    social_links: p.social_links,
    whitepaper_url: p.whitepaper_url,
    tokenomics: p.tokenomics,
    vesting: p.vesting,
    score: s.score,
    classification: s.classification,
    score_components: s.components,
    red_flags: s.red_flags,
    source,
    source_url: p.source_url,
    raw: p,
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
};

/**
 * Score + persist a batch of raw projects. New projects are inserted as pending;
 * existing ones (matched by dedup_key) have their DATA refreshed while their admin
 * review state is preserved. Returns { inserted, updated }.
 */
export const storeIcoProjects = async (raws: IcoRawProject[], source = 'icodrops'): Promise<{ inserted: number; updated: number }> => {
  if (!raws.length) return { inserted: 0, updated: 0 };

  // Collapse in-batch duplicates first (last one wins).
  const byKey = new Map<string, IcoRawProject>();
  for (const p of raws) if (p.project_name) byKey.set(dedupKey(p), p);
  const items = [...byKey.values()];
  const keys = [...byKey.keys()];

  // Which keys already exist?
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const { data } = await supabase.from('ico_projects').select('dedup_key').in('dedup_key', keys.slice(i, i + 500));
    for (const r of data ?? []) existing.add(r.dedup_key as string);
  }

  const toInsert = items.filter((p) => !existing.has(dedupKey(p))).map((p) => dataRow(p, source));
  const toUpdate = items.filter((p) => existing.has(dedupKey(p)));

  if (toInsert.length) {
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabase.from('ico_projects').insert(toInsert.slice(i, i + 500));
      if (error) throw new AppError(`Failed to insert ICO projects: ${error.message}`, 500, [error]);
    }
  }
  // Update existing rows' data columns only (review state untouched).
  for (const p of toUpdate) {
    const row = dataRow(p, source);
    await supabase.from('ico_projects').update(row).eq('dedup_key', row.dedup_key);
  }

  return { inserted: toInsert.length, updated: toUpdate.length };
};

// ── Reads ──
const PUBLIC_FIELDS = 'id, project_name, token_symbol, image_url, category, description, sale_status, sale_type, sale_date, raise_amount, raise_amount_text, backers, social_links, website, whitepaper_url, tokenomics, vesting, score, classification, score_components, red_flags, source, source_url, last_checked_at';

export interface IcoListFilters {
  status?: string; // sale status
  classification?: string;
  search?: string;
  limit?: number;
}

/** User-facing list — approved + published only. */
export const listPublicIcoProjects = async (f: IcoListFilters = {}) => {
  let q = supabase.from('ico_projects').select(PUBLIC_FIELDS).eq('admin_status', 'approved').eq('is_published', true).order('score', { ascending: false }).limit(Math.min(f.limit ?? 100, 200));
  if (f.status) q = q.eq('sale_status', f.status);
  if (f.classification) q = q.eq('classification', f.classification);
  if (f.search) q = q.ilike('project_name', `%${f.search}%`);
  const { data, error } = await q;
  if (error) throw new AppError('Unable to load ICO projects.', 500, [error]);
  return data ?? [];
};

/** Admin list — everything, filterable by review status. */
export const listAdminIcoProjects = async (f: IcoListFilters & { admin_status?: string } = {}) => {
  let q = supabase.from('ico_projects').select('*').order('last_checked_at', { ascending: false, nullsFirst: false }).limit(Math.min(f.limit ?? 300, 500));
  if (f.admin_status) q = q.eq('admin_status', f.admin_status);
  if (f.status) q = q.eq('sale_status', f.status);
  if (f.classification) q = q.eq('classification', f.classification);
  if (f.search) q = q.ilike('project_name', `%${f.search}%`);
  const { data, error } = await q;
  if (error) throw new AppError('Unable to load ICO projects.', 500, [error]);
  return data ?? [];
};

export const getIcoProject = async (id: string) => {
  const { data, error } = await supabase.from('ico_projects').select('*').eq('id', id).maybeSingle();
  if (error) throw new AppError('Unable to load ICO project.', 500, [error]);
  return data;
};

// ── Admin review ──
export interface ReviewInput {
  admin_status?: 'pending' | 'approved' | 'rejected';
  admin_note?: string | null;
  is_published?: boolean;
  reviewer?: string;
}

export const reviewIcoProject = async (id: string, input: ReviewInput) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = { reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (input.admin_status) patch.admin_status = input.admin_status;
  if (input.admin_note !== undefined) patch.admin_note = input.admin_note;
  if (input.is_published !== undefined) patch.is_published = input.is_published;
  if (input.reviewer) patch.reviewed_by = input.reviewer;
  // Rejecting always unpublishes.
  if (input.admin_status === 'rejected') patch.is_published = false;
  const { data, error } = await supabase.from('ico_projects').update(patch).eq('id', id).select('*').maybeSingle();
  if (error) throw new AppError('Failed to update ICO project.', 500, [error]);
  if (!data) throw new AppError('ICO project not found.', 404);
  return data;
};

// ── CSV export ──
const csvCell = (v: unknown): string => {
  const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const icoProjectsToCsv = (rows: Record<string, unknown>[]): string => {
  const cols = ['project_name', 'token_symbol', 'category', 'sale_status', 'sale_type', 'sale_date', 'raise_amount', 'score', 'classification', 'backers', 'website', 'whitepaper_url', 'source_url', 'admin_status', 'is_published', 'last_checked_at'];
  const header = cols.join(',');
  const lines = rows.map((r) => cols.map((c) => csvCell(r[c])).join(','));
  return [header, ...lines].join('\n');
};
