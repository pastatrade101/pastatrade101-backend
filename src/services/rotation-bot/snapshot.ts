import { supabase } from '../../config/supabase';
import type { Balance } from './binance';
import { unitPriceOf } from './fund';
import type { HistoryEntry, Ledger } from './ledger';

// What the bot's sleeve holds, saved after every real run (and now and then while
// the admin page reads the account live) so the admin Rotation Index page has it
// even when Binance can't be reached. One row per mode per UTC day — the day's
// last save wins — so the rows also draw the sleeve's value over time.

const TABLE = 'rotation_bot_snapshots';
export const SNAPSHOT_TABLE_MISSING = `The ${TABLE} table does not exist yet — create it with backend/database/rotation-bot-snapshots.sql.`;
const isMissingTable = (e: { code?: string; message?: string }) => e.code === 'PGRST205' || e.code === '42P01' || /could not find the table/i.test(e.message ?? '');

/** Spot assets listed in the snapshot (biggest first); the rest are only counted. */
const SPOT_LIST_MAX = 25;
const DOLLARS = new Set(['USDT', 'USDC', 'FDUSD']);

export interface SnapshotPosition {
  coin: string;
  asset: string;
  qty: string;
  price: number | null;
  value_usdt: number | null;
  cost_usdt: number;
  return_pct: number | null;
  entry_date: string;
}

export interface SpotAsset {
  asset: string;
  free: number;
  locked: number;
  /** null when Binance has no USDT price for it (e.g. Earn receipts like LDUSDT). */
  value_usdt: number | null;
}

