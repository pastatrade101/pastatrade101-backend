// Binance daily candles from the public market-data API — no key, no account.
// The daily OPEN is the price at 00:00 UTC, the same moment CoinGecko's daily price is
// taken, so it lines up with the saved 'cg:<id>' series (see rotation-backtest/prehistory.ts).

const KLINES = 'https://api.binance.com/api/v3/klines';
const DAY = 86_400_000;

export interface DailyOpen {
  date: string;
  open: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Daily opens for a pair between two dates (inclusive), or null when Binance has no such pair. */
export const fetchDailyOpens = async (symbol: string, start: string, end: string): Promise<DailyOpen[] | null> => {
  const out: DailyOpen[] = [];
  let cursor = dayMs(start);
  const stop = dayMs(end);
  while (cursor <= stop) {
    const q = new URLSearchParams({ symbol, interval: '1d', startTime: String(cursor), endTime: String(stop), limit: '1000' });
    const res = await fetch(`${KLINES}?${q}`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as unknown;
    if (!res.ok) {
      const code = (body as { code?: number })?.code;
      if (res.status === 400 && code === -1121) return null; // invalid symbol: no such pair
      throw new Error(`Binance klines ${symbol}: HTTP ${res.status} ${JSON.stringify(body)}`);
    }
    const rows = body as [number, string, ...unknown[]][];
    for (const k of rows) out.push({ date: isoDay(k[0]), open: Number(k[1]) });
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1][0] + DAY;
    await sleep(150);
  }
  return out;
};
