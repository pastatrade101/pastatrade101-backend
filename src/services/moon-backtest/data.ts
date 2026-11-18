import { accessSync, constants, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BENCHMARK, wantPair } from './universe';
import { unzipFirst } from './zip';

// Daily candles for every USDT pair Binance ever traded — the ones it delisted too,
// so the backtest is not flattered by only seeing today's survivors.
//  • Binance's public data archive (data.binance.vision) keeps one zip per pair per
//    month, including pairs that no longer trade. That gives each pair's history up to
//    the last full month (or to its last day, for a delisted pair).
//  • The public REST API fills in the days since, for pairs still trading.
// No API key is involved: all of it is public market data. Candles are cached on disk
// (one gzip file per pair), so only the first download is slow; later runs only fetch
// the days since the last one.

const ARCHIVE = 'https://data.binance.vision';
const LISTING = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const API = 'https://api.binance.com';
export const DAY_MS = 86_400_000;

/** [day number since 1970-01-01, open, high, low, close, USDT volume] */
export type Row = [number, number, number, number, number, number];

interface CacheFile {
  v: 1;
  symbol: string;
  /** Still trading on Binance when last checked. */
  trading: boolean;
  checkedAt: number;
  rows: Row[];
}

/** One pair's daily candles over its own lifetime; a day with no candle is NaN. */
export interface Series {
  symbol: string;
  /** Day number of index 0. */
  start: number;
  n: number;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  /** USDT volume. */
  volume: Float64Array;
  /** Still trading on Binance (false = delisted or halted). */
  trading: boolean;
}

export interface History {
  series: Series[];
  btc: Series;
  firstDay: number;
  lastDay: number;
  delisted: number;
}

export type Progress = (stage: string, done: number, total: number) => void;

export const dayToDate = (d: number) => new Date(d * DAY_MS).toISOString().slice(0, 10);
export const dateToDay = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where candles are cached: BACKTEST_CACHE_DIR, else backend/.bot/moon-history if writable, else the temp dir. */
export const cacheDir = (() => {
  let dir: string | null = null;
  return () => {
    if (dir) return dir;
    const candidates = [process.env.BACKTEST_CACHE_DIR, path.resolve(__dirname, '../../../.bot/moon-history'), path.join(os.tmpdir(), 'pastatrade-moon-history')];
    for (const c of candidates) {
      if (!c) continue;
      try {
        mkdirSync(c, { recursive: true });
        accessSync(c, constants.W_OK);
        dir = c;
        return c;
      } catch {
        /* try the next one */
      }
    }
    throw new Error('No writable folder for the backtest candle cache (set BACKTEST_CACHE_DIR).');
  };
})();

const fileFor = (symbol: string) => path.join(cacheDir(), `${symbol}.json.gz`);

const readCache = (symbol: string): CacheFile | null => {
  try {
    const c = JSON.parse(gunzipSync(readFileSync(fileFor(symbol))).toString()) as CacheFile;
    return c.v === 1 && Array.isArray(c.rows) ? c : null;
  } catch {
    return null;
  }
};

const writeCache = (c: CacheFile) => writeFileSync(fileFor(c.symbol), gzipSync(JSON.stringify(c)));

const get = async (url: string, { tries = 4, okStatuses = [200] }: { tries?: number; okStatuses?: number[] } = {}): Promise<Response> => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      // 418 = this IP is banned by Binance for ignoring 429s. Never retry into it.
      if (r.status === 418) throw Object.assign(new Error('Binance has temporarily blocked this IP (418). Wait before trying again.'), { fatal: true });
      if (r.status === 429) {
        const wait = Number(r.headers.get('retry-after') ?? '30');
        await sleep(Math.min(120, Math.max(1, wait)) * 1000);
        throw new Error('rate limited');
      }
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!okStatuses.includes(r.status) && r.status !== 400 && r.status !== 404) throw new Error(`HTTP ${r.status} for ${url}`);
      return r;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || i >= tries - 1) throw e;
      await sleep(600 * 2 ** i);
    }
  }
};

const pool = async <T>(items: T[], size: number, fn: (item: T) => Promise<void>) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
};

