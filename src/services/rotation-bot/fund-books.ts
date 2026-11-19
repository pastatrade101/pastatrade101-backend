import { supabase } from '../../config/supabase';
import { createBinance } from './binance';
import { botKeys } from './config';
import { BotStop } from './errors';
import {
  addInvestor,
  checkFund,
  editInvestor,
  investorUnitsAtEndOf,
  linkInvestorAccount,
  sleeveValue,
  startFund,
  summarizeFund,
  unitPriceOf,
  unitsAtEndOf,
  valueForBooks,
  type Fund,
  type FundEntry,
  type FundInvestor
} from './fund';
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
  /** The site account that can see this share (view only), if linked. */
  user_id: string | null;
  user_email: string | null;
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

const investorView = (s: ReturnType<typeof summarizeFund>['investors'][number], priced: boolean, inv: FundInvestor | undefined): FundInvestorView => ({
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
  provisional: s.provisional,
  user_id: inv?.userId ?? null,
  user_email: inv?.userEmail ?? null
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

// Prices are cached for a few seconds: investors' own pages read them too.
const priceCache = new Map<BotMode, { at: number; prices: Promise<Map<string, number>> }>();
const pricesFor = (mode: BotMode): Promise<Map<string, number>> => {
  const hit = priceCache.get(mode);
  if (hit && Date.now() - hit.at < 20_000) return hit.prices;
  const prices = createBinance({ mode, ...botKeys(mode), timeoutMs: 8_000 }).prices();
  priceCache.set(mode, { at: Date.now(), prices });
  prices.catch(() => priceCache.delete(mode));
  return prices;
};

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
  view.investors = summary.investors.map((s) => investorView(s, value != null, f.investors[s.id]));
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

/* ── Site accounts: who may look at which share (view only) ─────────────────── */

const MODES: BotMode[] = ['live', 'testnet'];

/** Who is linked to which share, cached briefly: the site's menu asks on every visit. */
let linkCache: { at: number; byUser: Promise<Map<string, BotMode[]>> } | null = null;
const linkedUsers = (): Promise<Map<string, BotMode[]>> => {
  if (linkCache && Date.now() - linkCache.at < 60_000) return linkCache.byUser;
  const byUser = (async () => {
    const out = new Map<string, BotMode[]>();
    for (const mode of MODES) {
      const store = await openLedgerStore(mode, { fileFallback: false });
      const f = (await store.load())?.fund;
      for (const inv of Object.values(f?.investors ?? {})) if (inv.userId) out.set(inv.userId, [...(out.get(inv.userId) ?? []), mode]);
    }
    return out;
  })();
  linkCache = { at: Date.now(), byUser };
  byUser.catch(() => (linkCache = null));
  return byUser;
};

/** Link a person in the books to a site account (or unlink with `userId` null). Writes the books only. */
export const linkBooksAccount = async (mode: BotMode, id: string, userId: string | null): Promise<FundInvestor> => {
  let user: { id: string; email: string } | null = null;
  if (userId) {
    const { data, error } = await supabase.from('users').select('id, email, is_active').eq('id', userId).maybeSingle();
    if (error) fail(`Could not read that account: ${error.message}`);
    if (!data) fail('No account with that id.');
    if (data!.is_active === false) fail(`${data!.email} is switched off — switch the account on first.`);
    user = { id: String(data!.id), email: String(data!.email) };
  }
  const inv = await withBooks(mode, (l) => linkInvestorAccount(l.fund ?? fail('Start the investor books first.'), id, user));
  linkCache = null;
  return inv;
};

/** Whether this account can see a share, without reading prices (for the site menu). */
export const myInvestmentModes = async (userId: string): Promise<BotMode[]> => (await linkedUsers()).get(userId) ?? [];

export interface MyInvestmentView {
  mode: BotMode;
  as_of: string;
  name: string;
  /** Why today's value is missing (Binance unreachable, a coin without a price). */
  price_error: string | null;
  value_usdt: number | null;
  units: number;
  unit_price: number | null;
  put_in_usdt: number;
  taken_out_usdt: number;
  gain_usdt: number | null;
  gain_pct: number | null;
  cost_usdt: number;
  first_at: string | null;
  first_unit_price: number | null;
  since_joined_pct: number | null;
  /** Their slice of what the sleeve holds now (cash as USDT), biggest first. */
  holdings: { asset: string; value_usdt: number; weight_pct: number }[];
  /** Their own money in and out, newest first. */
  entries: { at: string; kind: FundEntry['kind']; usdt: number; units: number; unit_price: number; provisional: boolean }[];
  /** Their value at the end of each day with a saved snapshot, then now; oldest first. */
  history: { date: string; value_usdt: number }[];
}

/**
 * The shares a signed-in account may see — only its own: no other names, and not the
 * sleeve's total size. Read only; nothing here changes the books.
 */
export const readMyInvestments = async (userId: string): Promise<MyInvestmentView[]> => {
  const out: MyInvestmentView[] = [];
  for (const mode of await myInvestmentModes(userId)) {
    const store = await openLedgerStore(mode, { fileFallback: false });
    const l = await store.load();
    const f: Fund | undefined = l?.fund;
    const inv = Object.values(f?.investors ?? {}).find((i) => i.userId === userId);
    if (!l || !f || !inv) continue;

    let value: number | null = null;
    let priceError: string | null = null;
    let prices: Map<string, number> | null = null;
    try {
      prices = await pricesFor(mode);
      const v = sleeveValue(l, prices);
      if (v.missing.length) priceError = 'Some prices are missing right now — values show again shortly.';
      else value = v.value;
    } catch {
      priceError = 'Prices could not be read right now — values show again shortly.';
    }
    const s = summarizeFund(f, value ?? 0).investors.find((x) => x.id === inv.id);
    if (!s) continue;
    const priced = value != null;
    const share = f.units > 1e-9 ? s.units / f.units : 0;

    const holdings: MyInvestmentView['holdings'] = [];
    if (priced && prices && value! > 0 && share > 0) {
      for (const p of Object.values(l.positions)) {
        const v = Number(p.qty) * (prices.get(p.symbol) ?? 0);
        if (v > 0) holdings.push({ asset: p.asset, value_usdt: v * share, weight_pct: (v / value!) * 100 });
      }
      if (l.cashUsdt > 0.005) holdings.push({ asset: 'USDT', value_usdt: l.cashUsdt * share, weight_pct: (l.cashUsdt / value!) * 100 });
      holdings.sort((a, b) => b.value_usdt - a.value_usdt);
    }

    const history: MyInvestmentView['history'] = [];
    for (const h of await unitHistory(mode, l)) {
      const u = investorUnitsAtEndOf(f, inv.id, h.date);
      if (u > 1e-9) history.push({ date: h.date, value_usdt: u * h.unit_price });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (priced && s.units > 1e-9) {
      if (history.length && history[history.length - 1].date === today) history.pop();
      history.push({ date: today, value_usdt: s.valueUsdt });
    }

    out.push({
      mode,
      as_of: new Date().toISOString(),
      name: inv.name,
      price_error: priceError,
      value_usdt: priced ? s.valueUsdt : null,
      units: s.units,
      unit_price: priced ? unitPriceOf(f, value!) : null,
      put_in_usdt: s.putInUsdt,
      taken_out_usdt: s.takenOutUsdt,
      gain_usdt: priced ? s.gainUsdt : null,
      gain_pct: priced ? s.gainPct : null,
      cost_usdt: s.costUsdt,
      first_at: s.firstAt,
      first_unit_price: s.firstUnitPrice,
      since_joined_pct: priced ? s.sinceJoinedPct : null,
      holdings,
      entries: f.entries
        .filter((e) => e.investorId === inv.id)
        .reverse()
        .map((e) => ({ at: e.at, kind: e.kind, usdt: e.usdt, units: e.units, unit_price: e.unitPrice, provisional: !!e.provisional })),
      history
    });
  }
  // Real money first.
  return out.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'live' ? -1 : 1));
};
