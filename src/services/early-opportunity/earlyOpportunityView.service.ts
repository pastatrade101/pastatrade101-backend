import { supabase } from '../../config/supabase';
import { getCategories } from '../sources/coingeckoRadar.client';
import { getSettings } from './earlyOpportunitySettings.service';
import { buildNarrativeLeaderboard, buildNetworkLeaderboard, buildRadarReportSummary, buildSummary, buildTakeaway, passesCleanFilter, type RadarCandidate, type RadarReportSummary } from './earlyOpportunity.service';

export interface RadarQuery {
  tab?: string; // trending_coins | trending_pools | narratives | all
  view?: string; // clean | all | high_risk | new_pools | trending | dex_only | cex_listed
  network?: string;
  sort?: string; // opportunity | risk | volume | liquidity | trending | price_change | last_updated
  search?: string;
  limit?: number;
}

const sortCmp = (sort?: string) => {
  switch (sort) {
    case 'risk':
      return (a: RadarCandidate, b: RadarCandidate) => b.risk_score - a.risk_score;
    case 'volume':
      return (a: RadarCandidate, b: RadarCandidate) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0);
    case 'liquidity':
      return (a: RadarCandidate, b: RadarCandidate) => (b.liquidity_usd ?? 0) - (a.liquidity_usd ?? 0);
    case 'trending':
      return (a: RadarCandidate, b: RadarCandidate) => (a.trending_rank ?? 999) - (b.trending_rank ?? 999);
    case 'price_change':
      return (a: RadarCandidate, b: RadarCandidate) => (b.price_change_24h ?? 0) - (a.price_change_24h ?? 0);
    default:
      return (a: RadarCandidate, b: RadarCandidate) => b.opportunity_score - a.opportunity_score;
  }
};

const matchesTab = (c: RadarCandidate, tab?: string): boolean => {
  if (!tab || tab === 'all') return true;
  if (tab === 'trending_coins') return c.source_type === 'trending';
  if (tab === 'trending_pools' || tab === 'new_pools') return c.source_type === 'dex_pool';
  return true;
};

const matchesView = (c: RadarCandidate, view: string | undefined, settings: Awaited<ReturnType<typeof getSettings>>): boolean => {
  switch (view) {
    case 'all':
      return true;
    case 'high_risk':
      return c.risk_score > 65;
    case 'new_pools':
      return c.source_type === 'dex_pool' && c.pool_age_hours != null && c.pool_age_hours < 30 * 24;
    case 'dex_only':
      return c.source_type === 'dex_pool';
    case 'cex_listed':
      return c.source_type === 'trending';
    case 'trending':
      return c.quality_badges.includes('Trending');
    case 'clean_watchlist':
      // Stricter than clean: only higher-conviction, lower-noise candidates.
      return (
        passesCleanFilter(c, settings) &&
        c.opportunity_score >= 60 &&
        c.risk_score <= 35 &&
        (c.confidence === 'High' || c.confidence === 'Medium') &&
        !c.risk_flags.includes('Abnormal price spike') &&
        !c.risk_flags.includes('Low liquidity')
      );
    case 'clean':
    default:
      return passesCleanFilter(c, settings);
  }
};

const SOURCES = ['coingecko_trending', 'geckoterminal_trending', 'goplus_security', 'coingecko_categories'];

const sourceStatus = async (): Promise<{ source: string; status: string; last_synced: string | null }[]> => {
  const { data } = await supabase.from('early_opportunity_sync_logs').select('source_name, status, finished_at').order('finished_at', { ascending: false }).limit(40);
  return SOURCES.map((src) => {
    const latest = (data ?? []).find((r) => r.source_name === src);
    let status = 'Unavailable';
    if (latest) {
      const ageH = latest.finished_at ? (Date.now() - Date.parse(latest.finished_at)) / 3_600_000 : 999;
      if (latest.status === 'failed') status = 'Unavailable';
      else if (latest.status === 'partial') status = 'Partial';
      else if (ageH > 24) status = 'Stale';
      else status = 'Active';
    }
    return { source: src, status, last_synced: latest?.finished_at ?? null };
  });
};

export const getRadar = async (q: RadarQuery) => {
  const settings = await getSettings();
  const { data } = await supabase.from('early_opportunity_candidates').select('*').order('opportunity_score', { ascending: false }).limit(500);
  const all = (data ?? []) as unknown as RadarCandidate[];

  const cats = await getCategories().catch(() => []);
  const narratives = buildNarrativeLeaderboard(cats);

  // Filtered list for the table/cards.
  let filtered = all.filter((c) => matchesTab(c, q.tab) && matchesView(c, q.view, settings));
  if (q.network) filtered = filtered.filter((c) => c.network === q.network);
  if (q.search) {
    const s = q.search.toLowerCase();
    filtered = filtered.filter((c) => (c.symbol ?? '').toLowerCase().includes(s) || (c.asset_name ?? '').toLowerCase().includes(s));
  }
  filtered.sort(sortCmp(q.sort));
  if (q.limit && q.limit > 0) filtered = filtered.slice(0, q.limit);

  // Aggregates use the clean universe so summaries aren't skewed by junk.
  const clean = all.filter((c) => passesCleanFilter(c, settings));
  const networks = buildNetworkLeaderboard(clean.length ? clean : all);
  const summary = buildSummary(all, settings, narratives);
  const takeaway = buildTakeaway(all, networks, narratives, settings);
  const lastSeen = all.reduce<string | null>((m, c) => {
    const v = (c as unknown as { last_seen_at?: string }).last_seen_at ?? null;
    return v && (!m || v > m) ? v : m;
  }, null);

  return {
    as_of: lastSeen,
    summary,
    takeaway,
    candidates: filtered,
    networks,
    narratives,
    source_status: await sourceStatus(),
    settings_public: {
      min_liquidity_usd: settings.min_liquidity_usd,
      min_volume_24h: settings.min_volume_24h,
      min_pool_age_hours: settings.min_pool_age_hours
    }
  };
};

export const getCandidateById = async (id: string) => {
  const { data } = await supabase.from('early_opportunity_candidates').select('*').eq('id', id).maybeSingle();
  if (!data) return null;
  const { data: history } = await supabase.from('early_opportunity_history').select('date, price_usd, liquidity_usd, volume_24h, opportunity_score, risk_score').eq('candidate_id', id).order('date', { ascending: true }).limit(120);
  return { ...data, history: history ?? [] };
};

export const getNetworks = async () => {
  const settings = await getSettings();
  const { data } = await supabase.from('early_opportunity_candidates').select('*').limit(500);
  const all = (data ?? []) as unknown as RadarCandidate[];
  const clean = all.filter((c) => passesCleanFilter(c, settings));
  return buildNetworkLeaderboard(clean.length ? clean : all);
};

export const getNarratives = async () => buildNarrativeLeaderboard(await getCategories().catch(() => []));

export const getSourceStatus = sourceStatus;

/** Report summary — assembles stored candidates → buildRadarReportSummary. Null when empty. */
export const getRadarReportSummary = async (): Promise<RadarReportSummary | null> => {
  const settings = await getSettings();
  const { data } = await supabase.from('early_opportunity_candidates').select('*').order('opportunity_score', { ascending: false }).limit(500);
  const all = (data ?? []) as unknown as RadarCandidate[];
  if (!all.length) return null;
  const narratives = buildNarrativeLeaderboard(await getCategories().catch(() => []));
  const clean = all.filter((c) => passesCleanFilter(c, settings));
  const networks = buildNetworkLeaderboard(clean.length ? clean : all);
  return buildRadarReportSummary(all, networks, narratives, settings);
};
