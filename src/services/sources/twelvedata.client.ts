import { twelvedata } from '../../config/env';

// Twelve Data client (macro regime). Free tier is 8 credits/min, so callers
// sequence requests with a gap. Every call is defensive: network/parse/upstream
// failure or a missing key returns [] so the module degrades gracefully.
const BASE = 'https://api.twelvedata.com';

export interface TdPoint {
  date: string;
  close: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tdGet = async (path: string): Promise<any> => {
  if (!twelvedata.configured) return null;
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}apikey=${twelvedata.apiKey}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.status === 'error' || json?.code >= 400) return null;
    return json;
  } catch {
    return null;
  }
};

/** Daily close series (oldest → newest). Empty on failure / unsupported symbol. */
export const getDailySeries = async (symbol: string, days = 60): Promise<TdPoint[]> => {
  const d = await tdGet(`/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${days}&order=ASC`);
  const values = d?.values;
  if (!Array.isArray(values)) return [];
  return values
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((v: any) => ({ date: String(v?.datetime ?? ''), close: Number(v?.close) }))
    .filter((p: TdPoint) => p.date && Number.isFinite(p.close));
};

export const macroConfigured = (): boolean => twelvedata.configured;
