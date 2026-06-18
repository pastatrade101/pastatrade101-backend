import { cached } from '../../utils/cache';
import { fetchJson } from './http';

// blockchain.com Charts API — free, no key. Gives BTC market price back to ~2010,
// which is what makes the long-run risk model (log regression) and the historical
// time-slider meaningful. CoinGecko's free tier only returns ~365 days.
interface BlockchainChart {
  values: { x: number; y: number }[]; // x = unix seconds, y = value
}

const BASE = 'https://api.blockchain.info/charts';

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

const toDaily = (chart: BlockchainChart): DailyPoint[] => {
  // Collapse to one point per calendar day (the series is daily-ish already).
  const byDate = new Map<string, number>();
  for (const { x, y } of chart.values) {
    if (!Number.isFinite(y)) continue;
    byDate.set(new Date(x * 1000).toISOString().slice(0, 10), y);
  }
  return [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
};

/** Full BTC daily close history (USD), oldest → newest. */
export const getBtcPriceHistory = () =>
  cached(
    'bcc:btc-price',
    async () => {
      // sampled=false → true DAILY points (≈6k since 2009). Required so that the
      // 200-day MA / RSI windows mean 200 days, not 200 weekly samples.
      const chart = await fetchJson<BlockchainChart>(
        `${BASE}/market-price?timespan=all&sampled=false&format=json&cors=true`,
        { label: 'blockchain.com market-price' }
      );
      return toDaily(chart);
    },
    3600
  );
