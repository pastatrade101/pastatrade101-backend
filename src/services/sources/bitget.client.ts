// Bitget public market-data client. All endpoints below are public (no API key)
// and rate-limited per IP. Every call is defensive: a network/parse/upstream
// failure returns null so callers degrade gracefully and never throw.

const BASE = 'https://api.bitget.com';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bgGet = async (path: string): Promise<any> => {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.code && json.code !== '00000') return null;
    return json?.data ?? null;
  } catch {
    return null;
  }
};

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Current funding rate (per 8h settlement) for one USDT-futures symbol. */
export const getCurrentFunding = async (symbol = 'BTCUSDT'): Promise<number | null> => {
  const d = await bgGet(`/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES&symbol=${symbol}`);
  const row = Array.isArray(d) ? d[0] : d;
  return num(row?.fundingRate);
};

/** Platform-wide open interest (in coin) for one USDT-futures symbol. */
export const getOpenInterest = async (symbol = 'BTCUSDT'): Promise<number | null> => {
  const d = await bgGet(`/api/v2/mix/market/open-interest?productType=USDT-FUTURES&symbol=${symbol}`);
  // Shape varies by version: { openInterestList: [{ size }] } | { amount } | { openInterest }.
  const list = d?.openInterestList;
  if (Array.isArray(list) && list.length) return num(list[0]?.size ?? list[0]?.amount);
  return num(d?.amount ?? d?.openInterest ?? d?.size);
};

/** Long/short account ratio (longs / shorts) — latest point. Rate-limited 1/s. */
export const getLongShort = async (symbol = 'BTCUSDT', period = '1h'): Promise<number | null> => {
  const d = await bgGet(`/api/v2/mix/market/long-short?symbol=${symbol}&period=${period}`);
  if (!Array.isArray(d) || !d.length) return null;
  const last = d[d.length - 1];
  return num(last?.longShortRatio);
};

/** All USDT-futures tickers (funding breadth + extremes). Returns [] on failure.
 *  `volume` is 24h USDT volume, used to filter out illiquid micro-cap perps. */
export const getAllFuturesTickers = async (): Promise<{ symbol: string; fundingRate: number | null; volume: number | null }[]> => {
  const d = await bgGet('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  if (!Array.isArray(d)) return [];
  return d
    .map((t) => ({ symbol: String(t?.symbol ?? ''), fundingRate: num(t?.fundingRate), volume: num(t?.usdtVolume ?? t?.quoteVolume) }))
    .filter((t) => t.symbol);
};
