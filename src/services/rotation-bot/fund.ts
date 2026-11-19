import { BotStop } from './errors';
import type { Ledger } from './ledger';

// The investor books: who owns which part of the sleeve. They work like a fund's
// units. The sleeve is split into units; the unit price is the sleeve's value
// divided by the units outstanding.
//
// - Money in buys units at the unit price of that moment.
// - Money out cancels units at the unit price of that moment.
// - Gains and losses move the unit price, so everyone's share grows or shrinks
//   by the same percentage, whenever they joined.
//
// Each person carries their own trading costs:
// - Units for money in come from the value the orders actually added.
// - Units cancelled for money out cover the payout plus the cost of the sells.
// So nobody pays for someone else's deposit or withdrawal.
//
// The books live inside the bot's ledger and are saved in the same write as the
// trades, so they can't drift apart. Entries are only ever added. A correction is
// a new entry, never an edit (the one exception is settling a deposit's provisional
// units at the end of its own run).

export type FundEntryKind = 'opening' | 'deposit' | 'withdrawal' | 'fee' | 'adjustment';

export interface FundInvestor {
  id: string;
  name: string;
  note: string;
  createdAt: string;
  owner: boolean;
  /** The site account that may look at this share (view only). */
  userId?: string;
  /** That account's email when it was linked, for the admin page. */
  userEmail?: string;
}

export interface FundEntry {
  id: string;
  at: string;
  investorId: string;
  kind: FundEntryKind;
  /** USDT put in (opening, deposit) or paid out (withdrawal). Always ≥ 0; the kind gives the direction. */
  usdt: number;
  /** Units issued (+) or cancelled (−). */
  units: number;
  /** Sleeve value ÷ units outstanding just before this entry. */
  unitPrice: number;
  /** What the person's own orders cost (fees and price impact), in USDT. */
  costUsdt: number;
  valueBefore: number;
  valueAfter: number;
  unitsAfter: number;
  note: string;
  by: string;
  /** Money in whose orders were interrupted: units at the plain unit price, cost not known. */
  provisional?: boolean;
}

export interface Fund {
  version: 1;
  startedAt: string;
  /** Units outstanding (the sum of every entry's units). */
  units: number;
  investors: Record<string, FundInvestor>;
  /** Oldest first. */
  entries: FundEntry[];
}

export const OWNER_ID = 'owner';

const fail = (msg: string): never => {
  throw new BotStop(msg);
};
const r8 = (n: number) => Math.round(n * 1e8) / 1e8;
const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The sleeve's value: its cash plus every coin at these prices (Binance symbol → price). */
export const sleeveValue = (l: Ledger, prices: Map<string, number>): { value: number; missing: string[] } => {
  let value = l.cashUsdt;
  const missing: string[] = [];
  for (const p of Object.values(l.positions)) {
    const px = prices.get(p.symbol);
    if (!(px && px > 0)) {
      missing.push(p.asset);
      continue;
    }
    value += Number(p.qty) * px;
  }
  return { value: r8(value), missing };
};

/** The sleeve's value, or a stop when a coin has no price (a unit price without it would be wrong). */
export const valueForBooks = (l: Ledger, prices: Map<string, number>): number => {
  const { value, missing } = sleeveValue(l, prices);
  if (missing.length) fail(`No Binance price for ${missing.join(', ')} right now — the unit price can't be worked out, so the books were not changed.`);
  return value;
};

export const unitPriceOf = (f: Fund, value: number): number | null => (f.units > 1e-9 ? value / f.units : null);

const priceOrStop = (f: Fund, value: number) =>
  unitPriceOf(f, value) ?? fail('The books have no units outstanding — everyone has taken their money out. Start new books to continue.');

export const investorUnits = (f: Fund, id: string): number => r8(f.entries.reduce((s, e) => (e.investorId === id ? s + e.units : s), 0));

