import { loadPriceMatrix, type PriceMatrix } from '../rotation-backtest/rotationData.service';
import { readSeries, upsertSeries } from '../series/store';
import { fetchDailyOpens } from '../sources/binanceKlines';
import { cached } from '../../utils/cache';
import type { DailyPoint } from '../sources/blockchaincom.client';

// Stock tokens the Rotation Index may also hold, next to its top-20 coins.
//
// Binance lists US stocks and funds as "bStocks" (SPYB follows the SPY fund, and so on).
// They have no CoinGecko history or market cap, so they can't enter through the top-20
// size cut: on every review they join the coin list as they are and compete in the same
// 30-day ranking. Their daily price is Binance's daily OPEN (the 00:00 UTC price, the same
// moment as CoinGecko's), saved under 'bnx:<SYMBOL>' by the price sync and read back from
// there, like every other price the index uses.
//
// Only the index and the bot that follows it see them; the Rotation Lab and the rest of
// the site keep the CoinGecko coin list.

export interface IndexExtra {
  /** Id inside the index (never a CoinGecko id). */
  id: string;
  /** Binance base asset; the pair is <symbol>USDT. */
  symbol: string;
  name: string;
}

export const INDEX_EXTRAS: readonly IndexExtra[] = [
  { id: 'bstock-spcxb', symbol: 'SPCXB', name: 'SpaceX (bStocks)' },
  { id: 'bstock-spyb', symbol: 'SPYB', name: 'SPY, S&P 500 fund (bStocks)' },
  { id: 'bstock-qqqb', symbol: 'QQQB', name: 'Invesco QQQ, Nasdaq 100 fund (bStocks)' }
];

const EXTRA_IDS = new Set(INDEX_EXTRAS.map((x) => x.id));
export const isIndexExtra = (id: string) => EXTRA_IDS.has(id);
export const extraSeriesKey = (symbol: string) => `bnx:${symbol}`;

/** The price matrix with the extras added (rank 10 000: after every coin, so size cuts never pick them). */
export const mergeExtras = (m: PriceMatrix, seriesBySymbol: Map<string, DailyPoint[]>): PriceMatrix => {
  const at = new Map(m.dates.map((d, i) => [d, i]));
  const prices = { ...m.prices };
  const coins = [...m.coins];
  for (const x of INDEX_EXTRAS) {
    const series = seriesBySymbol.get(x.symbol) ?? [];
    if (!series.length) continue;
    const row: (number | null)[] = new Array(m.dates.length).fill(null);
    for (const p of series) {
      const i = at.get(p.date);
      if (i !== undefined) row[i] = p.value;
    }
    prices[x.id] = row;
    coins.push({ id: x.id, symbol: x.symbol, name: x.name, image: null, rank: 10_000 });
  }
  return { ...m, prices, coins };
};

/** The index's price matrix: the Lab's coins plus the saved stock-token prices. Cached like the Lab's. */
export const loadIndexMatrix = (): Promise<PriceMatrix> =>
  cached(
    'rotation:index-matrix',
    async () => {
      const m = await loadPriceMatrix();
      const saved = await Promise.all(INDEX_EXTRAS.map(async (x) => [x.symbol, await readSeries(extraSeriesKey(x.symbol))] as const));
      return mergeExtras(m, new Map(saved));
    },
    1800
  );

/**
 * For replays: the index's price list, plus Binance's public daily prices for any stock
 * token the sync has not saved yet (fetched for this check only, never saved).
 */
export const loadReplayMatrix = async (): Promise<{ matrix: PriceMatrix; fetched: string[] }> => {
  const m = await loadIndexMatrix();
  const missing = INDEX_EXTRAS.filter((x) => !m.prices[x.id]);
  if (!missing.length) return { matrix: m, fetched: [] };
  const today = new Date().toISOString().slice(0, 10);
  const series = new Map<string, DailyPoint[]>();
  for (const x of missing) {
    const candles = await fetchDailyOpens(`${x.symbol}USDT`, '2025-01-01', today);
    // The listing day's open is the very first trade, often far from the market price.
    if (candles && candles.length > 1) series.set(x.symbol, candles.slice(1).map((c) => ({ date: c.date, value: c.open })));
  }
  return { matrix: mergeExtras(m, series), fetched: [...series.keys()] };
};

/**
 * Save the extras' daily prices (called by the price sync, before the index steps).
 * Fetches the last ~400 days each time, so a missed day fills itself in. The listing
 * day is skipped: its open is the very first trade, often far from the market price.
 */
export const syncIndexExtras = async (): Promise<string[]> => {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const notes: string[] = [];
  for (const x of INDEX_EXTRAS) {
    try {
      const candles = await fetchDailyOpens(`${x.symbol}USDT`, start, today);
      if (!candles) {
        notes.push(`${x.symbol}: no ${x.symbol}USDT pair on Binance`);
        continue;
      }
      const listedInWindow = candles.length > 0 && candles[0].date > start;
      const rows = (listedInWindow ? candles.slice(1) : candles)
        .filter((c) => Number.isFinite(c.open) && c.open > 0)
        .map((c) => ({ date: c.date, price: c.open, market_cap: null, volume: null }));
      if (rows.length) await upsertSeries(extraSeriesKey(x.symbol), rows);
      notes.push(`${x.symbol}: ${rows.length} day(s) to ${rows[rows.length - 1]?.date ?? '—'}`);
    } catch (error) {
      notes.push(`${x.symbol}: skipped (${error instanceof Error ? error.message : error})`);
    }
  }
  return notes;
};
