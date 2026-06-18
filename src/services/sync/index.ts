import { supabase } from '../../config/supabase';
import type { BtcSignals } from '../scoring/btc-dca';
import { syncBtc } from './sync-btc';
import { syncCoins } from './sync-coins';
import { syncEcosystems } from './sync-ecosystems';
import { syncGlobal } from './sync-global';
import { withJob } from './sync-jobs';

export interface FullSyncResult {
  coins: number;
  btc: boolean;
  global: number;
  ecosystems: number;
}

// Read the latest BTC dominance change from the two most recent global snapshots,
// so the DCA dominance component has a real trend to work with after the first run.
const latestDominanceChange = async (): Promise<number | null> => {
  const { data } = await supabase
    .from('global_market_snapshots')
    .select('btc_dominance')
    .order('captured_at', { ascending: false })
    .limit(2);
  if (!data || data.length < 2) return null;
  const [now, prev] = data;
  if (now.btc_dominance == null || prev.btc_dominance == null) return null;
  return now.btc_dominance - prev.btc_dominance;
};

/**
 * Run the whole ingestion pipeline in dependency order:
 *   coins (markets) → BTC history/signals → global snapshot → ecosystems.
 * Each stage is logged as its own sync_jobs row.
 */
export const runFullSync = async (triggeredBy?: string): Promise<FullSyncResult> => {
  const dominanceChange = await latestDominanceChange();

  const coins = await withJob('coingecko', 'coins', triggeredBy, () => syncCoins(1));

  // Capture BTC signals from the single sync so the global stage can reuse the
  // market-condition label without re-fetching the chart.
  let btcSignals: BtcSignals | null = null;
  const btc = await withJob('coingecko', 'btc', triggeredBy, async () => {
    btcSignals = await syncBtc(dominanceChange);
    return btcSignals ? 1 : 0;
  });

  const global = await withJob('coingecko', 'global', triggeredBy, () => syncGlobal(btcSignals));
  const ecosystems = await withJob('defillama', 'ecosystems', triggeredBy, () => syncEcosystems());

  return {
    coins: coins.records,
    btc: btc.records > 0,
    global: global.records,
    ecosystems: ecosystems.records
  };
};

export { syncCoins, syncBtc, syncGlobal, syncEcosystems };
