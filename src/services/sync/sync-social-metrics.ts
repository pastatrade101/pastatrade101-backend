import { supabase } from '../../config/supabase';
import { getFearGreedHistory } from '../sources/alternativeme.client';
import type { DailyPoint } from '../sources/blockchaincom.client';
import { getTrends, getTrendsBatch, trendsProvider } from '../sources/google-trends.client';
import { getWikipediaViews } from '../sources/wikimedia.client';
import { getYoutubeAttention } from '../sources/youtube.client';
import { normalizeMinMax } from '../scoring/risk';
import { computeSocialRisk } from '../social/social-risk';

const ADD_DAYS = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = () => new Date().toISOString().slice(0, 10);

// Forward-fill: last known value on or before `date` (Trends is weekly).
const ffMap = (points: DailyPoint[]) => {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return (date: string): number | null => {
    let v: number | null = null;
    for (const p of sorted) {
      if (p.date <= date) v = p.value;
      else break;
    }
    return v;
  };
};

const riskByDate = (points: DailyPoint[]): Map<string, number | null> => {
  const arr = normalizeMinMax(points.map((p) => Math.log(p.value + 1)));
  return new Map(points.map((p, i) => [p.date, arr[i]]));
};

const logSource = async (source_name: string, status: string, records_processed: number, error_message?: string) => {
  await supabase.from('social_metric_sync_logs').insert({
    source_name,
    status,
    finished_at: new Date().toISOString(),
    records_processed,
    error_message: error_message ?? null
  });
};

/**
 * Populate btc_social_metrics for the last ~400 days. Google Trends + YouTube are
 * graceful optional sources; Wikipedia (Bitcoin/Cryptocurrency/Ethereum) + Fear &
 * Greed are reliable. Each source is logged independently so one failure can't
 * break the whole sync.
 */
const KEYWORDS = ['Bitcoin', 'BTC', 'Bitcoin price', 'Buy Bitcoin', 'Crypto', 'Altcoins'];

// Rebuild the Trends series from already-stored rows (0 API calls).
const readStoredTrends = async (): Promise<Record<string, DailyPoint[]>> => {
  const { data } = await supabase
    .from('btc_social_metrics')
    .select('date, google_trends_bitcoin, google_trends_btc, google_trends_bitcoin_price, google_trends_buy_bitcoin, google_trends_crypto, google_trends_altcoins')
    .order('date', { ascending: true });
  const col: Record<string, keyof NonNullable<typeof data>[number]> = {
    Bitcoin: 'google_trends_bitcoin',
    BTC: 'google_trends_btc',
    'Bitcoin price': 'google_trends_bitcoin_price',
    'Buy Bitcoin': 'google_trends_buy_bitcoin',
    Crypto: 'google_trends_crypto',
    Altcoins: 'google_trends_altcoins'
  };
  const out: Record<string, DailyPoint[]> = {};
  for (const kw of KEYWORDS) {
    out[kw] = (data ?? [])
      .map((r) => ({ date: r.date as string, value: Number(r[col[kw]]) }))
      .filter((p) => Number.isFinite(p.value));
  }
  return out;
};