export const needInvestor = (f: Fund, id: string): FundInvestor => f.investors[id] ?? fail(`No investor "${id}" in the books.`);

const nextEntryId = (f: Fund) => `e${f.entries.length + 1}`;

/**
 * Open the books on a sleeve that is already running. The owner gets one unit per
 * USDT of the sleeve's budget, i.e. the money put in so far. So the opening unit
 * price is the sleeve's value ÷ its budget: 1.00 means break-even so far.
 */
export const startFund = (l: Ledger, o: { ownerName: string; value: number; at: string; by: string }): FundEntry => {
  if (l.fund) fail('The investor books are already started.');
  if (!(l.budgetUsdt > 0)) fail('The sleeve has no budget yet — make its first run before starting the books.');
  if (!(o.value > 0)) fail('The sleeve has no value to split.');
  const name = cleanName(o.ownerName);
  const units = r8(l.budgetUsdt);
  const fund: Fund = {
    version: 1,
    startedAt: o.at,
    units,
    investors: { [OWNER_ID]: { id: OWNER_ID, name, note: 'Owner', createdAt: o.at, owner: true } },
    entries: []
  };
  const entry: FundEntry = {
    id: 'e1',
    at: o.at,
    investorId: OWNER_ID,
    kind: 'opening',
    usdt: r8(l.budgetUsdt),
    units,
    unitPrice: r8(o.value / units),
    costUsdt: 0,
    valueBefore: r8(o.value),
    valueAfter: r8(o.value),
    unitsAfter: units,
    note: `Books opened: the sleeve (${usd(o.value)} USDT) belongs to ${name}, who put in ${usd(l.budgetUsdt)} USDT so far.`,
    by: o.by
  };
  fund.entries.push(entry);
  l.fund = fund;
  return entry;
};

const cleanName = (raw: string) => {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) fail('Enter a name.');
  if (name.length > 60) fail('Keep the name under 60 characters.');
  return name;
};

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'investor';

export const addInvestor = (f: Fund, o: { name: string; note?: string; at: string }): FundInvestor => {
  const name = cleanName(o.name);
  if (Object.values(f.investors).some((i) => i.name.toLowerCase() === name.toLowerCase())) fail(`${name} is already in the books.`);
  if (Object.keys(f.investors).length >= 200) fail('The books hold up to 200 people.');
  const base = slug(name);
  let id = base === OWNER_ID ? `${base}-2` : base;
  for (let n = 2; f.investors[id]; n += 1) id = `${base}-${n}`;
  const inv: FundInvestor = { id, name, note: String(o.note ?? '').trim().slice(0, 200), createdAt: o.at, owner: false };
  f.investors[id] = inv;
  return inv;
};

export const editInvestor = (f: Fund, id: string, o: { name?: string; note?: string }): FundInvestor => {
  const inv = needInvestor(f, id);
  if (o.name !== undefined) {
    const name = cleanName(o.name);
    if (Object.values(f.investors).some((i) => i.id !== id && i.name.toLowerCase() === name.toLowerCase())) fail(`${name} is already in the books.`);
    inv.name = name;
  }
  if (o.note !== undefined) inv.note = String(o.note).trim().slice(0, 200);
  return inv;
};

/** Let a site account see this person's share (view only), or take that away (`user` null). One account per person. */
export const linkInvestorAccount = (f: Fund, id: string, user: { id: string; email: string } | null): FundInvestor => {
  const inv = needInvestor(f, id);
  if (!user) {
    delete inv.userId;
    delete inv.userEmail;
    return inv;
  }
  const other = Object.values(f.investors).find((i) => i.id !== id && i.userId === user.id);
  if (other) fail(`${user.email} is already linked to ${other.name}.`);
  inv.userId = user.id;
  inv.userEmail = user.email;
  return inv;
};

