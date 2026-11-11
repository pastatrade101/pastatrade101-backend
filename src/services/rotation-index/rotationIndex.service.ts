import { supabase } from '../../config/supabase';
import { rankAt } from '../rotation-backtest/engine';
import { loadPriceMatrix, type PriceMatrix } from '../rotation-backtest/rotationData.service';
import { createBinance } from '../rotation-bot/binance';
import { addDays, pickUniverse, STYLES } from '../rotation-bot/planner';
import { isTradablePair, rulesFor, type SymbolRules } from '../rotation-bot/sizing';
import { readSeries, readSeriesFull } from '../series/store';
import { newIndexState, stepDay, type IndexConfig, type IndexState, type ReviewRecord, type Trade } from './indexEngine';

// Runs the Rotation Index forward over the SAVED daily prices and stores one row per
// day in rotation_index_days (see indexEngine.ts for the rules). Stepped after every
// price sync; only days whose close is final are used — the newest saved day holds
// CoinGecko's intraday price until the next sync rewrites it with the 00:00 close.

export const INDEXES = {
  'rotation-balanced': {
    label: 'Rotation Index · Balanced',
    config: { style: STYLES.balanced, feePct: 0.1, base: 100, top10Size: 10, top10RebalanceDays: 30 } satisfies IndexConfig
  }
} as const;
export type IndexId = keyof typeof INDEXES;
export const isIndexId = (v: unknown): v is IndexId => typeof v === 'string' && v in INDEXES;

const TABLE = 'rotation_index_days';

/** Coins the rule may buy: in the Lab's list and tradable against USDT on Binance. */
interface Tradable {
  asOf: string;
  ids: string[];
}
type SavedState = IndexState & { tradable?: Tradable | null };

export interface DayRow {
  index_id: string;
  date: string;
  nav: number;
  btc: number;
  top10: number;
  state: SavedState;
  trades: { index: Trade[]; top10: Trade[] } | null;
  review: ReviewRecord | null;
}

const loadRows = async (id: IndexId): Promise<DayRow[]> => {
  const out: DayRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('index_id, date, nav, btc, top10, state, trades, review')
      .eq('index_id', id)
      .order('date', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(isMissingTable(error) ? MISSING_TABLE : `Failed to read ${TABLE}: ${error.message}`);
    out.push(...((data ?? []) as DayRow[]).map((r) => ({ ...r, nav: Number(r.nav), btc: Number(r.btc), top10: Number(r.top10) })));
    if (!data || data.length < 1000) break;
  }
  return out;
};

const MISSING_TABLE = `The ${TABLE} table does not exist yet — create it with database/rotation-index.sql.`;
const isMissingTable = (e: { code?: string; message?: string }) => e.code === 'PGRST205' || e.code === '42P01' || /could not find the table/i.test(e.message ?? '');

const lastRow = async (id: IndexId): Promise<DayRow | null> => {
  const { data, error } = await supabase.from(TABLE).select('date, state').eq('index_id', id).order('date', { ascending: false }).limit(1);
  if (error) throw new Error(isMissingTable(error) ? MISSING_TABLE : `Failed to read ${TABLE}: ${error.message}`);
  return (data?.[0] as DayRow | undefined) ?? null;
};

/** Binance's current USDT pairs, checked against the saved prices (a ticker can be a different token). */
const fetchTradable = async (m: PriceMatrix): Promise<Tradable> => {
  const bn = createBinance({ mode: 'live' });
  const [symbols, live] = await Promise.all([bn.exchangeInfo(), bn.prices()]);
  const pairs = new Map<string, SymbolRules>();
  for (const s of symbols) if (isTradablePair(s)) pairs.set(s.baseAsset, rulesFor(s));
  const { picked } = pickUniverse(m.coins, m.prices, m.dates.length - 1, pairs, live, Number.POSITIVE_INFINITY);
  return { asOf: new Date().toISOString().slice(0, 10), ids: picked.map((c) => c.id) };
};

export interface StepResult {
  id: IndexId;
  added: number;
  from: string | null;
  to: string | null;
  note?: string;
  latest?: { date: string; nav: number; btc: number; top10: number };
  warnings: string[];
  rows?: DayRow[];
}

/**
 * Add every final day since the last saved one. `start` creates the index on the
 * newest final day if it has no rows yet; without it a missing index is left alone.
 */
