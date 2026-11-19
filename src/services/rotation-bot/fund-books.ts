import { supabase } from '../../config/supabase';
import { createBinance } from './binance';
import { botKeys } from './config';
import { BotStop } from './errors';
import { addInvestor, checkFund, editInvestor, sleeveValue, startFund, summarizeFund, unitPriceOf, unitsAtEndOf, valueForBooks, type FundEntry, type FundInvestor } from './fund';
import type { Ledger } from './ledger';
import { LEDGER_TABLE_MISSING, openLedgerStore, type BotMode } from './store';

// The admin page's investor books: read them with today's prices, start them, and
// add or rename people. Money in and out goes through the bot run (runner.ts), since
// it trades; everything here only writes the books, under the same lock as a run.

const fail = (msg: string): never => {
  throw new BotStop(msg);
};

export interface FundInvestorView {
  id: string;
  name: string;
  note: string;
  owner: boolean;
  created_at: string;
  units: number;
  share_pct: number;
  value_usdt: number | null;
  put_in_usdt: number;
  taken_out_usdt: number;
  gain_usdt: number | null;
  gain_pct: number | null;
  cost_usdt: number;
  first_at: string | null;
  first_unit_price: number | null;
  since_joined_pct: number | null;
  provisional: boolean;
}

export interface FundEntryView {
  id: string;
  at: string;
  investor_id: string;
  investor_name: string;
  kind: FundEntry['kind'];
  usdt: number;
  units: number;
  unit_price: number;
  cost_usdt: number;
  units_after: number;
  note: string;
  by: string;
  provisional: boolean;
}

export interface FundView {
  mode: BotMode;
  as_of: string;
  /** The ledger is in the database, so the server can change the books. */
  can_edit: boolean;
  why_not: string | null;
  /** The sleeve has made its first run (the books can start). */
  sleeve_started: boolean;
  started: boolean;
  started_at: string | null;
  /** Why today's value is missing (Binance unreachable, a coin without a price). */
  price_error: string | null;
  value_usdt: number | null;
  units: number;
  unit_price: number | null;
  opening_unit_price: number | null;
  investors: FundInvestorView[];
  /** Newest first. */
  entries: FundEntryView[];
  /** The unit price at the end of each day with a saved snapshot, oldest first. */
  history: { date: string; unit_price: number }[];
  /** Checks on the books (empty when all is well). */
  problems: string[];
}

const investorView = (s: ReturnType<typeof summarizeFund>['investors'][number], priced: boolean): FundInvestorView => ({
  id: s.id,
  name: s.name,
  note: s.note,
  owner: s.owner,
  created_at: s.createdAt,
  units: s.units,
  share_pct: s.sharePct,
  value_usdt: priced ? s.valueUsdt : null,
  put_in_usdt: s.putInUsdt,
  taken_out_usdt: s.takenOutUsdt,
  gain_usdt: priced ? s.gainUsdt : null,
  gain_pct: priced ? s.gainPct : null,
  cost_usdt: s.costUsdt,
  first_at: s.firstAt,
  first_unit_price: s.firstUnitPrice,
  since_joined_pct: priced ? s.sinceJoinedPct : null,
  provisional: s.provisional
});

/** The unit price per day from the saved snapshots (their own unit price, or value ÷ units at that day's end). */
const unitHistory = async (mode: BotMode, l: Ledger): Promise<FundView['history']> => {
  const f = l.fund;
  if (!f) return [];
  const { data, error } = await supabase
    .from('rotation_bot_snapshots')
    .select('date, equity_usdt, fund:snapshot->fund')
    .eq('mode', mode)
    .gte('date', f.startedAt.slice(0, 10))
    .order('date', { ascending: true })
    .limit(1000);
  if (error) return [];
  const out: FundView['history'] = [];
  for (const r of (data ?? []) as { date: string; equity_usdt: number | null; fund: { unit_price?: number | null } | null }[]) {
    const own = r.fund?.unit_price;
    const units = unitsAtEndOf(f, r.date);
    const price = own != null ? Number(own) : r.equity_usdt != null && units && units > 1e-9 ? Number(r.equity_usdt) / units : null;
    if (price != null && Number.isFinite(price)) out.push({ date: r.date, unit_price: price });
  }
  return out;
};

