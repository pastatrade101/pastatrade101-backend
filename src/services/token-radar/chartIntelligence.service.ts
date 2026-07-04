import { fetchJson } from '../sources/http';
import { readSeries } from '../series/store';
import { coingecko } from '../../config/env';
import type { ChainConfig } from './chainConfig';
import type { RiskWarning } from './scoringEngine';

// ─────────────────────────────────────────────────────────────────────────────
// Chart Intelligence — historical price/volume structure for a scanned token:
// MAs/EMAs, MA structure, drawdowns, volume trend, breakout read and relative
// strength vs BTC (BTC series comes from the platform's own daily_prices store —
// no extra API call). Educational analysis only, never financial advice.
//
// Source priority (first that yields usable candles wins):
//   1. Binance 1d klines — ONLY when the token is actually listed on Binance
//      (guarded by the CoinGecko-verified CEX listings; symbols alone collide).
//   2. CoinGecko market_chart (needs a CoinGecko id) — close+volume only.
//   3. GeckoTerminal daily OHLCV for the token's main DEX pool.
// Everything is graceful: no data → null result + a warning, never a crash.
// ─────────────────────────────────────────────────────────────────────────────

export type ChartSource = 'binance' | 'coingecko' | 'geckoterminal' | 'dexscreener' | 'unknown';

export interface HistoricalCandle {
  timestamp: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  source: ChartSource;
}

export interface ChartIntelligenceResult {
  source: ChartSource;
  timeframe: '7d' | '30d' | '90d' | '180d' | '1y';
  candles: HistoricalCandle[];
  priceChange7d: number | null;
  priceChange30d: number | null;
  priceChange90d: number | null;
  drawdownFrom30dHigh: number | null;
  drawdownFrom90dHigh: number | null;
  ma20: number | null;
  ma50: number | null;
  ma200: number | null;
  ema20: number | null;
  ema50: number | null;
  priceVsMa20: 'above' | 'below' | 'near' | 'unknown';
  priceVsMa50: 'above' | 'below' | 'near' | 'unknown';
  maStructure: 'bullish' | 'recovering' | 'bearish' | 'overextended' | 'unknown';
  volumeTrend: 'rising' | 'falling' | 'flat' | 'inactive' | 'unknown';
  relativeStrengthVsBtc: {
    tokenReturn30d: number | null;
    btcReturn30d: number | null;
    tokenBtcReturn30d: number | null;
    status: 'outperforming_btc' | 'matching_btc' | 'underperforming_btc' | 'unknown';
    score: number;
  };
  chartTrendScore: number;
  volumeTrendScore: number;
  breakoutScore: number;
  relativeStrengthScore: number;
  momentumScoreContribution: number;
  warnings: RiskWarning[];
  summary: string;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── Fetchers ─────────────────────────────────────────────────────────────────

// Binance daily klines. Called ONLY when the token is verifiably Binance-listed.
const binanceCandles = async (symbol: string): Promise<HistoricalCandle[]> => {
  const pair = `${symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')}USDT`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await fetchJson<any[]>(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=365`, { label: 'binance-klines', retries: 1 });
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        timestamp: new Date(Number(r[0])).toISOString(),
        open: num(r[1]), high: num(r[2]), low: num(r[3]),
        close: num(r[4]) ?? 0, volume: num(r[7]), // r[7] = quote (USDT) volume
        source: 'binance' as const
      }))
      .filter((c) => c.close > 0);
  } catch {
    return [];
  }
};

// CoinGecko market_chart — daily prices + volumes (no OHLC on this endpoint).
const coingeckoCandles = async (coinId: string): Promise<HistoricalCandle[]> => {
  try {
    const headers = coingecko.hasKey ? { [coingecko.headerName]: coingecko.apiKey } : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await fetchJson<any>(`${coingecko.baseUrl}/coins/${coinId}/market_chart?vs_currency=usd&days=365&interval=daily`, { headers, label: 'coingecko-chart', retries: 1 });
    const prices: [number, number][] = d?.prices ?? [];
    const vols = new Map<number, number>(((d?.total_volumes ?? []) as [number, number][]).map(([t, v]) => [t, v]));
    return prices
      .map(([t, p]) => ({ timestamp: new Date(t).toISOString(), open: null, high: null, low: null, close: Number(p) || 0, volume: vols.get(t) ?? null, source: 'coingecko' as const }))
      .filter((c) => c.close > 0);
  } catch {
    return [];
  }
};

// GeckoTerminal daily OHLCV for the token's main pool (DEX-native tokens).
const GT_NETWORK: Record<string, string> = {
  ethereum: 'eth', bsc: 'bsc', solana: 'solana', base: 'base', arbitrum: 'arbitrum',
  polygon: 'polygon_pos', avalanche: 'avax', optimism: 'optimism', fantom: 'ftm', sonic: 'sonic',
  cronos: 'cro', linea: 'linea', mantle: 'mantle', blast: 'blast', scroll: 'scroll',
  zksync: 'zksync', celo: 'celo', gnosis: 'xdai', moonbeam: 'glmr', pulsechain: 'pulsechain',
  ton: 'ton', sui: 'sui-network', aptos: 'aptos', tron: 'tron'
};
const geckoTerminalCandles = async (chainSlug: string, poolAddress: string): Promise<HistoricalCandle[]> => {
  const network = GT_NETWORK[chainSlug];
  if (!network || !poolAddress) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await fetchJson<any>(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/day?limit=180`, { label: 'geckoterminal-ohlcv', retries: 1 });
    const list: number[][] = d?.data?.attributes?.ohlcv_list ?? [];
    return list
      .map((r) => ({ timestamp: new Date(r[0] * 1000).toISOString(), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]) ?? 0, volume: num(r[5]), source: 'geckoterminal' as const }))
      .filter((c) => c.close > 0)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
};

