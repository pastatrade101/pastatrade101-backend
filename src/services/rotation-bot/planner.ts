import { decide, rankAt, type FilterKind, type RankRow, type SignalKind } from '../rotation-backtest/engine';
import type { UniverseCoin } from '../rotation-backtest/rotationData.service';
import type { SymbolRules } from './sizing';

// What the bot should do on a review — pure, no I/O, so it can be tested.
// Ranking and keep/drop/add come from the Rotation Lab engine (rankAt + decide), so
// the bot follows exactly the rule the backtest measured.

export type StyleKey = 'steady' | 'balanced' | 'bold';

export interface BotStyle {
  key: StyleKey;
  label: string;
  /** How many of the top coins by market cap (that Binance trades) form the universe. */
  universeSize: number;
  signal: SignalKind;
  filter: FilterKind;
  lookbackDays: number;
  topN: number;
  worstRankHeld: number;
  rebalanceDays: number;
}

// Mirrors STYLES in frontend/src/routes/app/rotation-lab/+page.svelte — keep them in step.
export const STYLES: Record<StyleKey, BotStyle> = {
  steady: { key: 'steady', label: 'Steady', universeSize: 10, signal: 'risk_adjusted', filter: 'positive', lookbackDays: 30, topN: 3, worstRankHeld: 5, rebalanceDays: 30 },
  balanced: { key: 'balanced', label: 'Balanced', universeSize: 20, signal: 'momentum', filter: 'none', lookbackDays: 30, topN: 3, worstRankHeld: 5, rebalanceDays: 7 },
  bold: { key: 'bold', label: 'Bold', universeSize: 50, signal: 'momentum', filter: 'none', lookbackDays: 30, topN: 3, worstRankHeld: 5, rebalanceDays: 7 }
};

export const addDays = (isoDate: string, days: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Reviews run every `rebalanceDays` from the bot's own last review; the first run is a review. */
export const reviewStatus = (lastReview: string | null, today: string, rebalanceDays: number) => {
  if (!lastReview) return { due: true, nextReview: today, daysLeft: 0 };
  const nextReview = addDays(lastReview, rebalanceDays);
  return { due: today >= nextReview, nextReview, daysLeft: Math.max(0, dayDiff(today, nextReview)) };
};

export interface BotCoin {
  id: string;
  asset: string;
  rules: SymbolRules;
  /** Latest saved daily close (CoinGecko). */
  close: number;
  /** Current Binance price. */
  price: number;
}

const lastValid = (series: (number | null)[], upto: number): number | null => {
  for (let i = upto; i >= 0; i -= 1) {
    const v = series[i];
    if (v != null && Number.isFinite(v) && v > 0) return v;
  }
  return null;
};

/**
 * The bot's universe: coins in market-cap order that have a tradable USDT pair on
 * Binance, until `size` are found. A coin whose Binance price is far from its
 * CoinGecko close is skipped — the same ticker can be a different token.
 */
export const pickUniverse = (
  coins: UniverseCoin[],
  prices: Record<string, (number | null)[]>,
  lastIdx: number,
  pairs: Map<string, SymbolRules>,
  livePrices: Map<string, number>,
  size: number,
  tolerance = 0.3
) => {
  const picked: BotCoin[] = [];
  const skipped: { asset: string; reason: string }[] = [];
  for (const c of coins) {
    if (picked.length >= size) break;
    const rules = pairs.get(c.symbol);
    if (!rules) {
      skipped.push({ asset: c.symbol, reason: 'no USDT pair on Binance' });
      continue;
    }
    const close = lastValid(prices[c.id] ?? [], lastIdx);
    const price = livePrices.get(rules.symbol);
    if (close == null || price == null || !(price > 0)) {
      skipped.push({ asset: c.symbol, reason: 'no price' });
      continue;
    }
    const gap = Math.abs(price / close - 1);
    if (gap > tolerance) {
      skipped.push({ asset: c.symbol, reason: `Binance price is ${(gap * 100).toFixed(0)}% away from CoinGecko — possibly a different token` });
      continue;
    }
    picked.push({ id: c.id, asset: c.symbol, rules, close, price });
  }
  return { picked, skipped };
};

/** Today's ranking of the bot's universe, by the style's signal and filter. */
export const rankUniverse = (
  universe: BotCoin[],
  prices: Record<string, (number | null)[]>,
  btc: (number | null)[],
  style: BotStyle,
  idx: number
): RankRow[] => {
  const sub: Record<string, (number | null)[]> = {};
  for (const c of universe) sub[c.id] = prices[c.id];
  return rankAt({ prices: sub, btc }, style.signal, style.lookbackDays, idx, style.filter);
};

export type DropReason = 'fell out of the hold band' | 'stopped passing the filter' | 'left the universe';

/** One review: which holdings to sell (and why) and which coins fill the free slots. */
export const planReview = (held: string[], ranking: RankRow[], universeIds: Set<string>, style: BotStyle) => {
  const r = decide([...held].sort(), ranking, style);
  const drops = [...r.drops].map(([coin, kind]) => ({
    coin,
    reason: (kind === 'rank'
      ? 'fell out of the hold band'
      : universeIds.has(coin)
        ? 'stopped passing the filter'
        : 'left the universe') as DropReason
  }));
  return { keep: r.keep, drops, adds: r.adds };
};

/**
 * USDT to spend per new coin, like the backtest: each slot gets 1/topN of the
 * sleeve's equity at the time of buying, capped by the cash left. Binance takes the
 * trading fee from the coins received, so the USDT spent is exactly the amount.
 */
export const buyAmounts = (adds: string[], cash: number, equity: number, topN: number, slotsFree: number) => {
  const target = equity / topN;
  let left = cash;
  const out: { coin: string; amount: number }[] = [];
  for (const coin of adds.slice(0, Math.max(0, slotsFree))) {
    const amount = Math.min(target, left);
    if (!(amount > 0)) break;
    out.push({ coin, amount });
    left -= amount;
  }
  return out;
};