/** One person's units at the end of a UTC day (YYYY-MM-DD). */
export const investorUnitsAtEndOf = (f: Fund, id: string, date: string): number => {
  const end = `${date}T23:59:59.999Z`;
  return r8(f.entries.reduce((s, e) => (e.investorId === id && e.at <= end ? s + e.units : s), 0));
};

/**
 * Money in, booked before its orders are sent: units at the plain unit price, so the
 * money belongs to the person even if the run stops halfway. `settleDeposit` corrects
 * the units to the value the orders actually added once they have filled.
 */
export const openDeposit = (
  f: Fund,
  o: { investorId: string; usdt: number; valueBefore: number; at: string; by: string; note?: string }
): FundEntry => {
  const inv = needInvestor(f, o.investorId);
  if (!(o.usdt > 0)) fail('The amount must be a positive USDT amount.');
  const price = priceOrStop(f, o.valueBefore);
  const units = r8(o.usdt / price);
  const entry: FundEntry = {
    id: nextEntryId(f),
    at: o.at,
    investorId: inv.id,
    kind: 'deposit',
    usdt: r8(o.usdt),
    units,
    unitPrice: r8(price),
    costUsdt: 0,
    valueBefore: r8(o.valueBefore),
    valueAfter: r8(o.valueBefore + o.usdt),
    unitsAfter: r8(f.units + units),
    note: o.note ?? '',
    by: o.by,
    provisional: true
  };
  f.entries.push(entry);
  f.units = entry.unitsAfter;
  return entry;
};

/** Units for the value the deposit's orders actually added (at the same prices as `valueBefore`). */
export const settleDeposit = (f: Fund, entryId: string, valueAfter: number): FundEntry => {
  const e = f.entries[f.entries.length - 1];
  if (!e || e.id !== entryId || e.kind !== 'deposit' || !e.provisional) fail(`Entry ${entryId} is not an open deposit.`);
  const added = valueAfter - e.valueBefore;
  // Something odd (the cash was lost?): keep the plain units rather than guess.
  if (!(added > 0) || added > e.usdt * 1.05) return e;
  const units = r8(added / e.unitPrice);
  f.units = r8(f.units - e.units + units);
  e.units = units;
  e.costUsdt = r8(e.usdt - added);
  e.valueAfter = r8(valueAfter);
  e.unitsAfter = f.units;
  delete e.provisional;
  return e;
};

/**
 * Money out, booked after its sells. The payout has left the sleeve's cash. The
 * units cancelled cover the value the sleeve lost: the payout plus the cost of the
 * sells, at the same prices as `valueBefore`. They never exceed what the person holds.
 *
 * With `all`, a difference of a few cents is rounded away so the person ends at
 * zero. A bigger gap (a slice too small for Binance to sell) stays with them as units.
 */
export const recordWithdrawal = (
  f: Fund,
  o: { investorId: string; payout: number; valueBefore: number; valueAfterSells: number; all: boolean; at: string; by: string; note?: string }
): FundEntry => {
  const inv = needInvestor(f, o.investorId);
  const held = investorUnits(f, inv.id);
  if (!(held > 0)) fail(`${inv.name} holds no units.`);
  if (!(o.payout > 0)) fail('Nothing was paid out.');
  const price = priceOrStop(f, o.valueBefore);
  const valueAfter = o.valueAfterSells - o.payout;
  let units = Math.min(held, (o.valueBefore - valueAfter) / price);
  if (o.all && (held - units) * price <= Math.max(0.05, held * price * 0.002)) units = held;
  units = r8(units);
  const entry: FundEntry = {
    id: nextEntryId(f),
    at: o.at,
    investorId: inv.id,
    kind: 'withdrawal',
    usdt: r8(o.payout),
    units: -units,
    unitPrice: r8(price),
    costUsdt: r8(units * price - o.payout),
    valueBefore: r8(o.valueBefore),
    valueAfter: r8(valueAfter),
    unitsAfter: r8(f.units - units),
    note: o.note ?? '',
    by: o.by
  };
  f.entries.push(entry);
  f.units = entry.unitsAfter;
  return entry;
};