export const syncSocialMetrics = async (): Promise<number> => {
  // Trends: SerpApi free tier is ~250 searches/month, so fetch at most ~weekly
  // (the data is weekly) and reuse stored values in between. Batched = 2 calls
  // when we do fetch. Unofficial connector (free) is fetched per-keyword.
  const provider = trendsProvider();
  let trends: Record<string, DailyPoint[]>;
  let trendsFetched = false;
  if (provider === 'serpapi') {
    const { data: lastT } = await supabase
      .from('btc_social_metrics')
      .select('date')
      .not('google_trends_bitcoin', 'is', null)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    const stale = !lastT || (Date.now() - Date.parse(`${lastT.date}T00:00:00Z`)) / 86_400_000 > 6;
    if (stale) {
      const [b1, b2] = await Promise.all([getTrendsBatch(KEYWORDS.slice(0, 5)), getTrendsBatch(KEYWORDS.slice(5))]);
      trends = { ...b1, ...b2 };
      trendsFetched = true;
    } else {
      trends = await readStoredTrends();
    }
  } else {
    const arr = await Promise.all(KEYWORDS.map((k) => getTrends(k)));
    trends = Object.fromEntries(KEYWORDS.map((k, i) => [k, arr[i]]));
    trendsFetched = arr.some((s) => s.length > 0);
  }

  const [wBtc, wCrypto, wEth, fng, youtube] = await Promise.all([
    getWikipediaViews('Bitcoin').catch(() => [] as DailyPoint[]),
    getWikipediaViews('Cryptocurrency').catch(() => [] as DailyPoint[]),
    getWikipediaViews('Ethereum').catch(() => [] as DailyPoint[]),
    getFearGreedHistory().catch(() => [] as DailyPoint[]),
    getYoutubeAttention().catch(() => null)
  ]);

  // Per-source logs (non-fatal).
  await Promise.all([
    logSource('google_trends', trends.Bitcoin.length ? (trendsFetched ? 'success' : 'reused-cache') : 'skipped', trends.Bitcoin.length),
    logSource('wikipedia', wBtc.length ? 'success' : 'failed', wBtc.length),
    logSource('fear_greed', fng.length ? 'success' : 'failed', fng.length),
    logSource('youtube', youtube ? 'success' : 'skipped', youtube ? 1 : 0)
  ]).catch(() => {});

  const ff = {
    bitcoin: ffMap(trends.Bitcoin),
    btc: ffMap(trends.BTC),
    price: ffMap(trends['Bitcoin price']),
    buy: ffMap(trends['Buy Bitcoin']),
    crypto: ffMap(trends.Crypto),
    alt: ffMap(trends.Altcoins)
  };
  const wViewB = new Map(wBtc.map((p) => [p.date, p.value]));
  const wViewC = new Map(wCrypto.map((p) => [p.date, p.value]));
  const wViewE = new Map(wEth.map((p) => [p.date, p.value]));
  const wRiskB = riskByDate(wBtc);
  const wRiskC = riskByDate(wCrypto);
  const wRiskE = riskByDate(wEth);
  const fgByDate = new Map(fng.map((p) => [p.date, p.value]));

  // Combined Wikipedia risk (Bitcoin 0.6 / Cryptocurrency 0.25 / Ethereum 0.15) over available pages.
  const wikiRisk = (date: string): number | null => {
    const parts = [
      { w: 0.6, v: wRiskB.get(date) ?? null },
      { w: 0.25, v: wRiskC.get(date) ?? null },
      { w: 0.15, v: wRiskE.get(date) ?? null }
    ].filter((p) => p.v != null) as { w: number; v: number }[];
    if (!parts.length) return null;
    return parts.reduce((s, p) => s + p.w * p.v, 0) / parts.reduce((s, p) => s + p.w, 0);
  };

  const end = TODAY();
  const rows: Record<string, unknown>[] = [];
  let date = ADD_DAYS(end, -400);
  while (date <= end) {
    const gb = ff.bitcoin(date);
    const gp = ff.price(date);
    const fg = fgByDate.get(date) ?? null;
    const wRisk = wikiRisk(date);
    const yt = date === end && youtube ? youtube.attention : null; // snapshot → today only

    if (gb != null || wRisk != null || fg != null || yt != null) {
      const result = computeSocialRisk({
        trends_bitcoin: gb,
        trends_bitcoin_price: gp,
        fear_greed: fg,
        wikipedia_risk: wRisk,
        youtube_attention: yt
      });
      rows.push({
        date,
        google_trends_bitcoin: gb,
        google_trends_btc: ff.btc(date),
        google_trends_bitcoin_price: gp,
        google_trends_buy_bitcoin: ff.buy(date),
        google_trends_crypto: ff.crypto(date),
        google_trends_altcoins: ff.alt(date),
        wikipedia_bitcoin_views: wViewB.get(date) ?? null,
        wikipedia_cryptocurrency_views: wViewC.get(date) ?? null,
        wikipedia_ethereum_views: wViewE.get(date) ?? null,
        fear_greed_index: fg,
        youtube_bitcoin_attention: date === end && youtube ? Math.round(youtube.attention * 100) : null,
        youtube_video_count: date === end && youtube ? youtube.video_count : null,
        youtube_top_video_views: date === end && youtube ? youtube.top_video_views : null,
        youtube_comment_activity: date === end && youtube ? youtube.comment_activity : null,
        youtube_like_activity: date === end && youtube ? youtube.like_activity : null,
        social_risk_score: result.score,
        coverage_status: result.coverage_status,
        source_status: result.source_status,
        interpretation: result.interpretation,
        updated_at: new Date().toISOString()
      });
    }
    date = ADD_DAYS(date, 1);
  }

  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase.from('btc_social_metrics').upsert(rows.slice(i, i + 1000), { onConflict: 'date' });
    if (error) throw new Error(`Failed to store social metrics: ${error.message}`);
  }
  return rows.length;
};
