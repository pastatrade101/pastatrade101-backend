import type { DailyPoint } from '../sources/blockchaincom.client';

// The years before the saved CoinGecko history. The free CoinGecko plan returns only
// the last 365 days, so every 'cg:<id>' series starts on the day the price sync first
// ran. `npm run backfill:rotation-prices` stores Binance's daily OPEN — the price at
// 00:00 UTC, the same moment CoinGecko's daily price is taken (they agree within
// ~0.05% on BTC, ETH and SOL) — under 'bn:<id>', for the days before CoinGecko's first.
// Only the Rotation Lab (and the rotation bot, through the same matrix) reads it;
// every other feature keeps CoinGecko-only history.

export const prehistoryKey = (coingeckoId: string) => `bn:${coingeckoId}`;

/** CoinGecko history, preceded by the Binance prehistory for the days before CoinGecko's first. */
export const withPrehistory = (pre: DailyPoint[], cg: DailyPoint[]): DailyPoint[] => {
  if (!cg.length) return cg;
  const first = cg[0].date;
  return [...pre.filter((p) => p.date < first), ...cg];
};

/** One Binance daily candle, reduced to what the backfill needs. */
export interface DailyOpen {
  date: string;
  open: number;
}

export type Prehistory =
  | { ok: true; rows: DailyPoint[]; gapPct: number; overlapDays: number }
  | { ok: false; reason: string; nothingToDo?: boolean };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * What to save for one coin: Binance daily opens from `from` up to the day before the
 * first CoinGecko day. Refused when the two sources disagree on the days both have
 * (the same ticker can be a different token), when they cannot be compared, or when
 * the price moves more than `maxDayMove`× in one day (a redenomination or a reused
 * ticker) — those coins simply start with the CoinGecko history, as before.
 */
export const buildPrehistory = (
  candles: DailyOpen[],
  cg: DailyPoint[],
  from: string,
  { maxGap = 0.03, minOverlap = 20, maxDayMove = 5 } = {}
): Prehistory => {
  if (!cg.length) return { ok: false, reason: 'no CoinGecko history saved' };
  const first = cg[0].date;
  // The listing day's open is the very first trade, often far from the market price.
  const traded = candles.slice(1).filter((c) => Number.isFinite(c.open) && c.open > 0);
  if (!traded.length || traded[0].date >= first) {
    return { ok: false, reason: 'Binance prices start after the saved history', nothingToDo: true };
  }

  const cgByDate = new Map(cg.map((p) => [p.date, p.value]));
  const gaps = traded.filter((c) => cgByDate.has(c.date)).map((c) => Math.abs(c.open / cgByDate.get(c.date)! - 1));
  if (gaps.length < minOverlap) return { ok: false, reason: `only ${gaps.length} day(s) to compare with CoinGecko` };
  const gap = median(gaps);
  if (gap > maxGap) {
    return { ok: false, reason: `Binance price is ${(gap * 100).toFixed(1)}% away from CoinGecko — possibly a different token` };
  }

  const rows = traded.filter((c) => c.date >= from && c.date < first).map((c) => ({ date: c.date, value: c.open }));
  if (!rows.length) return { ok: false, reason: `nothing between ${from} and ${first}`, nothingToDo: true };

  const path = [...rows, cg[0]];
  for (let i = 1; i < path.length; i += 1) {
    const move = path[i].value / path[i - 1].value;
    if (move > maxDayMove || move < 1 / maxDayMove) {
      return { ok: false, reason: `price moves ${move.toFixed(2)}× in one day on ${path[i].date} — check by hand` };
    }
  }
  return { ok: true, rows, gapPct: gap * 100, overlapDays: gaps.length };
};
