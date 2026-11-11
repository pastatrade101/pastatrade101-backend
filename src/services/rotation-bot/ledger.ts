import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OrderResult } from './binance';
import type { StyleKey } from './planner';
import { fromUnits, sizeSell, toUnits, type SymbolRules } from './sizing';

// The bot's own books. It manages a "sleeve": a fixed budget of USDT inside the
// account, and only ever trades what this ledger says it owns — never the rest of
// the account. One JSON file per mode in backend/.bot/ (gitignored), written
// atomically after every order so a crash cannot lose a fill.

export interface LedgerPosition {
  coin: string;
  asset: string;
  symbol: string;
  qty: string;
  entryDate: string;
  costUsdt: number;
}

export interface PendingOrder {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  coin: string;
  asset: string;
  reason: string;
  createdAt: string;
}

export interface HistoryEntry {
  at: string;
  side: 'BUY' | 'SELL';
  coin: string;
  symbol: string;
  qty: string;
  usdt: number;
  fee: string;
  orderId: number;
  reason: string;
}

export interface Ledger {
  version: 1;
  mode: 'testnet' | 'live';
  style: StyleKey;
  createdAt: string;
  budgetUsdt: number;
  cashUsdt: number;
  positions: Record<string, LedgerPosition>;
  lastReview: string | null;
  /** An order sent but not yet booked — reconciled with Binance on the next run. */
  pending: PendingOrder | null;
  /** Leftovers too small for Binance to sell (below its minimum order). */
  dust: Record<string, string>;
  /** Fees paid in BNB (when the account pays fees in BNB), not taken from the sleeve. */
  feesBnb: number;
  history: HistoryEntry[];
}

export const defaultStateDir = () => process.env.BOT_STATE_DIR || path.resolve(__dirname, '../../../.bot');
const fileFor = (dir: string, mode: string) => path.join(dir, `rotation-${mode}.json`);

export const newLedger = (mode: Ledger['mode'], style: StyleKey, budgetUsdt: number, now = new Date()): Ledger => ({
  version: 1,
  mode,
  style,
  createdAt: now.toISOString(),
  budgetUsdt,
  cashUsdt: budgetUsdt,
  positions: {},
  lastReview: null,
  pending: null,
  dust: {},
  feesBnb: 0,
  history: []
});

export const loadLedger = (dir: string, mode: Ledger['mode']): Ledger | null => {
  const file = fileFor(dir, mode);
  if (!existsSync(file)) return null;
  const l = JSON.parse(readFileSync(file, 'utf8')) as Ledger;
  if (l.version !== 1 || l.mode !== mode) throw new Error(`${file} is not a ${mode} ledger.`);
  return l;
};