export interface InvestorSummary {
  id: string;
  name: string;
  note: string;
  owner: boolean;
  createdAt: string;
  units: number;
  /** Share of the sleeve, %. */
  sharePct: number;
  valueUsdt: number;
  putInUsdt: number;
  takenOutUsdt: number;
  /** What the money earned: value now + taken out − put in. */
  gainUsdt: number;
  /** Gain on the money put in, %. */
  gainPct: number | null;
  costUsdt: number;
  firstAt: string | null;
  firstUnitPrice: number | null;
  /** The unit price's change since this person's first money in, %. */
  sinceJoinedPct: number | null;
  /** A money-in whose orders were interrupted (units at the plain price). */
  provisional: boolean;
}

/** Everyone's holding at this sleeve value, biggest first. */
export const summarizeFund = (f: Fund, value: number): { unitPrice: number | null; investors: InvestorSummary[] } => {
  const price = unitPriceOf(f, value);
  const investors = Object.values(f.investors).map((inv): InvestorSummary => {
    const mine = f.entries.filter((e) => e.investorId === inv.id);
    const units = r8(mine.reduce((s, e) => s + e.units, 0));
    const putIn = mine.filter((e) => e.kind === 'opening' || e.kind === 'deposit').reduce((s, e) => s + e.usdt, 0);
    const takenOut = mine.filter((e) => e.kind === 'withdrawal').reduce((s, e) => s + e.usdt, 0);
    const valueNow = price == null ? 0 : units * price;
    const gain = valueNow + takenOut - putIn;
    // "Joined" is the first money in of the current stay: someone who took everything out and came back starts again.
    let first: FundEntry | null = null;
    let running = 0;
    for (const e of mine) {
      if (running <= 1e-9 && e.units > 0) first = e;
      running += e.units;
    }
    if (units <= 1e-9) first = null;
    return {
      id: inv.id,
      name: inv.name,
      note: inv.note,
      owner: inv.owner,
      createdAt: inv.createdAt,
      units,
      sharePct: f.units > 1e-9 ? (units / f.units) * 100 : 0,
      valueUsdt: valueNow,
      putInUsdt: putIn,
      takenOutUsdt: takenOut,
      gainUsdt: gain,
      gainPct: putIn > 0 ? (gain / putIn) * 100 : null,
      costUsdt: mine.reduce((s, e) => s + Math.max(0, e.costUsdt), 0),
      firstAt: first?.at ?? null,
      firstUnitPrice: first?.unitPrice ?? null,
      sinceJoinedPct: first && price != null && first.unitPrice > 0 ? (price / first.unitPrice - 1) * 100 : null,
      provisional: mine.some((e) => e.provisional)
    };
  });
  investors.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
  return { unitPrice: price, investors };
};

/** Units outstanding at the end of a UTC day (before the books opened: null). */
export const unitsAtEndOf = (f: Fund, date: string): number | null => {
  const end = `${date}T23:59:59.999Z`;
  let units: number | null = null;
  for (const e of f.entries) if (e.at <= end) units = e.unitsAfter;
  return units;
};

/** Problems in the books (none expected): units that don't add up, or someone below zero. */
export const checkFund = (f: Fund): string[] => {
  const problems: string[] = [];
  const total = r8(f.entries.reduce((s, e) => s + e.units, 0));
  if (Math.abs(total - f.units) > 1e-6) problems.push(`Units outstanding are ${f.units} but the entries add up to ${total}.`);
  for (const id of Object.keys(f.investors)) if (investorUnits(f, id) < -1e-8) problems.push(`${f.investors[id].name} is below zero units.`);
  for (const e of f.entries) if (!f.investors[e.investorId]) problems.push(`Entry ${e.id} names an unknown investor ${e.investorId}.`);
  return problems;
};
