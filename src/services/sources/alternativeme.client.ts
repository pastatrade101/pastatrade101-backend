import { cached } from '../../utils/cache';
import { fetchJson } from './http';
import type { DailyPoint } from './blockchaincom.client';

// alternative.me Crypto Fear & Greed Index — free, no key, daily since Feb 2018.
// Value 0 (extreme fear) → 100 (extreme greed). limit=0 returns the full history.
interface FngResponse {
  data: { value: string; timestamp: string }[];
}

export const getFearGreedHistory = () =>
  cached(
    'altme:fng',
    async (): Promise<DailyPoint[]> => {
      const res = await fetchJson<FngResponse>('https://api.alternative.me/fng/?limit=0&format=json', {
        label: 'alternative.me fng'
      });
      return res.data
        .map((d) => ({
          date: new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10),
          value: Number(d.value)
        }))
        .filter((p) => Number.isFinite(p.value))
        .sort((a, b) => a.date.localeCompare(b.date));
    },
    3600
  );
