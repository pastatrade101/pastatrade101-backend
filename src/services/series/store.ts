import { supabase } from '../../config/supabase';
import { cached } from '../../utils/cache';
import type { DailyPoint } from '../sources/blockchaincom.client';

export interface SeriesRow {
  date: string;
  price: number | null;
  market_cap: number | null;
  volume: number | null;
}

const CHUNK = 1000;

/** Upsert a daily series under `seriesKey` (chunked; safe to re-run). */
export const upsertSeries = async (seriesKey: string, rows: SeriesRow[]): Promise<number> => {
  const payload = rows.map((r) => ({
    series_key: seriesKey,
    snapshot_date: r.date,
    price: r.price,
    market_cap: r.market_cap,
    volume: r.volume
  }));
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await supabase
      .from('daily_prices')
      .upsert(payload.slice(i, i + CHUNK), { onConflict: 'series_key,snapshot_date' });
    if (error) throw new Error(`Failed to store series ${seriesKey}: ${error.message}`);
  }
  return payload.length;
};

// Paginated read — daily_prices can exceed PostgREST's default 1000-row cap
// (btc-full is ~6k rows), so page through it. Cached in-memory so repeated Lab
// reads don't re-hit the DB every request.
const readRows = (seriesKey: string): Promise<SeriesRow[]> =>
  cached(
    `series:${seriesKey}`,
    async () => {
      const out: SeriesRow[] = [];
      for (let from = 0; ; from += CHUNK) {
        const { data, error } = await supabase
          .from('daily_prices')
          .select('snapshot_date, price, market_cap, volume')
          .eq('series_key', seriesKey)
          .order('snapshot_date', { ascending: true })
          .range(from, from + CHUNK - 1);
        if (error) throw new Error(`Failed to read series ${seriesKey}: ${error.message}`);
        if (!data?.length) break;
        out.push(...data.map((d) => ({ date: d.snapshot_date, price: d.price, market_cap: d.market_cap, volume: d.volume })));
        if (data.length < CHUNK) break;
      }
      return out;
    },
    300
  );

export const readSeriesFull = (seriesKey: string): Promise<SeriesRow[]> => readRows(seriesKey);

/** Read a series as DailyPoint[] (price only), dropping rows with no price. */
export const readSeries = async (seriesKey: string): Promise<DailyPoint[]> => {
  const rows = await readRows(seriesKey);
  return rows
    .filter((r): r is SeriesRow & { price: number } => r.price != null && Number.isFinite(r.price))
    .map((r) => ({ date: r.date, value: r.price }));
};