export const saveLedger = (dir: string, l: Ledger): void => {
  mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, l.mode);
  const tmp = `${file}.tmp`;
  l.history = l.history.slice(-500);
  writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`);
  renameSync(tmp, file);
};

export const deleteLedger = (dir: string, mode: Ledger['mode']): void => rmSync(fileFor(dir, mode), { force: true });

/** One run at a time per mode. A lock older than an hour is treated as stale. */
export const acquireLock = (dir: string, mode: string): (() => void) => {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `rotation-${mode}.lock`);
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 3_600_000) {
    throw new Error(`Another ${mode} run holds ${lock}. If no bot is running, delete that file.`);
  }
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
};

const commission = (o: OrderResult, asset: string) =>
  o.fills.filter((f) => f.commissionAsset === asset).reduce((u, f) => u + toUnits(f.commission), 0n);

const r8 = (n: number) => Math.round(n * 1e8) / 1e8;

/** Book a filled market BUY: the fee comes out of the coins received (or BNB / USDT). */
export const applyBuy = (l: Ledger, coin: string, rules: SymbolRules, o: OrderResult, today: string, reason: string, at = new Date()): void => {
  const spent = Number(o.cummulativeQuoteQty);
  const net = toUnits(o.executedQty) - commission(o, rules.base);
  const feeQuote = Number(fromUnits(commission(o, rules.quote)));
  l.feesBnb = r8(l.feesBnb + (rules.base === 'BNB' ? 0 : Number(fromUnits(commission(o, 'BNB')))));
  l.cashUsdt = r8(l.cashUsdt - spent - feeQuote);
  if (net > 0n) {
    const prev = l.positions[coin];
    l.positions[coin] = prev
      ? { ...prev, qty: fromUnits(toUnits(prev.qty) + net), costUsdt: r8(prev.costUsdt + spent + feeQuote) }
      : { coin, asset: rules.base, symbol: rules.symbol, qty: fromUnits(net), entryDate: today, costUsdt: r8(spent + feeQuote) };
  }
  l.history.push({
    at: at.toISOString(),
    side: 'BUY',
    coin,
    symbol: rules.symbol,
    qty: fromUnits(net),
    usdt: r8(spent),
    fee: o.fills.map((f) => `${f.commission} ${f.commissionAsset}`).join(', ') || '0',
    orderId: o.orderId,
    reason
  });
};

/**
 * Book a filled market SELL. Whatever is left is either kept (if Binance would still
 * accept a sell of it) or moved to dust (too small to ever sell) and the slot freed.
 */
export const applySell = (l: Ledger, coin: string, rules: SymbolRules, o: OrderResult, price: number, reason: string, at = new Date()): void => {
  const pos = l.positions[coin];
  const sold = toUnits(o.executedQty) + commission(o, rules.base);
  const received = Number(o.cummulativeQuoteQty) - Number(fromUnits(commission(o, rules.quote)));
  l.feesBnb = r8(l.feesBnb + (rules.base === 'BNB' ? 0 : Number(fromUnits(commission(o, 'BNB')))));
  l.cashUsdt = r8(l.cashUsdt + received);
  if (pos) {
    const left = toUnits(pos.qty) - sold;
    if (left <= 0n) delete l.positions[coin];
    else if (sizeSell(rules, fromUnits(left), price).ok) {
      l.positions[coin] = { ...pos, qty: fromUnits(left), costUsdt: r8(pos.costUsdt * (Number(fromUnits(left)) / Number(pos.qty))) };
    } else {
      l.dust[pos.asset] = fromUnits(toUnits(l.dust[pos.asset] ?? '0') + left);
      delete l.positions[coin];
    }
  }
  l.history.push({
    at: at.toISOString(),
    side: 'SELL',
    coin,
    symbol: rules.symbol,
    qty: o.executedQty,
    usdt: r8(received),
    fee: o.fills.map((f) => `${f.commission} ${f.commissionAsset}`).join(', ') || '0',
    orderId: o.orderId,
    reason
  });
};

/**
 * Compare the ledger with the account. If the account holds less of a coin than the
 * ledger says (testnet reset, a manual trade), the ledger is cut to what is there.
 * Returns human-readable warnings. Never adds coins the bot did not buy.
 */
export const reconcile = (l: Ledger, free: Map<string, string>): string[] => {
  const warnings: string[] = [];
  for (const [coin, pos] of Object.entries(l.positions)) {
    const have = toUnits(free.get(pos.asset) ?? '0');
    const want = toUnits(pos.qty);
    if (have >= want) continue;
    if (have <= 0n) {
      warnings.push(`${pos.asset}: the ledger holds ${pos.qty} but the account has none — removed from the ledger (testnet reset or a manual trade?).`);
      delete l.positions[coin];
      continue;
    }
    const kept = fromUnits(have);
    warnings.push(`${pos.asset}: the ledger holds ${pos.qty} but the account has ${kept} — the ledger now uses ${kept}.`);
    l.positions[coin] = { ...pos, qty: kept, costUsdt: r8(pos.costUsdt * (Number(kept) / Number(pos.qty))) };
  }
  return warnings;
};
