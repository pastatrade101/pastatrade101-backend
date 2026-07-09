import { env } from '../config/env';

// Latest uploads from the Pastatrade101 YouTube channel, for the landing page.
// Uses the existing YOUTUBE_API_KEY. Cached in-memory (1h) and fully graceful —
// any failure (no key, quota, network) returns [] so the section just hides.

export interface YtVideo {
  id: string;
  title: string;
  published_at: string;
  views: number | null;
  likes: number | null;
}

const HANDLE = (process.env.YOUTUBE_CHANNEL_HANDLE || 'pastatrade101').replace(/^@/, '');
const TTL_MS = 60 * 60 * 1000;
let cache: { at: number; items: YtVideo[] } | null = null;
let uploadsPlaylistId: string | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ytGet = async (path: string): Promise<any | null> => {
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}&key=${env.YOUTUBE_API_KEY}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

const resolveUploadsPlaylist = async (): Promise<string | null> => {
  if (uploadsPlaylistId) return uploadsPlaylistId;
  const data = await ytGet(`channels?part=contentDetails&forHandle=${encodeURIComponent(HANDLE)}`);
  const id = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
  if (id) uploadsPlaylistId = id;
  return id;
};

export const getChannelVideos = async (limit = 6): Promise<YtVideo[]> => {
  if (!env.YOUTUBE_API_KEY) return [];
  if (cache && Date.now() - cache.at < TTL_MS) return cache.items.slice(0, limit);

  const playlist = await resolveUploadsPlaylist();
  if (!playlist) return cache?.items.slice(0, limit) ?? [];

  const data = await ytGet(`playlistItems?part=snippet&maxResults=${Math.min(12, Math.max(limit, 6))}&playlistId=${playlist}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: YtVideo[] = (data?.items ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((it: any) => ({ id: it?.snippet?.resourceId?.videoId as string, title: (it?.snippet?.title as string) ?? '', published_at: (it?.snippet?.publishedAt as string) ?? '', views: null, likes: null }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((v: YtVideo) => v.id && v.title !== 'Private video' && v.title !== 'Deleted video');

  // One extra call to attach view/like counts for the returned videos.
  if (items.length) {
    const stats = await ytGet(`videos?part=statistics&id=${items.map((v) => v.id).join(',')}`);
    const byId = new Map<string, { views: number | null; likes: number | null }>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const it of (stats?.items ?? []) as any[]) {
      byId.set(it.id, {
        views: it?.statistics?.viewCount != null ? Number(it.statistics.viewCount) : null,
        likes: it?.statistics?.likeCount != null ? Number(it.statistics.likeCount) : null
      });
    }
    for (const v of items) {
      const s = byId.get(v.id);
      if (s) {
        v.views = s.views;
        v.likes = s.likes;
      }
    }
  }

  if (items.length) cache = { at: Date.now(), items };
  return (cache?.items ?? items).slice(0, limit);
};
