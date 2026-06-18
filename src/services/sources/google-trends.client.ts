import { env } from '../../config/env';
import { cached } from '../../utils/cache';
import { fetchJson } from './http';
import type { DailyPoint } from './blockchaincom.client';

// Google Trends provider chain (per spec):
//   1. SerpApi Google Trends — preferred, reliable paid provider (SERPAPI_API_KEY).
//   2. Unofficial `google-trends-api` scraper — temporary fallback (rate-limits/breaks).
//   3. None — returns [] so the Social Risk Score recomputes from other sources.
// Google has an official Trends API in limited/alpha access; until production
// access is approved, Trends is treated as a pluggable optional source.

export type TrendsProvider = 'serpapi' | 'unofficial' | 'none';

export const trendsProvider = (): TrendsProvider => (env.SERPAPI_API_KEY ? 'serpapi' : 'unofficial');

// ── 1. SerpApi ────────────────────────────────────────────────────────────
interface SerpTimeline {
  interest_over_time?: {
    timeline_data?: { timestamp?: string; values?: { extracted_value?: number }[] }[];
  };
  error?: string;
}

const serpApiTrends = async (keyword: string): Promise<DailyPoint[]> => {
  const url =
    `https://serpapi.com/search.json?engine=google_trends&data_type=TIMESERIES` +
    `&q=${encodeURIComponent(keyword)}&date=${encodeURIComponent('today 12-m')}&api_key=${env.SERPAPI_API_KEY}`;
  const json = await fetchJson<SerpTimeline>(url, { label: 'SerpApi google_trends', retries: 1 });
  const timeline = json.interest_over_time?.timeline_data ?? [];
  return timeline
    .map((d) => ({
      date: new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10),
      value: Number(d.values?.[0]?.extracted_value)
    }))
    .filter((p) => p.date !== 'Invalid Date' && Number.isFinite(p.value));
};

// ── 2. Unofficial scraper (dynamic import so a missing package can't crash) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any | null = null;
let tried = false;
const loadUnofficial = async () => {
  if (tried) return mod;
  tried = true;
  try {
    const imported = await import('google-trends-api');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod = (imported as any).default ?? imported;
  } catch {
    mod = null;
  }
  return mod;
};

const unofficialTrends = async (keyword: string): Promise<DailyPoint[]> => {
  const gt = await loadUnofficial();
  if (!gt) return [];
  const raw: string = await gt.interestOverTime({ keyword, startTime: new Date(Date.now() - 365 * 86_400_000) });
  const json = JSON.parse(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const timeline: any[] = json?.default?.timelineData ?? [];
  return timeline
    .map((d) => ({ date: new Date(Number(d.time) * 1000).toISOString().slice(0, 10), value: Number(d.value?.[0]) }))
    .filter((p) => Number.isFinite(p.value));
};

export const TRENDS_AVAILABLE = async (): Promise<boolean> => Boolean(env.SERPAPI_API_KEY) || Boolean(await loadUnofficial());

/** Weekly interest-over-time (0–100) for a keyword. [] on any failure. */
export const getTrends = (keyword: string): Promise<DailyPoint[]> =>
  cached(
    `trends:${keyword}`,
    async () => {
      try {
        if (env.SERPAPI_API_KEY) return await serpApiTrends(keyword);
        return await unofficialTrends(keyword);
      } catch {
        return [];
      }
    },
    3600
  );

interface SerpBatch {
  interest_over_time?: {
    timeline_data?: { timestamp?: string; values?: { query?: string; extracted_value?: number }[] }[];
  };
}

/**
 * Fetch up to 5 keywords in ONE SerpApi request (comma-separated q) to conserve
 * the free-tier quota — each timeline point carries one value per keyword (in
 * order). Falls back to per-keyword unofficial calls when no SerpApi key.
 * Cached 6h.
 */
export const getTrendsBatch = (keywords: string[]): Promise<Record<string, DailyPoint[]>> =>
  cached(
    `trends:batch:${keywords.join('|')}`,
    async () => {
      const out: Record<string, DailyPoint[]> = {};
      keywords.forEach((k) => (out[k] = []));
      try {
        if (env.SERPAPI_API_KEY) {
          const q = keywords.slice(0, 5).join(',');
          const url =
            `https://serpapi.com/search.json?engine=google_trends&data_type=TIMESERIES` +
            `&q=${encodeURIComponent(q)}&date=${encodeURIComponent('today 12-m')}&api_key=${env.SERPAPI_API_KEY}`;
          const json = await fetchJson<SerpBatch>(url, { label: 'SerpApi google_trends batch', retries: 1 });
          for (const d of json.interest_over_time?.timeline_data ?? []) {
            const date = new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10);
            if (date === 'Invalid Date') continue;
            (d.values ?? []).forEach((v, i) => {
              const kw = keywords[i];
              const val = Number(v.extracted_value);
              if (kw && Number.isFinite(val)) out[kw].push({ date, value: val });
            });
          }
          return out;
        }
        for (const k of keywords) out[k] = await unofficialTrends(k);
        return out;
      } catch {
        return out;
      }
    },
    6 * 3600
  );
