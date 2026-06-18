import { env } from '../../config/env';
import { cached } from '../../utils/cache';
import { fetchJson } from './http';

// YouTube Data API v3 (free tier, quota-limited). Optional: needs YOUTUBE_API_KEY.
// Returns a current "Bitcoin attention" snapshot, or null if no key / failure.
// Snapshot only (the API has no history) — the sync accumulates daily values.

const BASE = 'https://www.googleapis.com/youtube/v3';

export interface YoutubeAttention {
  attention: number; // 0–1
  video_count: number;
  top_video_views: number;
  comment_activity: number;
  like_activity: number;
}

export const YOUTUBE_AVAILABLE = (): boolean => Boolean(env.YOUTUBE_API_KEY);

// log10 scaled into [lo,hi] → 0..1
const logScale = (v: number, lo: number, hi: number): number => {
  if (v <= 0) return 0;
  return Math.max(0, Math.min(1, (Math.log10(v) - lo) / (hi - lo)));
};

export const getYoutubeAttention = (): Promise<YoutubeAttention | null> =>
  cached(
    'youtube:btc-attention',
    async () => {
      if (!env.YOUTUBE_API_KEY) return null;
      const key = env.YOUTUBE_API_KEY;
      try {
        const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
        // Most-viewed recent Bitcoin videos.
        const search = await fetchJson<{ items: { id: { videoId: string } }[]; pageInfo?: { totalResults?: number } }>(
          `${BASE}/search?part=id&q=Bitcoin&type=video&order=viewCount&maxResults=10&publishedAfter=${encodeURIComponent(since)}&key=${key}`,
          { label: 'youtube search', retries: 1 }
        );
        const ids = (search.items ?? []).map((i) => i.id?.videoId).filter(Boolean).join(',');
        const videoCount = search.pageInfo?.totalResults ?? (search.items?.length ?? 0);
        if (!ids) return { attention: 0, video_count: videoCount, top_video_views: 0, comment_activity: 0, like_activity: 0 };

        const stats = await fetchJson<{ items: { statistics: { viewCount?: string; commentCount?: string; likeCount?: string } }[] }>(
          `${BASE}/videos?part=statistics&id=${ids}&key=${key}`,
          { label: 'youtube videos', retries: 1 }
        );
        let views = 0;
        let comments = 0;
        let likes = 0;
        for (const v of stats.items ?? []) {
          views += Number(v.statistics?.viewCount ?? 0);
          comments += Number(v.statistics?.commentCount ?? 0);
          likes += Number(v.statistics?.likeCount ?? 0);
        }

        // Heuristic normalization (no historical baseline available from the API).
        const viewsRisk = logScale(views, 6, 9); // 1M → 1B
        const countRisk = logScale(videoCount, 3, 6); // 1k → 1M recent uploads
        const commentsRisk = logScale(comments, 3, 6);
        const likesRisk = logScale(likes, 4, 7);
        const attention = Number((0.4 * viewsRisk + 0.25 * countRisk + 0.2 * commentsRisk + 0.15 * likesRisk).toFixed(3));

        return { attention, video_count: videoCount, top_video_views: views, comment_activity: comments, like_activity: likes };
      } catch {
        return null;
      }
    },
    3600
  );