// ── Pure math ────────────────────────────────────────────────────────────────
const sma = (closes: number[], period: number): number | null =>
  closes.length >= period ? closes.slice(-period).reduce((s, v) => s + v, 0) / period : null;

const ema = (closes: number[], period: number): number | null => {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i += 1) e = closes[i] * k + e * (1 - k);
  return e;
};

const changeOver = (closes: number[], days: number): number | null => {
  if (closes.length < days + 1) return null;
  const past = closes[closes.length - 1 - days];
  return past > 0 ? ((closes[closes.length - 1] - past) / past) * 100 : null;
};

const drawdownFromHigh = (candles: HistoricalCandle[], days: number): number | null => {
  const win = candles.slice(-days);
  if (win.length < Math.min(days, 7)) return null;
  const high = Math.max(...win.map((c) => c.high ?? c.close));
  const last = win[win.length - 1].close;
  return high > 0 ? ((last - high) / high) * 100 : null;
};

const vsMa = (price: number, ma: number | null): 'above' | 'below' | 'near' | 'unknown' =>
  ma == null || ma <= 0 ? 'unknown' : price > ma * 1.03 ? 'above' : price < ma * 0.97 ? 'below' : 'near';

/**
 * Pure analysis over normalized candles (+ BTC closes for relative strength).
 * Exported for tests. `candles` must be oldest→newest daily.
 */