/** Every USDT pair in the archive (S3 lists 1000 keys per page). */
const archivePairs = async (): Promise<string[]> => {
  const out: string[] = [];
  let marker = '';
  for (;;) {
    const r = await get(`${LISTING}?delimiter=/&prefix=data/spot/monthly/klines/${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`);
    const xml = await r.text();
    const page = [...xml.matchAll(/<Prefix>data\/spot\/monthly\/klines\/([^/<]+)\/<\/Prefix>/g)].map((m) => m[1]);
    out.push(...page);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !page.length) break;
    marker = `data/spot/monthly/klines/${page[page.length - 1]}/`;
  }
  return out.filter((s) => s.endsWith('USDT'));
};

/** The months the archive holds for a pair ("2024-06", …). */
const archiveMonths = async (symbol: string): Promise<string[]> => {
  const r = await get(`${LISTING}?prefix=data/spot/monthly/klines/${symbol}/1d/`, { tries: 6 });
  const xml = await r.text();
  return [...xml.matchAll(new RegExp(`${symbol}-1d-(\\d{4}-\\d{2})\\.zip</Key>`, 'g'))].map((m) => m[1]);
};

const parseCsv = (text: string): Row[] => {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(',');
    if (f.length < 8) continue;
    let t = Number(f[0]);
    if (!Number.isFinite(t)) continue; // header line
    if (t > 1e14) t = Math.floor(t / 1000); // the archive switched to microseconds in 2025
    rows.push([Math.floor(t / DAY_MS), +f[1], +f[2], +f[3], +f[4], +f[7]]);
  }
  return rows;
};

const archiveMonth = async (symbol: string, month: string): Promise<Row[]> => {
  const r = await get(`${ARCHIVE}/data/spot/monthly/klines/${symbol}/1d/${symbol}-1d-${month}.zip`, { tries: 6 });
  if (r.status === 404) return [];
  return parseCsv(unzipFirst(Buffer.from(await r.arrayBuffer())).toString());
};

/** Closed daily candles from the REST API since `fromDay`; 'gone' when Binance no longer knows the pair. */
const apiDays = async (symbol: string, fromDay: number): Promise<Row[] | 'gone'> => {
  const rows: Row[] = [];
  let from = fromDay;
  for (let page = 0; page < 10; page++) {
    const r = await get(`${API}/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${from * DAY_MS}&limit=1000`, { tries: 6 });
    // Stay well inside Binance's 6000-per-minute request weight (klines cost 2).
    if (Number(r.headers.get('x-mbx-used-weight-1m') ?? 0) > 3000) await sleep(61_000 - (Date.now() % 60_000));
    if (r.status === 400) {
      const j = (await r.json().catch(() => null)) as { code?: number } | null;
      if (j?.code === -1121) return 'gone';
      throw new Error(`Binance refused klines for ${symbol}: ${JSON.stringify(j)}`);
    }
    const k = (await r.json()) as (string | number)[][];
    const now = Date.now();
    for (const c of k) if (Number(c[6]) < now) rows.push([Math.floor(Number(c[0]) / DAY_MS), +c[1], +c[2], +c[3], +c[4], +c[7]]);
    if (k.length < 1000) break;
    from = Math.floor(Number(k[k.length - 1][0]) / DAY_MS) + 1;
  }
  return rows;
};

const merge = (a: Row[], b: Row[]): Row[] => {
  const m = new Map<number, Row>();
  for (const r of a) m.set(r[0], r);
  for (const r of b) m.set(r[0], r);
  return [...m.values()].sort((x, y) => x[0] - y[0]);
};

const tradingPairs = async (): Promise<Set<string>> => {
  const r = await get(`${API}/api/v3/exchangeInfo?permissions=SPOT`);
  const j = (await r.json()) as { symbols: { symbol: string; status: string; quoteAsset: string }[] };
  return new Set(j.symbols.filter((s) => s.quoteAsset === 'USDT' && s.status === 'TRADING').map((s) => s.symbol));
};

/** How long a pair's cached candles count as fresh. */
const FRESH_MS = 6 * 3_600_000;

export interface SyncSummary {
  pairs: number;
  downloaded: number;
  refreshed: number;
  failed: string[];
  dir: string;
}

/**
 * Bring the candle cache up to date: every USDT pair in the archive or trading now,
 * minus the ones the backtest never buys. The first call downloads everything (a few
 * minutes); later calls only fetch the days since.
 */
