import { existsSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { supabase } from '../../config/supabase';
import { BotStop } from './errors';
import { acquireLock, defaultStateDir, deleteLedger, loadLedger, saveLedger, type Ledger } from './ledger';

// Where the bot keeps its ledger. The database (rotation_bot_ledgers) is the one
// source of truth, so the server (admin page buttons) and the command line on the
// owner's Mac see the same books and take turns through one lock. Before that table
// exists the command line falls back to the old file in backend/.bot/; the first
// trading run after the table exists moves the file into the database.

export type BotMode = Ledger['mode'];

const TABLE = 'rotation_bot_ledgers';
export const LEDGER_TABLE_MISSING = `The ${TABLE} table does not exist yet — create it once with backend/database/rotation-bot-ledgers.sql in the Supabase SQL editor.`;
const isMissingTable = (e: { code?: string; message?: string }) => e.code === 'PGRST205' || e.code === '42P01' || /could not find the table/i.test(e.message ?? '');

/** A run is seconds long; a lock this old was left by a crash. */
const LOCK_MS = 15 * 60_000;



export interface LedgerStore {
  kind: 'database' | 'file';
  /** The ledger, or null before the sleeve's first real run. `adopt` moves an old file into the database. */
  load(opts?: { adopt?: boolean }): Promise<Ledger | null>;
  save(l: Ledger): Promise<void>;
  clear(): Promise<void>;
  /** One trading run per mode at a time. Returns the release function. */
  lock(): Promise<() => Promise<void>>;
  /** Plain notes for the run log (e.g. "moved the ledger into the database"). */
  notes: string[];
}

const fileStore = (mode: BotMode, writable: boolean): LedgerStore => {
  const dir = defaultStateDir();
  const refuse = () => {
    throw new BotStop(LEDGER_TABLE_MISSING);
  };
  return {
    kind: 'file',
    notes: [],
    load: async () => loadLedger(dir, mode),
    save: async (l) => (writable ? saveLedger(dir, l) : refuse()),
    clear: async () => (writable ? deleteLedger(dir, mode) : refuse()),
    lock: async () => {
      if (!writable) refuse();
      const release = acquireLock(dir, mode);
      return async () => release();
    }
  };
};

const legacyFile = (mode: BotMode) => path.join(defaultStateDir(), `rotation-${mode}.json`);
/** Once moved into the database the old file is renamed, so it is never read again. */
const retireFile = (mode: BotMode) => {
  const file = legacyFile(mode);
  if (existsSync(file)) renameSync(file, file.replace(/\.json$/, `.moved-to-database-${new Date().toISOString().slice(0, 10)}.json`));
};

const dbStore = (mode: BotMode): LedgerStore => {
  const notes: string[] = [];
  const write = async (l: Ledger | null) => {
    if (l) l.history = l.history.slice(-500);
    const { error } = await supabase.from(TABLE).upsert({ mode, ledger: l, updated_at: new Date().toISOString() }, { onConflict: 'mode' });
    if (error) throw new Error(`Failed to save the ${mode} ledger: ${error.message}`);
  };
  return {
    kind: 'database',
    notes,
    async load({ adopt = false } = {}) {
      const { data, error } = await supabase.from(TABLE).select('ledger').eq('mode', mode).maybeSingle();
      if (error) throw new Error(`Failed to read the ${mode} ledger: ${error.message}`);
      const l = (data?.ledger ?? null) as Ledger | null;
      if (l) {
        if (l.version !== 1 || l.mode !== mode) throw new Error(`The database row for ${mode} is not a ${mode} ledger.`);
        return l;
      }
      // Nothing in the database yet: an older run may have kept the books in a file here.
      const old = loadLedger(defaultStateDir(), mode);
      if (old && adopt) {
        await write(old);
        retireFile(mode);
        notes.push(`Moved the ${mode} ledger from ${legacyFile(mode)} into the database.`);
      }
      return old;
    },
    save: (l) => write(l),
    async clear() {
      await write(null);
      retireFile(mode);
    },
    async lock() {
      const owner = `${hostname()}:${process.pid}`;
      const now = new Date();
      // The row exists from the SQL file; this only covers a table created without it.
      await supabase.from(TABLE).upsert({ mode }, { onConflict: 'mode', ignoreDuplicates: true });
      const { data, error } = await supabase
        .from(TABLE)
        .update({ lock_owner: owner, lock_until: new Date(now.getTime() + LOCK_MS).toISOString() })
        .eq('mode', mode)
        .or(`lock_until.is.null,lock_until.lt."${now.toISOString()}"`)
        .select('mode');
      if (error) throw new Error(`Failed to lock the ${mode} ledger: ${error.message}`);
      if (!data?.length) {
        const { data: row } = await supabase.from(TABLE).select('lock_owner, lock_until').eq('mode', mode).maybeSingle();
        const until = row?.lock_until ? new Date(row.lock_until as string).toISOString().slice(11, 16) : '?';
        throw new BotStop(`Another ${mode} run is in progress (${row?.lock_owner ?? 'unknown'}, lock expires ${until} UTC). Try again once it finishes.`);
      }
      return async () => {
        // Best effort: if this fails the lock still expires on its own.
        await Promise.resolve(supabase.from(TABLE).update({ lock_owner: null, lock_until: null }).eq('mode', mode).eq('lock_owner', owner)).catch(() => {});
      };
    }
  };
};

/**
 * The ledger store for a mode. With `fileFallback` (the command line), a missing
 * table falls back to the old file; without it (the server), the books can still be
 * read from a file but trading needs the table.
 */
export const openLedgerStore = async (mode: BotMode, { fileFallback }: { fileFallback: boolean }): Promise<LedgerStore> => {
  const { error } = await supabase.from(TABLE).select('mode').limit(1);
  if (!error) return dbStore(mode);
  if (!isMissingTable(error)) throw new Error(`Failed to reach ${TABLE}: ${error.message}`);
  const s = fileStore(mode, fileFallback);
  s.notes.push(`${LEDGER_TABLE_MISSING} Until then the ledger stays in ${legacyFile(mode)}${fileFallback ? '' : ' and the server cannot trade'}.`);
  return s;
};

/** Whether a run currently holds the mode's lock (for the admin page). */
export const isLedgerLocked = async (mode: BotMode): Promise<boolean> => {
  const { data, error } = await supabase.from(TABLE).select('lock_until').eq('mode', mode).maybeSingle();
  if (error || !data?.lock_until) return false;
  return Date.parse(data.lock_until as string) > Date.now();
};
