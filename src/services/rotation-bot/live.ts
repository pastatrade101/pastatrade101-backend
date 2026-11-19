import { readIndexLineUp, type IndexId } from '../rotation-index/rotationIndex.service';
import { BinanceError, createBinance, type ApiRestrictions, type BinanceClient } from './binance';
import { botKeys, hasBotKeys, maxBudgetUsdt, whyCannotTrade } from './config';
import { newLedger } from './ledger';
import { buildSnapshot, saveBotSnapshot, type BotSnapshot } from './snapshot';
import { isLedgerLocked, LEDGER_TABLE_MISSING, openLedgerStore, type BotMode } from './store';

// The admin page's real-time view of the Binance account: balances and prices read
// from Binance on request with this server's key (read-only calls — nothing here
// can place an order), plus what the bot's ledger says the sleeve owns.

/**
 * The index each sleeve follows, from the admin page and the CLI. Both follow Balanced +
 * BTC switch (live since 19 Nov 2026, the owner's call). Changing the live entry moves real
 * money: the sleeve's next run sells what the new index doesn't hold and buys what it does.
 */
export const BOT_FOLLOWS: Record<BotMode, IndexId> = { live: 'rotation-balanced-switch', testnet: 'rotation-balanced-switch' };

/** Polls within this window share one Binance read. */
const FRESH_MS = 4_000;
/** How often a live read also refreshes the saved snapshot (the page's fallback and the sleeve's daily value). */
const SAVE_EVERY_MS = 15 * 60_000;
/** The key's permissions rarely change; check them this often. */
const KEY_CHECK_MS = 10 * 60_000;

export interface LiveWallet {
  mode: BotMode;
  fetched_at: string;
  /** This server has an API key for the mode. */
  keys: boolean;
  /** Why the account could not be read just now (the page then shows the last saved snapshot). */
  error: string | null;
  /** Live only: what the key is allowed to do. */
  key: { withdrawals: boolean; ip_restricted: boolean; spot_trading: boolean } | null;
  snapshot: BotSnapshot | null;
  control: {
    /** This server may place orders for the mode. */
    can_trade: boolean;
    why_not: string | null;
    max_budget_usdt: number | null;
    /** A run holds the lock right now. */
    running: boolean;
  };
}

const cache = new Map<BotMode, { at: number; value: Promise<LiveWallet> }>();
const lastSaved = new Map<BotMode, number>();
const keyChecks = new Map<BotMode, { at: number; value: ApiRestrictions }>();

const restrictions = async (bn: BinanceClient, mode: BotMode, fresh: boolean): Promise<ApiRestrictions> => {
  const hit = keyChecks.get(mode);
  if (!fresh && hit && Date.now() - hit.at < KEY_CHECK_MS) return hit.value;
  const value = await bn.apiRestrictions();
  keyChecks.set(mode, { at: Date.now(), value });
  return value;
};

/** Binance's answer in words the owner can act on. */
const explain = (e: unknown): string => {
  if (e instanceof BinanceError) {
    if (e.code === -2015 || e.code === -2014 || e.code === -1022) {
      return `Binance refused the key (${e.code}): this server's IP address is not on the key's trusted-IP list, or the key was deleted or mistyped. Check it in Binance › API Management.`;
    }
    if (e.status === 0) return `Could not reach Binance: ${e.message}`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
};

const read = async (mode: BotMode, fresh: boolean): Promise<LiveWallet> => {
  const why = whyCannotTrade(mode);
  const store = await openLedgerStore(mode, { fileFallback: false });
  const inDb = store.kind === 'database';
  const [ledger, running, lineUp] = await Promise.all([
    store.load(),
    inDb ? isLedgerLocked(mode) : Promise.resolve(false),
    readIndexLineUp(BOT_FOLLOWS[mode]).catch(() => null)
  ]);
  const out: LiveWallet = {
    mode,
    fetched_at: new Date().toISOString(),
    keys: hasBotKeys(mode),
    error: null,
    key: null,
    snapshot: null,
    control: {
      can_trade: !why && inDb,
      why_not: why ?? (inDb ? null : LEDGER_TABLE_MISSING),
      max_budget_usdt: mode === 'live' ? maxBudgetUsdt() || null : null,
      running
    }
  };
  if (!out.keys) return out;

  const bn = createBinance({ mode, ...botKeys(mode), timeoutMs: 8_000 });
  try {
    await bn.syncTime();
    const [prices, balances, r] = await Promise.all([bn.prices(), bn.balances(), mode === 'live' ? restrictions(bn, mode, fresh) : Promise.resolve(null)]);
    if (r) out.key = { withdrawals: r.enableWithdrawals, ip_restricted: r.ipRestrict, spot_trading: r.enableSpotAndMarginTrading };
    // Before the first run there is no ledger: show the sleeve the first run would start.
    const L = ledger ?? { ...newLedger(mode, 'balanced', mode === 'live' ? maxBudgetUsdt() : 1000), follow: BOT_FOLLOWS[mode] };
    out.snapshot = buildSnapshot({
      ledger: L,
      started: !!ledger,
      prices,
      balances,
      status: ledger?.lastRun ? `Last run: ${ledger.lastRun.summary}` : ledger ? 'Balance from Binance.' : 'Not started — the first run buys the index’s coins.',
      index: lineUp ? { id: lineUp.id, date: lineUp.date } : null,
      nextReview: lineUp?.nextReview ?? null
    });
    if (Date.now() - (lastSaved.get(mode) ?? 0) > SAVE_EVERY_MS) {
      lastSaved.set(mode, Date.now());
      saveBotSnapshot(out.snapshot).catch(() => lastSaved.delete(mode));
    }
  } catch (e) {
    out.error = explain(e);
  }
  return out;
};

/** The account right now. Calls within a few seconds share one read; `fresh` (the page's refresh button) also re-checks the key's permissions. */
export const readLiveWallet = (mode: BotMode, { fresh = false } = {}): Promise<LiveWallet> => {
  const hit = cache.get(mode);
  if (!fresh && hit && Date.now() - hit.at < FRESH_MS) return hit.value;
  const value = read(mode, fresh);
  cache.set(mode, { at: Date.now(), value });
  value.catch(() => cache.delete(mode));
  return value;
};