export const syncHistory = async (progress: Progress = () => {}): Promise<SyncSummary> => {
  progress('Listing Binance pairs', 0, 1);
  const [trading, archived] = await Promise.all([tradingPairs(), archivePairs()]);
  const pairs = [...new Set([...archived, ...trading])].filter(wantPair).sort();
  const summary: SyncSummary = { pairs: pairs.length, downloaded: 0, refreshed: 0, failed: [], dir: cacheDir() };
  let done = 0;
  // Pairs still trading come from the REST API (1000 days per request); only dead pairs
  // need the archive, which is one request per month — far slower over a long link.
  await pool(pairs, 6, async (symbol) => {
    try {
      const cached = readCache(symbol);
      const isTrading = trading.has(symbol);
      if (cached && !cached.trading && !isTrading) return; // a dead pair's history never changes
      if (cached && Date.now() - cached.checkedAt < FRESH_MS && cached.trading === isTrading) return;
      let rows = cached?.rows ?? [];
      let stillTrading = isTrading;
      if (isTrading) {
        const lastDay = rows.length ? rows[rows.length - 1][0] : -1;
        const fresh = await apiDays(symbol, lastDay + 1);
        if (fresh === 'gone') stillTrading = false;
        else rows = merge(rows, fresh);
        summary[cached ? 'refreshed' : 'downloaded']++;
      }
      // A dead pair, or one delisted since the last check: read the archive months it is missing.
      if (!stillTrading) {
        const last = rows.length ? rows[rows.length - 1][0] : null;
        const fromMonth = last != null ? new Date(last * DAY_MS).toISOString().slice(0, 7) : '';
        const months = (await archiveMonths(symbol)).filter((m) => m >= fromMonth);
        const got: Row[] = [];
        await pool(months, 4, async (m) => {
          got.push(...(await archiveMonth(symbol, m)));
        });
        rows = merge(rows, got);
        summary.downloaded++;
      }
      writeCache({ v: 1, symbol, trading: stillTrading, checkedAt: Date.now(), rows });
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) throw e;
      summary.failed.push(`${symbol}: ${(e as Error).message}`);
    } finally {
      progress('Downloading daily candles', ++done, pairs.length);
    }
  });
  return summary;
};

const toSeries = (c: CacheFile): Series | null => {
  // Drop broken candles (zero or negative prices).
  const rows = c.rows.filter((r) => r[1] > 0 && r[2] > 0 && r[3] > 0 && r[4] > 0);
  if (!rows.length) return null;
  const start = rows[0][0];
  const n = rows[rows.length - 1][0] - start + 1;
  const mk = () => new Float64Array(n).fill(NaN);
  const s: Series = { symbol: c.symbol, start, n, open: mk(), high: mk(), low: mk(), close: mk(), volume: mk(), trading: c.trading };
  for (const r of rows) {
    const i = r[0] - start;
    s.open[i] = r[1];
    s.high[i] = r[2];
    s.low[i] = r[3];
    s.close[i] = r[4];
    s.volume[i] = r[5];
  }
  return s;
};

/** Load every cached pair into memory. */
export const loadHistory = (): History => {
  const series: Series[] = [];
  let btc: Series | null = null;
  for (const f of readdirSync(cacheDir())) {
    if (!f.endsWith('.json.gz')) continue;
    const symbol = f.slice(0, -'.json.gz'.length);
    if (!wantPair(symbol)) continue;
    const c = readCache(symbol);
    const s = c && toSeries(c);
    if (!s) continue;
    if (symbol === BENCHMARK) btc = s;
    else series.push(s);
  }
  if (!btc) throw new Error('No BTCUSDT candles in the cache — download the history first.');
  series.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return {
    series,
    btc,
    firstDay: btc.start,
    lastDay: Math.max(btc.start + btc.n - 1, ...series.map((s) => s.start + s.n - 1)),
    delisted: series.filter((s) => !s.trading).length
  };
};

/** What is in the cache right now, without loading it all. */
export const cacheStatus = (): { pairs: number; dir: string } | null => {
  try {
    const dir = cacheDir();
    const pairs = readdirSync(dir).filter((f) => f.endsWith('.json.gz')).length;
    return pairs ? { pairs, dir } : null;
  } catch {
    return null;
  }
};
