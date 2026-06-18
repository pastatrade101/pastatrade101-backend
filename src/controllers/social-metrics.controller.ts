import { supabase } from '../config/supabase';
import { normalizeMinMax } from '../services/scoring/risk';
import { readSeries } from '../services/series/store';
import { trendsProvider } from '../services/sources/google-trends.client';
import { computeSocialRisk, metricMeaning, type SocialResult } from '../services/social/social-risk';

// Note which Trends provider supplied active data (SerpApi vs unofficial).
const labelTrendsProvider = (s: SocialResult['source_status']) => {
  if (s.google_trends === 'Active') s.google_trends = trendsProvider() === 'serpapi' ? 'Active (SerpApi)' : 'Active (unofficial)';
  return s;
};
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';

interface SocialRow {
  date: string;
  google_trends_bitcoin: number | null;
  google_trends_btc: number | null;
  google_trends_bitcoin_price: number | null;
  google_trends_buy_bitcoin: number | null;
  google_trends_crypto: number | null;
  google_trends_altcoins: number | null;
  wikipedia_bitcoin_views: number | null;
  wikipedia_cryptocurrency_views: number | null;
  wikipedia_ethereum_views: number | null;
  fear_greed_index: number | null;
  youtube_bitcoin_attention: number | null;
  social_risk_score: number | null;
}

const loadRows = async (): Promise<SocialRow[]> => {
  const { data, error } = await supabase
    .from('btc_social_metrics')
    .select(
      'date, google_trends_bitcoin, google_trends_btc, google_trends_bitcoin_price, google_trends_buy_bitcoin, google_trends_crypto, google_trends_altcoins, wikipedia_bitcoin_views, wikipedia_cryptocurrency_views, wikipedia_ethereum_views, fear_greed_index, youtube_bitcoin_attention, social_risk_score'
    )
    .order('date', { ascending: true });
  if (error) throw new AppError('Unable to load social metrics.', 500, [error]);
  return (data ?? []) as SocialRow[];
};

// Sources lag differently (Wikipedia is 1–2 days behind, Trends weekly), so the
// "current" reading uses each column's most recent NON-NULL value, not strictly
// today's row.
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

// Combined + per-page Wikipedia risk (latest available value per page).
const wikiRisks = (rows: SocialRow[]) => {
  const risk = (key: keyof SocialRow) => latestNonNull(normalizeMinMax(rows.map((r) => (r[key] == null ? null : Math.log((r[key] as number) + 1)))));
  const b = risk('wikipedia_bitcoin_views');
  const c = risk('wikipedia_cryptocurrency_views');
  const e = risk('wikipedia_ethereum_views');
  const combined = [
    { w: 0.6, v: b },
    { w: 0.25, v: c },
    { w: 0.15, v: e }
  ].filter((p) => p.v != null) as { w: number; v: number }[];
  const combinedRisk = combined.length ? combined.reduce((s, p) => s + p.w * p.v, 0) / combined.reduce((s, p) => s + p.w, 0) : null;
  return { bitcoin: b, cryptocurrency: c, ethereum: e, combined: combinedRisk };
};

interface SocialSnapshot {
  google_trends_bitcoin: number | null;
  google_trends_btc: number | null;
  google_trends_bitcoin_price: number | null;
  google_trends_buy_bitcoin: number | null;
  google_trends_crypto: number | null;
  google_trends_altcoins: number | null;
  wikipedia_bitcoin_views: number | null;
  wikipedia_cryptocurrency_views: number | null;
  wikipedia_ethereum_views: number | null;
  fear_greed_index: number | null;
  youtube_bitcoin_attention: number | null;
}

const computeFromLatest = (rows: SocialRow[]): { snapshot: SocialSnapshot; result: SocialResult; wiki: ReturnType<typeof wikiRisks>; as_of: string } => {
  const snapshot: SocialSnapshot = {
    google_trends_bitcoin: lastVal(rows, 'google_trends_bitcoin'),
    google_trends_btc: lastVal(rows, 'google_trends_btc'),
    google_trends_bitcoin_price: lastVal(rows, 'google_trends_bitcoin_price'),
    google_trends_buy_bitcoin: lastVal(rows, 'google_trends_buy_bitcoin'),
    google_trends_crypto: lastVal(rows, 'google_trends_crypto'),
    google_trends_altcoins: lastVal(rows, 'google_trends_altcoins'),
    wikipedia_bitcoin_views: lastVal(rows, 'wikipedia_bitcoin_views'),
    wikipedia_cryptocurrency_views: lastVal(rows, 'wikipedia_cryptocurrency_views'),
    wikipedia_ethereum_views: lastVal(rows, 'wikipedia_ethereum_views'),
    fear_greed_index: lastVal(rows, 'fear_greed_index'),
    youtube_bitcoin_attention: lastVal(rows, 'youtube_bitcoin_attention')
  };
  const wiki = wikiRisks(rows);
  const result = computeSocialRisk({
    trends_bitcoin: snapshot.google_trends_bitcoin,
    trends_bitcoin_price: snapshot.google_trends_bitcoin_price,
    fear_greed: snapshot.fear_greed_index,
    wikipedia_risk: wiki.combined,
    youtube_attention: snapshot.youtube_bitcoin_attention == null ? null : snapshot.youtube_bitcoin_attention / 100
  });
  return { snapshot, result, wiki, as_of: rows[rows.length - 1].date };
};

