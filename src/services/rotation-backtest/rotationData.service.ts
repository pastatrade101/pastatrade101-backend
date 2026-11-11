import { supabase } from '../../config/supabase';
import { cached } from '../../utils/cache';
import { readSeries } from '../series/store';
import { prehistoryKey, withPrehistory } from './prehistory';

// Reads the SAVED daily closes (daily_prices 'cg:<id>', filled by sync:prices, preceded
// by the Binance prehistory 'bn:<id>' from backfill:rotation-prices — see prehistory.ts)
// and aligns them into one date × coin matrix for the rotation engine. Never calls an
// upstream API — same rule as every other Lab.

export interface UniverseCoin {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  rank: number;
}

export interface PriceMatrix {
  dates: string[];
  prices: Record<string, (number | null)[]>;
  coins: UniverseCoin[]; // tradable coins with data, by current market-cap rank
  /** First day of the CoinGecko history; days before it come from Binance (null if there is no prehistory). */
  coingeckoFrom: string | null;
}

// Belt and braces: the volatility filter below already drops these, but a brand-new
// stable with only a few bars could slip past it.
const STABLE_SYMBOLS = new Set([
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'USDS', 'GUSD', 'USD1', 'USDB', 'RLUSD',
  'USDG', 'USDF', 'USD0', 'GHO', 'EURC', 'USDY', 'USYC', 'BUIDL', 'OUSD', 'USDGO', 'BFUSD', 'USTB', 'U'
]);

// Tokenised funds / loan pools (real-world-asset products), not crypto assets to rotate
// into. Several are $1 NAV tokens whose CoinGecko feed has glitchy prints that fake
// "momentum" — e.g. figure-heloc dips to $0.23 and back.
const EXCLUDED_IDS = new Set([
  'figure-heloc',
  'blackrock-usd-institutional-digital-liquidity-fund',
  'hashnote-usyc',
  'superstate-short-duration-us-government-securities-fund-ustb',
  'janus-henderson-anemoy-aaa-clo-fund',
  'spiko-amundi-overnight-swap-fund-eur',
  'ondo-us-dollar-yield',
  'blockchain-capital',
  'eutbl',
  'ylds',
  'a7a5'
]);

/** Annualised volatility under this = a stablecoin / tokenised cash fund, not a rotation candidate. */
const MIN_ANNUAL_VOL = 0.08;

/** Mostly trades within 3% of $1 → a dollar-pegged token, however noisy its feed. */
const isDollarPegged = (values: number[]): boolean => {
  if (!values.length) return false;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const nearPeg = values.filter((v) => Math.abs(v - 1) <= 0.03).length / values.length;
  return median >= 0.9 && median <= 1.1 && nearPeg >= 0.5;
};
const MIN_BARS = 60;
const CONCURRENCY = 8;

const annualVol = (values: number[]): number => {
  const rets: number[] = [];
  for (let k = 1; k < values.length; k += 1) rets.push(values[k] / values[k - 1] - 1);
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1));
  return sd * Math.sqrt(365);
};

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

export interface CandidateCoin {
  coingecko_id: string;
  symbol: string;
  name: string;
  image_url: string | null;
  market_cap_rank: number;
}

/** Coins the Lab may rank: current top ~110 by market cap, minus stables and tokenised funds. */
export const loadCandidateCoins = async (): Promise<CandidateCoin[]> => {
  const { data, error } = await supabase
    .from('coins')
    .select('coingecko_id, symbol, name, image_url, market_cap_rank')
    .not('market_cap_rank', 'is', null)
    .lte('market_cap_rank', 110)
    .order('market_cap_rank', { ascending: true });
  if (error) throw new Error(`Failed to read coins: ${error.message}`);
  return (data ?? []).filter(
    (c) => c.coingecko_id && !EXCLUDED_IDS.has(c.coingecko_id) && !STABLE_SYMBOLS.has(String(c.symbol ?? '').toUpperCase())
  ) as CandidateCoin[];
};

/** A coin's saved daily closes: the Binance prehistory, then CoinGecko. */
const readHistory = async (coingeckoId: string) => {
  const [pre, cg] = await Promise.all([readSeries(prehistoryKey(coingeckoId)), readSeries(`cg:${coingeckoId}`)]);
  return { series: withPrehistory(pre, cg), cgFrom: cg[0]?.date ?? null };
};

/**
 * Every rankable coin with its saved daily closes, aligned on BTC's calendar.
 * Cached 30 min — prices sync daily, and the first load reads ~160 series (several seconds).
 */
export const loadPriceMatrix = (): Promise<PriceMatrix> =>
  cached(
    'rotation:matrix',
    async () => {
      const candidates = await loadCandidateCoins();
      const { series: btcSeries, cgFrom } = await readHistory('bitcoin');
      if (btcSeries.length < MIN_BARS) throw new Error('BTC daily series is missing — run the price-series sync first.');
      const dates = btcSeries.map((p) => p.date);
      const index = new Map(dates.map((d, i) => [d, i]));

      const loaded = await mapLimit(candidates, CONCURRENCY, async (c) => ({ c, series: (await readHistory(c.coingecko_id)).series }));

      const prices: Record<string, (number | null)[]> = {};
      const coins: UniverseCoin[] = [];
      const seen = new Set<string>();
      for (const { c, series } of loaded) {
        if (seen.has(c.coingecko_id) || series.length < MIN_BARS) continue;
        const recent = series.slice(-180).map((p) => p.value);
        if (annualVol(recent) < MIN_ANNUAL_VOL || isDollarPegged(recent)) continue;
        const row: (number | null)[] = new Array(dates.length).fill(null);
        for (const p of series) {
          const i = index.get(p.date);
          if (i !== undefined) row[i] = p.value;
        }
        seen.add(c.coingecko_id);
        prices[c.coingecko_id] = row;
        coins.push({
          id: c.coingecko_id,
          symbol: String(c.symbol ?? '').toUpperCase(),
          name: c.name,
          image: c.image_url ?? null,
          rank: c.market_cap_rank
        });
      }
      const coingeckoFrom = cgFrom && dates[0] < cgFrom ? cgFrom : null;
      return { dates, prices, coins, coingeckoFrom };
    },
    1800
  );
