import { cached } from '../../utils/cache';
import { fetchJson } from './http';
import type { DailyPoint } from './blockchaincom.client';

// Wikimedia REST pageviews — free, no key, daily since mid-2015.
// Daily views of the English "Bitcoin" article as a free "social attention" proxy.
interface PageviewsResponse {
  items: { timestamp: string; views: number }[];
}

const start = '20150701';
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

/** Daily pageviews for any English-Wikipedia article (e.g. Bitcoin, Cryptocurrency, Ethereum). */
export const getWikipediaViews = (article: string) =>
  cached(
    `wiki:views:${article}`,
    async (): Promise<DailyPoint[]> => {
      const url =
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/` +
        `en.wikipedia.org/all-access/all-agents/${encodeURIComponent(article)}/daily/${start}/${today()}`;
      const res = await fetchJson<PageviewsResponse>(url, {
        headers: { 'user-agent': 'Pastatrade/0.1 (crypto intelligence dashboard)' },
        label: `wikimedia pageviews/${article}`
      }).catch(() => ({ items: [] }) as PageviewsResponse);

      return res.items
        .map((i) => ({
          date: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`,
          value: i.views
        }))
        .filter((p) => Number.isFinite(p.value))
        .sort((a, b) => a.date.localeCompare(b.date));
    },
    3600
  );

export const getBitcoinWikipediaViews = () => getWikipediaViews('Bitcoin');
