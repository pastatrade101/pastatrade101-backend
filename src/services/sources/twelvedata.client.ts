import { twelvedata } from '../../config/env';

// Twelve Data client (macro regime). Free tier is 8 credits/min, so callers
// sequence requests with a gap. Every call is defensive: network/parse/upstream
// failure or a missing key returns [] so the module degrades gracefully — but
// the reason is logged and kept (`twelveDataError()`), so a dead key shows up
// in the server log and the macro sync job instead of failing silently.
const BASE = 'https://api.twelvedata.com';

export interface TdPoint {
  date: string;
  close: number;
}

let lastError: string | null = null;
/** Why the most recent Twelve Data call failed; null after a success. */
export const twelveDataError = (): string | null => lastError;

// Never let the key reach a log line or the sync_jobs table.
const redact = (s: string) => (twelvedata.apiKey ? s.split(twelvedata.apiKey).join('<key>') : s);
const fail = (label: string, why: string): null => {
  // First sentence is enough ("**apikey** parameter is incorrect…"); the rest is boilerplate.
  lastError = redact(why).split(/(?<=\.)\s/)[0].slice(0, 200);
  console.warn(`[twelvedata] ${label}: ${lastError}`);
  return null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tdGet = async (path: string, label: string): Promise<any> => {
  if (!twelvedata.configured) return fail(label, 'TWELVE_DATA_API_KEY is not set');
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}apikey=${twelvedata.apiKey}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json().catch(() => null);
    if (!res.ok) return fail(label, `HTTP ${res.status}${json?.message ? ` — ${json.message}` : ''}`);
    if (!json) return fail(label, 'response was not JSON');
    if (json.status === 'error' || json.code >= 400) return fail(label, `${json.code ?? 'error'} — ${json.message ?? 'no message'}`);
    lastError = null;
    return json;
  } catch (err) {
    return fail(label, err instanceof Error ? err.message : String(err));
  }
};

/** Daily close series (oldest → newest). Empty on failure / unsupported symbol. */
export const getDailySeries = async (symbol: string, days = 60): Promise<TdPoint[]> => {
  const d = await tdGet(`/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${days}&order=ASC`, symbol);
  const values = d?.values;
  if (d && !Array.isArray(values)) fail(symbol, 'no values in the response');
  if (!Array.isArray(values)) return [];
  return values
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((v: any) => ({ date: String(v?.datetime ?? ''), close: Number(v?.close) }))
    .filter((p: TdPoint) => p.date && Number.isFinite(p.close));
};

export const macroConfigured = (): boolean => twelvedata.configured;