export const analyzeCandles = (candles: HistoricalCandle[], btcCloses: number[], source: ChartSource): ChartIntelligenceResult | null => {
  if (candles.length < 7) return null;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const warnings: RiskWarning[] = [];

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const priceVsMa20 = vsMa(price, ma20);
  const priceVsMa50 = vsMa(price, ma50);

  // Volume trend: recent 7d avg vs prior 7d avg (±20%); near-zero → inactive.
  const vols = candles.map((c) => c.volume).filter((v): v is number => v != null);
  let volumeTrend: ChartIntelligenceResult['volumeTrend'] = 'unknown';
  if (vols.length >= 14) {
    const recent = vols.slice(-7).reduce((s, v) => s + v, 0) / 7;
    const prior = vols.slice(-14, -7).reduce((s, v) => s + v, 0) / 7;
    if (recent < 100) volumeTrend = 'inactive';
    else if (prior > 0 && recent >= prior * 1.2) volumeTrend = 'rising';
    else if (prior > 0 && recent <= prior * 0.8) volumeTrend = 'falling';
    else volumeTrend = 'flat';
  } else if (vols.length && vols.slice(-3).every((v) => v < 100)) volumeTrend = 'inactive';

  // MA structure (overextension needs volume confirmation to stay "bullish").
  const ma50Prev = closes.length >= 55 ? sma(closes.slice(0, -5), 50) : null;
  const ma50Rising = ma50 != null && ma50Prev != null ? ma50 > ma50Prev : false;
  let maStructure: ChartIntelligenceResult['maStructure'] = 'unknown';
  if (ma20 != null) {
    const wayAbove = price > ma20 * 1.3;
    if (wayAbove && volumeTrend !== 'rising') maStructure = 'overextended';
    else if (ma50 != null && price > ma20 && ma20 > ma50 && ma50Rising) maStructure = 'bullish';
    else if (ma50 != null && price > ma20 && price < ma50) maStructure = 'recovering';
    else if (price < ma20 && (ma50 == null || price < ma50)) maStructure = 'bearish';
    else maStructure = ma50 == null ? (price > ma20 ? 'recovering' : 'bearish') : 'recovering';
  }

  // Relative strength vs BTC (30d returns).
  const tokenReturn30d = changeOver(closes, 30);
  const btcReturn30d = btcCloses.length >= 31 ? changeOver(btcCloses, 30) : null;
  const tokenBtcReturn30d = tokenReturn30d != null && btcReturn30d != null ? tokenReturn30d - btcReturn30d : null;
  const rsStatus = tokenBtcReturn30d == null ? 'unknown' : tokenBtcReturn30d > 10 ? 'outperforming_btc' : tokenBtcReturn30d < -10 ? 'underperforming_btc' : 'matching_btc';
  const relativeStrengthScore = tokenBtcReturn30d == null ? 50 : clamp(50 + tokenBtcReturn30d * 1.2);

  // Chart trend score: structure + position vs MAs + medium-term change.
  let trend = 50;
  if (maStructure === 'bullish') trend += 20;
  else if (maStructure === 'recovering') trend += 8;
  else if (maStructure === 'bearish') trend -= 20;
  else if (maStructure === 'overextended') trend -= 8;
  if (priceVsMa20 === 'above') trend += 8;
  if (priceVsMa20 === 'below') trend -= 8;
  if (priceVsMa50 === 'above') trend += 6;
  if (priceVsMa50 === 'below') trend -= 6;
  const ch30 = changeOver(closes, Math.min(30, closes.length - 1));
  if (ch30 != null) trend += Math.max(-10, Math.min(10, ch30 * 0.2));
  const chartTrendScore = clamp(trend);

  const volumeTrendScore = volumeTrend === 'rising' ? 75 : volumeTrend === 'flat' ? 50 : volumeTrend === 'falling' ? 32 : volumeTrend === 'inactive' ? 8 : 50;

  // Breakout: above MAs WITH volume expansion is the strong pattern.
  let breakout = 50;
  if (priceVsMa20 === 'above' && priceVsMa50 === 'above' && volumeTrend === 'rising') breakout = 85;
  else if (priceVsMa20 === 'above' && volumeTrend === 'rising') breakout = 72;
  else if (priceVsMa20 === 'above' && priceVsMa50 === 'above') breakout = 62;
  else if (priceVsMa20 === 'below' && priceVsMa50 === 'below') breakout = 25;
  else if (volumeTrend === 'inactive') breakout = 15;
  const breakoutScore = clamp(breakout);

  // The chart-side share of the blended Momentum Score (vol 25 + RS 25 + breakout 20 of 70).
  const momentumScoreContribution = clamp((volumeTrendScore * 25 + relativeStrengthScore * 25 + breakoutScore * 20) / 70);

  // Warnings (educational, severity-graded).
  if (priceVsMa20 === 'below' && priceVsMa50 === 'below') warnings.push({ label: 'Below Key Moving Averages', message: 'Price is below both MA20 and MA50 — the trend structure is weak until it reclaims them.', severity: 'medium' });
  if (volumeTrend === 'inactive') warnings.push({ label: 'Inactive Volume', message: 'Historical volume is near zero — price levels are not backed by real trading.', severity: 'high' });
  if (rsStatus === 'underperforming_btc') warnings.push({ label: 'Underperforming BTC', message: 'The token is lagging BTC over 30 days — relative strength is weak even if the USD price rose.', severity: 'medium' });
  if (maStructure === 'overextended') warnings.push({ label: 'Overextended Without Volume', message: 'Price is more than 30% above MA20 without volume confirmation — stretched moves often retrace.', severity: 'medium' });
  if (closes.length < 50) warnings.push({ label: 'Short Price History', message: `Only ${closes.length} days of history — longer-term structure (MA50/MA200) cannot be assessed yet.`, severity: 'low' });

  const dd90 = drawdownFromHigh(candles, 90);
  const structureWord = maStructure === 'unknown' ? 'unclear' : maStructure;
  const summary = `Chart structure looks ${structureWord} (${source} data): price is ${priceVsMa20} MA20 and ${priceVsMa50 === 'unknown' ? 'MA50 unavailable' : `${priceVsMa50} MA50`}, volume is ${volumeTrend}, and the token is ${rsStatus === 'unknown' ? 'not comparable to BTC yet' : rsStatus.replace(/_/g, ' ')} over 30 days.${dd90 != null ? ` It trades ${Math.abs(dd90).toFixed(0)}% below its 90-day high.` : ''}`;

  return {
    source,
    timeframe: closes.length >= 300 ? '1y' : closes.length >= 150 ? '180d' : closes.length >= 75 ? '90d' : closes.length >= 25 ? '30d' : '7d',
    candles,
    priceChange7d: changeOver(closes, 7),
    priceChange30d: tokenReturn30d,
    priceChange90d: changeOver(closes, 90),
    drawdownFrom30dHigh: drawdownFromHigh(candles, 30),
    drawdownFrom90dHigh: dd90,
    ma20, ma50, ma200, ema20, ema50,
    priceVsMa20, priceVsMa50, maStructure, volumeTrend,
    relativeStrengthVsBtc: { tokenReturn30d, btcReturn30d, tokenBtcReturn30d, status: rsStatus, score: relativeStrengthScore },
    chartTrendScore, volumeTrendScore, breakoutScore, relativeStrengthScore, momentumScoreContribution,
    warnings, summary
  };
};