export const stepRotationIndex = async (
  id: IndexId,
  { start = false, dryRun = false, from }: { start?: boolean; dryRun?: boolean; from?: string } = {}
): Promise<StepResult> => {
  if (from && !dryRun) throw new Error('--from replays the past and is only allowed with --dry-run.');
  const { config } = INDEXES[id];
  const style = config.style;
  const warnings: string[] = [];
  const m = await loadPriceMatrix();
  const dates = m.dates;
  const lastFinal = dates.length - 2;
  if (lastFinal < style.lookbackDays) throw new Error('Not enough saved prices to rank coins yet.');

  let last: DayRow | null = null;
  try {
    last = await lastRow(id);
  } catch (error) {
    // A dry run can show what the index would do before its table exists.
    if (!(dryRun && error instanceof Error && error.message === MISSING_TABLE)) throw error;
    warnings.push(MISSING_TABLE);
  }
  if (!last && !start) return { id, added: 0, from: null, to: null, note: 'not started', warnings };
  if (from) last = null; // a dry-run replay from a past date starts fresh
  const firstIdx = from ? dates.findIndex((d) => d >= from) : last ? dates.findIndex((d) => d > last!.date) : lastFinal;
  if (firstIdx < 0 || firstIdx > lastFinal) return { id, added: 0, from: null, to: null, note: 'up to date', warnings };

  let state: IndexState = last ? (({ tradable: _t, ...s }) => s)(last.state) : newIndexState(config.base);
  let tradable: Tradable | null = last?.state.tradable ?? null;
  try {
    tradable = await fetchTradable(m);
  } catch (error) {
    if (!tradable) throw new Error(`Binance is unreachable and no saved list of tradable coins exists yet: ${error instanceof Error ? error.message : error}`);
    warnings.push(`Binance unreachable — using the tradable-coin list saved on ${tradable.asOf}.`);
  }
  const tradableIds = tradable.ids.filter((c) => m.prices[c]);

  // Holdings that left the Lab's coin list still need prices.
  const extra = new Map<string, Map<string, number>>();
  const held = new Set([...Object.keys(state.holdings), ...Object.keys(state.top10.holdings), 'bitcoin']);
  for (const coin of held) {
    if (m.prices[coin]) continue;
    extra.set(coin, new Map((await readSeries(`cg:${coin}`)).map((p) => [p.date, p.value])));
  }
  const priceAt = (coin: string, i: number) => m.prices[coin]?.[i] ?? extra.get(coin)?.get(dates[i]) ?? null;

  // Market cap on a given date, from the saved CoinGecko rows.
  const caps = new Map<string, Map<string, number>>();
  const capOf = async (coin: string) => {
    if (!caps.has(coin)) {
      const rows = await readSeriesFull(`cg:${coin}`);
      caps.set(coin, new Map(rows.filter((r) => r.market_cap != null).map((r) => [r.date, Number(r.market_cap)])));
    }
    return caps.get(coin)!;
  };
  await Promise.all(tradableIds.map(capOf));
  const rank = new Map(m.coins.map((c) => [c.id, c.rank]));
  const bySize = (i: number) =>
    tradableIds
      .map((coin) => ({ coin, marketCap: caps.get(coin)?.get(dates[i]) ?? 0 }))
      .sort((a, b) => b.marketCap - a.marketCap || (rank.get(a.coin) ?? 999) - (rank.get(b.coin) ?? 999));

  const rows: DayRow[] = [];
  for (let i = firstIdx; i <= lastFinal; i += 1) {
    const r = stepDay(
      state,
      {
        date: dates[i],
        price: (coin) => priceAt(coin, i),
        universe: () => bySize(i).slice(0, style.universeSize).map((x) => x.coin),
        ranking: (universe) => {
          const sub: Record<string, (number | null)[]> = {};
          for (const c of universe) sub[c] = m.prices[c];
          return rankAt({ prices: sub, btc: m.prices.bitcoin }, style.signal, style.lookbackDays, i, style.filter);
        },
        top10: (n) => bySize(i).slice(0, n).filter((x) => x.marketCap > 0)
      },
      config
    );
    state = r.state;
    rows.push({
      index_id: id,
      date: dates[i],
      nav: r.nav,
      btc: r.btc,
      top10: r.top10,
      state: { ...r.state, tradable },
      trades: r.trades.length || r.top10Trades.length ? { index: r.trades, top10: r.top10Trades } : null,
      review: r.review
    });
  }

  if (!dryRun) {
    for (let k = 0; k < rows.length; k += 500) {
      const { error } = await supabase.from(TABLE).upsert(rows.slice(k, k + 500), { onConflict: 'index_id,date' });
      if (error) throw new Error(`Failed to save ${TABLE}: ${error.message}`);
    }
  }
  const z = rows[rows.length - 1];
  return {
    id,
    added: rows.length,
    from: rows[0].date,
    to: z.date,
    latest: { date: z.date, nav: z.nav, btc: z.btc, top10: z.top10 },
    warnings,
    ...(dryRun ? { rows } : {})
  };
};

/** Step every index that has been started. Called after each price sync. */
export const stepRotationIndexes = async (): Promise<StepResult[]> => {
  const out: StepResult[] = [];
  for (const id of Object.keys(INDEXES) as IndexId[]) out.push(await stepRotationIndex(id));
  return out;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const maxDrawdown = (values: number[]) => {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    worst = Math.min(worst, v / peak - 1);
  }
  return r2(worst * 100);
};

