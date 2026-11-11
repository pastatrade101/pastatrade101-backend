/**
 * Rotation Lab — fill the years before the saved CoinGecko history with Binance daily
 * prices (see services/rotation-backtest/prehistory.ts for why and how they line up).
 *
 *   npm run backfill:rotation-prices                    dry run: reports what it would save
 *   npm run backfill:rotation-prices -- --apply         saves 'bn:<id>' series to daily_prices
 *   options: --from 2020-01-01 (default)   --only bitcoin,ethereum
 *
 * Public Binance market data only — no keys, no account. Never touches the 'cg:' series
 * that other features read. Safe to re-run (it upserts); re-run when new coins join the
 * top 110 so they get their history too.
 */
import { loadCandidateCoins } from '../services/rotation-backtest/rotationData.service';
import { buildPrehistory, prehistoryKey, type DailyOpen } from '../services/rotation-backtest/prehistory';
import { readSeries, upsertSeries } from '../services/series/store';

const KLINES = 'https://api.binance.com/api/v3/klines';
const DAY = 86_400_000;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes('--apply');
const from = arg('from') ?? '2020-01-01';
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(`--from must be YYYY-MM-DD, got ${from}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Daily opens for a USDT pair between two dates, or null when Binance has no such pair. */
const fetchDailyOpens = async (symbol: string, start: string, end: string): Promise<DailyOpen[] | null> => {
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

(async () => {
  console.log(`▶ Rotation prehistory backfill from ${from} — ${apply ? 'APPLY (writes bn:<id> series)' : 'dry run, nothing is written'}`);
  let coins = await loadCandidateCoins();
  if (only?.length) coins = coins.filter((c) => only.includes(c.coingecko_id));

  let saved = 0;
  let rowsTotal = 0;
  const skipped: string[] = [];
  for (const c of coins) {
    const asset = String(c.symbol).toUpperCase();
    const label = `#${String(c.market_cap_rank).padEnd(3)} ${asset.padEnd(7)}`;
    const cg = await readSeries(`cg:${c.coingecko_id}`);
    if (!cg.length) {
      skipped.push(`${label} no CoinGecko history saved`);
      continue;
    }
    if (cg[0].date <= from) {
      console.log(`  ${label} CoinGecko history already starts ${cg[0].date}`);
      continue;
    }
    const candles = await fetchDailyOpens(`${asset}USDT`, from, isoDay(dayMs(cg[0].date) + 90 * DAY));
    await sleep(150);
    if (!candles) {
      skipped.push(`${label} no ${asset}USDT pair on Binance`);
      continue;
    }
    const plan = buildPrehistory(candles, cg, from);
    if (!plan.ok) {
      if (plan.nothingToDo) console.log(`  ${label} ${plan.reason}`);
      else skipped.push(`${label} ${plan.reason}`);
      continue;
    }
    const { rows } = plan;
    console.log(
      `  ${label} +${String(rows.length).padStart(4)} days  ${rows[0].date} → ${rows[rows.length - 1].date}  (matches CoinGecko within ${plan.gapPct.toFixed(2)}% over ${plan.overlapDays} days)`
    );
    if (apply) {
      await upsertSeries(
        prehistoryKey(c.coingecko_id),
        rows.map((r) => ({ date: r.date, price: r.value, market_cap: null, volume: null }))
      );
    }
    saved += 1;
    rowsTotal += rows.length;
  }

  if (skipped.length) {
    console.log(`\nNot extended (they keep the CoinGecko history only):`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  console.log(`\n${apply ? '✓ Saved' : 'Would save'} ${rowsTotal} daily prices for ${saved} coin(s).${apply ? '' : ' Re-run with --apply to write them.'}`);
  process.exit(0);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