export interface BotSnapshot {
  version: 1;
  mode: 'testnet' | 'live';
  taken_at: string;
  /** Index id when the sleeve copies a Rotation Index, else null (it runs the rule itself). */
  follow: string | null;
  style: string;
  /** False until the sleeve's first buy is saved (e.g. waiting for the index's fill). */
  started: boolean;
  started_on: string | null;
  budget_usdt: number;
  /** Money added after the first run; budget_usdt already includes it. */
  top_ups?: { at: string; usdt: number }[];
  cash_usdt: number;
  equity_usdt: number | null;
  return_pct: number | null;
  positions: SnapshotPosition[];
  dust: Record<string, string>;
  fees_bnb: number;
  /** One plain sentence on what this run did. */
  status: string;
  /** The latest real run that kept the books (it may be older than this snapshot). */
  last_run?: { at: string; summary: string; by: 'cli' | 'admin' } | null;
  /** The index day the sleeve was compared with. */
  index: { id: string; date: string } | null;
  next_review: string | null;
  /** The whole Spot wallet, not just the sleeve. */
  spot: { total_usdt: number; assets: SpotAsset[]; more: number } | null;
  /** Newest first. */
  trades: HistoryEntry[];
  /** The investor books, when started: units outstanding and the unit price at this snapshot. */
  fund?: { started_at: string; units: number; unit_price: number | null; investors: number } | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export const buildSnapshot = (input: {
  ledger: Ledger;
  started: boolean;
  /** Binance last prices by symbol (e.g. TRXUSDT). */
  prices: Map<string, number>;
  balances: Map<string, Balance> | null;
  status: string;
  index: { id: string; date: string } | null;
  nextReview: string | null;
  now?: Date;
}): BotSnapshot => {
  const { ledger: L, prices } = input;
  const usdtOf = (asset: string, qty: number) => (DOLLARS.has(asset) ? qty : prices.has(`${asset}USDT`) ? qty * prices.get(`${asset}USDT`)! : null);

  const positions: SnapshotPosition[] = Object.values(L.positions).map((p) => {
    const price = prices.get(p.symbol) ?? null;
    const value = price == null ? null : r2(Number(p.qty) * price);
    return {
      coin: p.coin,
      asset: p.asset,
      qty: p.qty,
      price,
      value_usdt: value,
      cost_usdt: r2(p.costUsdt),
      return_pct: value == null || !(p.costUsdt > 0) ? null : r2((value / p.costUsdt - 1) * 100),
      entry_date: p.entryDate
    };
  });
  positions.sort((a, b) => (b.value_usdt ?? 0) - (a.value_usdt ?? 0));
  const invested = positions.reduce((s, p) => s + (p.value_usdt ?? 0), 0);
  const equity = input.started ? r2(L.cashUsdt + invested) : null;

  let spot: BotSnapshot['spot'] = null;
  if (input.balances) {
    const assets: SpotAsset[] = [...input.balances.values()]
      .map((b) => {
        const free = Number(b.free);
        const locked = Number(b.locked);
        const v = usdtOf(b.asset, free + locked);
        return { asset: b.asset, free, locked, value_usdt: v == null ? null : r2(v) };
      })
      .filter((b) => b.free + b.locked > 0)
      .sort((a, b) => (b.value_usdt ?? -1) - (a.value_usdt ?? -1) || a.asset.localeCompare(b.asset));
    spot = {
      total_usdt: r2(assets.reduce((s, b) => s + (b.value_usdt ?? 0), 0)),
      assets: assets.slice(0, SPOT_LIST_MAX),
      more: Math.max(0, assets.length - SPOT_LIST_MAX)
    };
  }

  return {
    version: 1,
    mode: L.mode,
    taken_at: (input.now ?? new Date()).toISOString(),
    follow: L.follow ?? null,
    style: L.style,
    started: input.started,
    started_on: input.started ? L.createdAt.slice(0, 10) : null,
    budget_usdt: L.budgetUsdt,
    top_ups: L.topUps ?? [],
    cash_usdt: r2(L.cashUsdt),
    equity_usdt: equity,
    return_pct: equity == null || !(L.budgetUsdt > 0) ? null : r2((equity / L.budgetUsdt - 1) * 100),
    positions,
    dust: L.dust,
    fees_bnb: L.feesBnb,
    status: input.status,
    last_run: L.lastRun ?? null,
    index: input.index,
    next_review: input.nextReview,
    spot,
    trades: [...L.history].reverse().slice(0, 20),
    fund: L.fund
      ? {
          started_at: L.fund.startedAt,
          units: L.fund.units,
          // From the unrounded value, so the price matches the investor books exactly.
          unit_price: equity == null ? null : unitPriceOf(L.fund, L.cashUsdt + Object.values(L.positions).reduce((x, p) => x + (prices.has(p.symbol) ? Number(p.qty) * prices.get(p.symbol)! : 0), 0)),
          investors: Object.keys(L.fund.investors).length
        }
      : null
  };
};

export const saveBotSnapshot = async (s: BotSnapshot): Promise<void> => {
  const { error } = await supabase
    .from(TABLE)
    .upsert({ mode: s.mode, date: s.taken_at.slice(0, 10), taken_at: s.taken_at, equity_usdt: s.equity_usdt, snapshot: s }, { onConflict: 'mode,date' });
  if (error) throw new Error(isMissingTable(error) ? SNAPSHOT_TABLE_MISSING : `Failed to save ${TABLE}: ${error.message}`);
};

export interface BotModeView {
  latest: BotSnapshot;
  /** One point per day that had a real run, oldest first. */
  history: { date: string; equity_usdt: number; unit_price?: number | null }[];
}

/** The newest snapshot and the value history for each mode — what the admin page shows. */
export const readBotSnapshots = async (): Promise<{ table_missing: boolean; live: BotModeView | null; testnet: BotModeView | null }> => {
  const read = async (mode: 'live' | 'testnet'): Promise<BotModeView | null> => {
    const { data, error } = await supabase.from(TABLE).select('date, equity_usdt, snapshot').eq('mode', mode).order('date', { ascending: false }).limit(366);
    if (error) throw error;
    const rows = (data ?? []) as { date: string; equity_usdt: number | null; snapshot: BotSnapshot }[];
    if (!rows.length) return null;
    return {
      latest: rows[0].snapshot,
      history: rows
        .filter((r) => r.equity_usdt != null)
        .map((r) => ({ date: r.date, equity_usdt: Number(r.equity_usdt), unit_price: r.snapshot?.fund?.unit_price ?? null }))
        .reverse()
    };
  };
  try {
    const [live, testnet] = await Promise.all([read('live'), read('testnet')]);
    return { table_missing: false, live, testnet };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (isMissingTable(e)) return { table_missing: true, live: null, testnet: null };
    throw new Error(`Failed to read ${TABLE}: ${e.message ?? String(error)}`);
  }
};