// ── Orchestrated fetch (source priority + BTC series from the local store). ──
export const getChartIntelligence = async (
  chain: ChainConfig,
  opts: { symbol: string | null; coingeckoId: string | null; poolAddress: string | null; hasBinanceListing: boolean }
): Promise<ChartIntelligenceResult | null> => {
  const btcCloses = await readSeries('btc-full')
    .then((rows) => rows.slice(-365).map((r) => Number(r.value)).filter((v) => Number.isFinite(v) && v > 0))
    .catch(() => [] as number[]);

  // 1 · Binance — only when the token is verifiably listed there.
  if (opts.hasBinanceListing && opts.symbol) {
    const c = await binanceCandles(opts.symbol);
    if (c.length >= 7) return analyzeCandles(c, btcCloses, 'binance');
  }
  // 2 · CoinGecko market_chart.
  if (opts.coingeckoId) {
    const c = await coingeckoCandles(opts.coingeckoId);
    if (c.length >= 7) return analyzeCandles(c, btcCloses, 'coingecko');
  }
  // 3 · GeckoTerminal pool OHLCV.
  if (opts.poolAddress) {
    const c = await geckoTerminalCandles(chain.slug, opts.poolAddress);
    if (c.length >= 7) return analyzeCandles(c, btcCloses, 'geckoterminal');
  }
  return null;
};