// GET /api/v1/social-metrics/btc  → latest metrics + computed risk + meanings
export const getLatest = asyncHandler(async (_req, res) => {
  const rows = await loadRows();
  if (!rows.length) throw new AppError('Social metrics not synced yet. Run a social-metrics sync first.', 503);
  const { snapshot, result, wiki, as_of } = computeFromLatest(rows);

  const trendsRow = (key: string, label: string, value: number | null) => ({
    key,
    label,
    value: value == null ? null : `${Math.round(value)}/100`,
    risk: value == null ? null : Number((value / 100).toFixed(3)),
    status: value == null ? 'Pending' : 'Active',
    meaning: metricMeaning(key, value),
    source: 'Google Trends'
  });
  const wikiRow = (label: string, views: number | null, risk: number | null) => ({
    key: 'wikipedia',
    label,
    value: views == null ? null : `${Math.round(views).toLocaleString()} views`,
    risk: risk == null ? null : Number(risk.toFixed(3)),
    status: views == null ? 'Unavailable' : 'Active',
    meaning: metricMeaning('wikipedia', views),
    source: 'Wikipedia'
  });

  const metrics = [
    trendsRow('google_trends_bitcoin', 'Google Trends: Bitcoin', snapshot.google_trends_bitcoin),
    trendsRow('google_trends_btc', 'Google Trends: BTC', snapshot.google_trends_btc),
    trendsRow('google_trends_bitcoin_price', 'Google Trends: Bitcoin price', snapshot.google_trends_bitcoin_price),
    trendsRow('google_trends_buy_bitcoin', 'Google Trends: Buy Bitcoin', snapshot.google_trends_buy_bitcoin),
    trendsRow('google_trends_crypto', 'Google Trends: Crypto', snapshot.google_trends_crypto),
    trendsRow('google_trends_altcoins', 'Google Trends: Altcoins', snapshot.google_trends_altcoins),
    wikiRow('Wikipedia: Bitcoin', snapshot.wikipedia_bitcoin_views, wiki.bitcoin),
    wikiRow('Wikipedia: Cryptocurrency', snapshot.wikipedia_cryptocurrency_views, wiki.cryptocurrency),
    wikiRow('Wikipedia: Ethereum', snapshot.wikipedia_ethereum_views, wiki.ethereum),
    {
      key: 'fear_greed',
      label: 'Fear & Greed Index',
      value: snapshot.fear_greed_index == null ? null : `${snapshot.fear_greed_index}`,
      risk: snapshot.fear_greed_index == null ? null : Number((snapshot.fear_greed_index / 100).toFixed(3)),
      status: snapshot.fear_greed_index == null ? 'Unavailable' : 'Active',
      meaning: metricMeaning('fear_greed', snapshot.fear_greed_index),
      source: 'Fear & Greed'
    },
    {
      key: 'youtube',
      label: 'YouTube Attention',
      value: snapshot.youtube_bitcoin_attention == null ? null : `${Math.round(snapshot.youtube_bitcoin_attention)}/100`,
      risk: snapshot.youtube_bitcoin_attention == null ? null : Number((snapshot.youtube_bitcoin_attention / 100).toFixed(3)),
      status: snapshot.youtube_bitcoin_attention == null ? 'Unavailable' : 'Active',
      meaning: metricMeaning('youtube', snapshot.youtube_bitcoin_attention),
      source: 'YouTube'
    }
  ];

  return sendSuccess(res, 'Social metrics fetched successfully.', {
    as_of,
    social_risk_score: result.score,
    label: result.label,
    coverage_status: result.coverage_status,
    interpretation: result.interpretation,
    source_status: labelTrendsProvider(result.source_status),
    metrics
  });
});

// GET /api/v1/social-metrics/btc/history  → chart series (+ BTC price overlay)
export const getHistory = asyncHandler(async (_req, res) => {
  const [rows, btc] = await Promise.all([loadRows(), readSeries('btc-full')]);
  if (!rows.length) throw new AppError('Social metrics not synced yet.', 503);
  const priceByDate = new Map(btc.map((p) => [p.date, p.value]));
  const series = rows.map((r) => ({
    date: r.date,
    trends_bitcoin: r.google_trends_bitcoin,
    trends_bitcoin_price: r.google_trends_bitcoin_price,
    wikipedia_bitcoin_views: r.wikipedia_bitcoin_views,
    fear_greed: r.fear_greed_index,
    youtube_attention: r.youtube_bitcoin_attention,
    social_risk_score: r.social_risk_score,
    btc_price: priceByDate.get(r.date) ?? null
  }));
  return sendSuccess(res, 'Social metrics history fetched successfully.', { series });
});

// GET /api/v1/social-metrics/btc/risk-score
export const getRiskScore = asyncHandler(async (_req, res) => {
  const rows = await loadRows();
  if (!rows.length) throw new AppError('Social metrics not synced yet.', 503);
  const { result, as_of } = computeFromLatest(rows);
  return sendSuccess(res, 'Social risk score fetched successfully.', {
    as_of,
    social_risk_score: result.score,
    label: result.label,
    coverage_status: result.coverage_status,
    interpretation: result.interpretation
  });
});

// GET /api/v1/social-metrics/btc/source-status
export const getSourceStatus = asyncHandler(async (_req, res) => {
  const rows = await loadRows();
  if (!rows.length) {
    return sendSuccess(res, 'Source status fetched.', {
      as_of: null,
      source_status: {
        google_trends: 'Pending official API access',
        wikipedia: 'Unavailable',
        fear_greed: 'Unavailable',
        youtube: 'Unavailable'
      }
    });
  }
  const { result, as_of } = computeFromLatest(rows);
  return sendSuccess(res, 'Source status fetched.', { as_of, source_status: labelTrendsProvider(result.source_status) });
});
