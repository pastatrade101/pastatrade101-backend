import { supabase } from '../../config/supabase';
import { normalizeMinMax } from '../scoring/risk';
import { computeSocialRisk, socialLabel } from './social-risk';

// ─────────────────────────────────────────────────────────────────────────────
// Shared "latest Social Risk" reader. The Social Metrics module stores its data
// in btc_social_metrics (one row per day, with a pre-computed social_risk_score).
// Sources lag differently (Wikipedia ~1–2 days, Google Trends weekly, YouTube is
// a same-day snapshot), so the current reading uses each column's most recent
// NON-NULL value rather than strictly today's row — matching the Social page.
//
// Preferred: use the stored normalized social_risk_score.
// Fallback:  recompute from whatever sources are active (computeSocialRisk
//            already reweights proportionally over the available sources).
// ─────────────────────────────────────────────────────────────────────────────

export type SocialStatus = 'active' | 'partial' | 'unavailable';

export interface SocialLatest {
  as_of: string | null; // last synced date with any social data
  score: number | null; // 0–1 (higher = more crowd attention / hype risk)
  label: string;
  status: SocialStatus;
  sources_active: string[];
  sources_missing: string[];
  source_status: Record<string, string>;
  interpretation: string;
  coverage_status: string;
  detail: {
    fear_greed: number | null; // 0–100 raw index
    trends_bitcoin: number | null; // 0–100
    trends_btc: number | null; // 0–100
    trends_bitcoin_price: number | null; // 0–100
    wikipedia_risk: number | null; // 0–1
    youtube_attention: number | null; // 0–1
  };
}

interface SocialRow {
  date: string;
  google_trends_bitcoin: number | null;
  google_trends_btc: number | null;
  google_trends_bitcoin_price: number | null;
  wikipedia_bitcoin_views: number | null;
  wikipedia_cryptocurrency_views: number | null;
  wikipedia_ethereum_views: number | null;
  fear_greed_index: number | null;
  youtube_bitcoin_attention: number | null;
  social_risk_score: number | null;
}

const lastVal = (rows: SocialRow[], key: keyof SocialRow): number | null => {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const v = rows[i][key];
    if (v != null) return v as number;
  }
  return null;
};
const latestNonNull = (arr: (number | null)[]): number | null => {
  for (let i = arr.length - 1; i >= 0; i -= 1) if (arr[i] != null) return arr[i];
  return null;
};

// Combined Wikipedia risk (Bitcoin 0.6 / Cryptocurrency 0.25 / Ethereum 0.15) over available pages.
const wikiRisk = (rows: SocialRow[]): number | null => {
  const risk = (key: keyof SocialRow) => latestNonNull(normalizeMinMax(rows.map((r) => (r[key] == null ? null : Math.log((r[key] as number) + 1)))));
  const parts = [
    { w: 0.6, v: risk('wikipedia_bitcoin_views') },
    { w: 0.25, v: risk('wikipedia_cryptocurrency_views') },
    { w: 0.15, v: risk('wikipedia_ethereum_views') }
  ].filter((p) => p.v != null) as { w: number; v: number }[];
  if (!parts.length) return null;
  return parts.reduce((s, p) => s + p.w * p.v, 0) / parts.reduce((s, p) => s + p.w, 0);
};

const ALL_SOURCES = ['Fear & Greed', 'Google Trends', 'Wikipedia', 'YouTube'];

export const readLatestSocialRisk = async (): Promise<SocialLatest> => {
  const empty: SocialLatest = {
    as_of: null,
    score: null,
    label: 'Unavailable',
    status: 'unavailable',
    sources_active: [],
    sources_missing: ALL_SOURCES,
    source_status: { google_trends: 'Unavailable', wikipedia: 'Unavailable', fear_greed: 'Unavailable', youtube: 'Unavailable' },
    interpretation: 'No social data available yet.',
    coverage_status: 'Social metrics unavailable.',
    detail: { fear_greed: null, trends_bitcoin: null, trends_btc: null, trends_bitcoin_price: null, wikipedia_risk: null, youtube_attention: null }
  };

  const { data, error } = await supabase
    .from('btc_social_metrics')
    .select(
      'date, google_trends_bitcoin, google_trends_btc, google_trends_bitcoin_price, wikipedia_bitcoin_views, wikipedia_cryptocurrency_views, wikipedia_ethereum_views, fear_greed_index, youtube_bitcoin_attention, social_risk_score'
    )
    .order('date', { ascending: true });
  if (error || !data?.length) return empty;
  const rows = data as SocialRow[];

  const detail = {
    fear_greed: lastVal(rows, 'fear_greed_index'),
    trends_bitcoin: lastVal(rows, 'google_trends_bitcoin'),
    trends_btc: lastVal(rows, 'google_trends_btc'),
    trends_bitcoin_price: lastVal(rows, 'google_trends_bitcoin_price'),
    wikipedia_risk: wikiRisk(rows),
    youtube_attention: (() => {
      const yt = lastVal(rows, 'youtube_bitcoin_attention');
      return yt == null ? null : yt / 100;
    })()
  };

  const computed = computeSocialRisk({
    trends_bitcoin: detail.trends_bitcoin,
    trends_bitcoin_price: detail.trends_bitcoin_price,
    fear_greed: detail.fear_greed,
    wikipedia_risk: detail.wikipedia_risk,
    youtube_attention: detail.youtube_attention
  });

  // Preferred: stored normalized score; fall back to the freshly computed value.
  const storedScore = lastVal(rows, 'social_risk_score');
  const score = storedScore ?? computed.score;

  const active: string[] = [];
  if (detail.fear_greed != null) active.push('Fear & Greed');
  const trendsActive = detail.trends_bitcoin != null || detail.trends_bitcoin_price != null;
  if (trendsActive) active.push('Google Trends');
  if (detail.wikipedia_risk != null) active.push('Wikipedia');
  if (detail.youtube_attention != null) active.push('YouTube');
  const missing = ALL_SOURCES.filter((s) => !active.includes(s));

  const status: SocialStatus = score == null || !active.length ? 'unavailable' : missing.length === 0 ? 'active' : 'partial';

  return {
    as_of: rows[rows.length - 1].date,
    score: score == null ? null : Number(score.toFixed(3)),
    label: score == null ? 'Unavailable' : socialLabel(score),
    status,
    sources_active: active,
    sources_missing: missing,
    source_status: computed.source_status,
    interpretation: computed.interpretation,
    coverage_status: computed.coverage_status,
    detail
  };
};