const pricesFor = async (mode: BotMode) => createBinance({ mode, ...botKeys(mode), timeoutMs: 8_000 }).prices();

/** The books with today's Binance prices: everyone's units, value, money in and out, and gain. */
export const readFundView = async (mode: BotMode): Promise<FundView> => {
  const store = await openLedgerStore(mode, { fileFallback: false });
  const l = await store.load();
  const f = l?.fund ?? null;
  const view: FundView = {
    mode,
    as_of: new Date().toISOString(),
    can_edit: store.kind === 'database',
    why_not: store.kind === 'database' ? null : LEDGER_TABLE_MISSING,
    sleeve_started: !!l,
    started: !!f,
    started_at: f?.startedAt ?? null,
    price_error: null,
    value_usdt: null,
    units: f?.units ?? 0,
    unit_price: null,
    opening_unit_price: f?.entries.find((e) => e.kind === 'opening')?.unitPrice ?? null,
    investors: [],
    entries: [],
    history: [],
    problems: f ? checkFund(f) : []
  };
  if (!l || !f) return view;

  let value: number | null = null;
  try {
    const v = sleeveValue(l, await pricesFor(mode));
    if (v.missing.length) view.price_error = `No Binance price for ${v.missing.join(', ')} right now.`;
    else value = v.value;
  } catch (e) {
    view.price_error = `Could not read Binance prices: ${e instanceof Error ? e.message : String(e)}`;
  }
  const summary = summarizeFund(f, value ?? 0);
  view.value_usdt = value;
  view.unit_price = value == null ? null : unitPriceOf(f, value);
  view.investors = summary.investors.map((s) => investorView(s, value != null));
  view.entries = [...f.entries].reverse().map((e) => ({
    id: e.id,
    at: e.at,
    investor_id: e.investorId,
    investor_name: f.investors[e.investorId]?.name ?? e.investorId,
    kind: e.kind,
    usdt: e.usdt,
    units: e.units,
    unit_price: e.unitPrice,
    cost_usdt: e.costUsdt,
    units_after: e.unitsAfter,
    note: e.note,
    by: e.by,
    provisional: !!e.provisional
  }));
  view.history = await unitHistory(mode, l);
  return view;
};

/** Load the ledger under the run lock, change the books, save. Nothing here trades. */
const withBooks = async <T>(mode: BotMode, change: (l: Ledger) => Promise<T> | T): Promise<T> => {
  const store = await openLedgerStore(mode, { fileFallback: false });
  if (store.kind !== 'database') fail(LEDGER_TABLE_MISSING);
  const release = await store.lock();
  try {
    const l = (await store.load()) ?? fail('The sleeve has not made its first run yet — there is nothing to split.');
    if (l.pending) fail('An order from an earlier run is still being checked — run the bot once (Run now) so it settles that order, then try again.');
    const out = await change(l);
    await store.save(l);
    return out;
  } finally {
    await release();
  }
};

/** Open the books: the sleeve as it stands belongs to the owner (one unit per USDT put in so far). */
export const startBooks = (mode: BotMode, ownerName: string, by: string): Promise<FundEntry> =>
  withBooks(mode, async (l) => {
    if (l.fund) fail('The investor books are already started.');
    const value = valueForBooks(l, await pricesFor(mode));
    return startFund(l, { ownerName, value, at: new Date().toISOString(), by });
  });

export const addBooksInvestor = (mode: BotMode, o: { name: string; note?: string }): Promise<FundInvestor> =>
  withBooks(mode, (l) => addInvestor(l.fund ?? fail('Start the investor books first.'), { ...o, at: new Date().toISOString() }));

export const editBooksInvestor = (mode: BotMode, id: string, o: { name?: string; note?: string }): Promise<FundInvestor> =>
  withBooks(mode, (l) => editInvestor(l.fund ?? fail('Start the investor books first.'), id, o));