const indexMeta = (id: IndexId) => {
  const { label, config } = INDEXES[id];
  const style = config.style;
  return {
    id,
    label,
    style: { key: style.key, label: style.label, universe_size: style.universeSize, top_n: style.topN, worst_rank_held: style.worstRankHeld, rebalance_days: style.rebalanceDays, signal: style.signal, lookback_days: style.lookbackDays },
    fee_pct: config.feePct,
    base: config.base,
    top10_size: config.top10Size,
    top10_rebalance_days: config.top10RebalanceDays
  };
};

/** Everything the admin page shows. */
export const getRotationIndexView = async (id: IndexId) => {
  let rows: DayRow[];
  try {
    rows = await loadRows(id);
  } catch (error) {
    if (error instanceof Error && error.message === MISSING_TABLE) return { index: indexMeta(id), started: false as const, table_missing: true };
    throw error;
  }
  if (!rows.length) return { index: indexMeta(id), started: false as const, table_missing: false };
  return buildIndexView(id, rows, await loadPriceMatrix());
};

/** The page's data from saved day rows (also used to preview a dry-run replay). */
export const buildIndexView = (id: IndexId, rows: DayRow[], m: PriceMatrix) => {
  const { config } = INDEXES[id];
  const style = config.style;
  const meta = indexMeta(id);
  const coins = new Map(m.coins.map((c) => [c.id, c]));
  const sym = (c: string) => coins.get(c)?.symbol ?? c.toUpperCase();
  const last = rows[rows.length - 1];
  const st = last.state;
  const ret = (v: number) => r2((v / config.base - 1) * 100);

  const holdings = Object.entries(st.holdings)
    .map(([coin, h]) => {
      const price = st.lastPrice[coin] ?? 0;
      const value = h.units * price;
      return {
        coin,
        symbol: sym(coin),
        name: coins.get(coin)?.name ?? coin,
        image: coins.get(coin)?.image ?? null,
        entry_date: h.entryDate,
        weight_pct: r2((value / last.nav) * 100),
        return_pct: r2((value / h.cost - 1) * 100)
      };
    })
    .sort((a, b) => b.weight_pct - a.weight_pct);

  const top10Value = last.top10;
  const top10 = Object.entries(st.top10.holdings)
    .map(([coin, units]) => ({ symbol: sym(coin), weight_pct: r2(((units * (st.lastPrice[coin] ?? 0)) / top10Value) * 100) }))
    .sort((a, b) => b.weight_pct - a.weight_pct);

  const reviews = rows
    .map((r, k) => ({ r, fills: rows.slice(k + 1).find((x) => x.trades?.index.length)?.trades?.index ?? [] }))
    .filter((x) => x.r.review)
    .reverse()
    .slice(0, 26)
    .map(({ r, fills }) => ({
      date: r.date,
      keep: r.review!.keep.map(sym),
      sells: r.review!.sells.map((s) => ({ symbol: sym(s.coin), reason: s.reason })),
      adds: r.review!.adds.map(sym),
      ranking: r.review!.ranking.map((x) => ({ symbol: sym(x.coin), rank: x.rank, score: r2(x.score * 100) })),
      fills: r.review!.sells.length || r.review!.adds.length
        ? fills.map((t) => ({ side: t.side, symbol: sym(t.coin), price: t.price, value: r2(t.value), reason: t.reason }))
        : []
    }));

  return {
    index: meta,
    started: true as const,
    start_date: rows[0].date,
    first_fill: st.startedOn,
    last_date: last.date,
    days: rows.length,
    tradable_as_of: st.tradable?.asOf ?? null,
    latest: {
      nav: r2(last.nav),
      btc: r2(last.btc),
      top10: r2(last.top10),
      return_pct: ret(last.nav),
      btc_return_pct: ret(last.btc),
      top10_return_pct: ret(last.top10),
      max_drawdown_pct: maxDrawdown(rows.map((r) => r.nav)),
      btc_max_drawdown_pct: maxDrawdown(rows.map((r) => r.btc)),
      top10_max_drawdown_pct: maxDrawdown(rows.map((r) => r.top10))
    },
    holdings,
    cash_pct: r2((st.cash / last.nav) * 100),
    top10,
    pending: st.pending
      ? { decided: st.pending.decided, sells: st.pending.sells.map((s) => ({ symbol: sym(s.coin), reason: s.reason })), adds: st.pending.adds.map(sym) }
      : null,
    last_review: st.lastReview,
    next_review: st.lastReview ? addDays(st.lastReview, style.rebalanceDays) : null,
    series: rows.map((r) => ({ date: r.date, nav: r2(r.nav), btc: r2(r.btc), top10: r2(r.top10) })),
    reviews
  };
};
