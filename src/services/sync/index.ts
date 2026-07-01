import { supabase } from '../../config/supabase';
import type { BtcSignals } from '../scoring/btc-dca';
import { syncBtc } from './sync-btc';
import { syncCoins } from './sync-coins';
import { syncEcosystems } from './sync-ecosystems';
import { syncGlobal } from './sync-global';
import { syncPriceSeries } from './sync-price-series';
import { syncSocialMetrics } from './sync-social-metrics';
import { syncOnchain } from './sync-onchain';
import { syncRisk } from './sync-risk';
import { storeDerivativesDaily } from '../derivatives/derivatives.service';
import { storeMacroRegimeDaily } from '../macro-regime/macroRegime.service';
import { storeExitStrategyDaily } from '../exit-strategy/exitStrategy.service';
import { runEarlyOpportunitySync } from '../early-opportunity/earlyOpportunitySync.service';
import { runAltBtcBottomSync } from '../alt-btc-bottom/altBtcBottomSync.service';
import { withJob } from './sync-jobs';

export interface FullSyncStep {
  step: string;
  ok: boolean;
  records: number;
  error?: string;
}
export interface FullSyncResult {
  steps: FullSyncStep[];
  ok: number;
  failed: number;
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
 * Run the ENTIRE ingestion pipeline in dependency order:
 *   coins → BTC → global → ecosystems → Lab price series → social → on-chain
 *   (which also refreshes supply profit/loss + the risk model) → risk rebuild.
 *
 * Each stage is isolated: a failure (e.g. a BGeometrics rate limit) is logged to
 * sync_jobs and reported, but never aborts the rest of the pipeline. Heavy — the
 * price-series + on-chain stages can take several minutes against free tiers.
 */
export const runFullSync = async (triggeredBy?: string): Promise<FullSyncResult> => {
  const dominanceChange = await latestDominanceChange();
  let btcSignals: BtcSignals | null = null;

  const run = async (step: string, source: string, jobType: string, fn: () => Promise<number>): Promise<FullSyncStep> => {
    try {
      const { records } = await withJob(source, jobType, triggeredBy, fn);
      return { step, ok: true, records };
    } catch (e) {
      return { step, ok: false, records: 0, error: e instanceof Error ? e.message : String(e) };
    }
  };

  const steps: FullSyncStep[] = [];
  // Macro regime (Twelve Data) — traditional-market context. Runs first; it has no
  // dependency on the crypto steps and is graceful if unconfigured.
  steps.push(await run('macro-regime', 'twelvedata', 'macro-regime', () => storeMacroRegimeDaily()));
  steps.push(await run('coins', 'coingecko', 'coins', () => syncCoins(1)));
  steps.push(
    await run('btc', 'coingecko', 'btc', async () => {
      btcSignals = await syncBtc(dominanceChange);
      return btcSignals ? 1 : 0;
    })
  );
  steps.push(await run('global', 'coingecko', 'global', () => syncGlobal(btcSignals)));
  steps.push(await run('ecosystems', 'defillama', 'ecosystems', () => syncEcosystems()));
  // Derivatives runs before social so today's leverage euphoria feeds Social Risk.
  steps.push(await run('derivatives', 'bitget', 'derivatives', () => storeDerivativesDaily()));
  steps.push(await run('social', 'social', 'social-metrics', () => syncSocialMetrics()));
  steps.push(await run('onchain', 'bgeometrics', 'onchain', () => syncOnchain()));
  // Ensure the risk model is rebuilt even if the on-chain stage failed.
  steps.push(await run('risk', 'risk', 'risk', () => syncRisk()));
  // Early Opportunity Radar — discovery scan (CoinGecko + GeckoTerminal + GoPlus).
  steps.push(await run('early-opportunity', 'radar', 'early-opportunity', () => runEarlyOpportunitySync()));
  // Alt/BTC Bottom Radar reads the daily series (prior cycle's; price-series
  // refreshes them below). One-day lag is negligible for 365-day relative-strength.
  steps.push(await run('alt-btc-bottom', 'radar', 'alt-btc-bottom', () => runAltBtcBottomSync()));
  // price-series is the slowest step (throttled CoinGecko loop) — run it near the
  // end so the quick steps surface first. It refreshes the price series for next cycle.
  steps.push(await run('price-series', 'coingecko', 'price-series', () => syncPriceSeries()));
  // Exit Strategy snapshot — derived from risk, social, derivatives, macro, cycle
  // and altcoin breadth, so it runs LAST once every input above is fresh. This is
  // what populates the Exit Signal card on the overview (previously admin-only).
  steps.push(await run('exit-strategy', 'exit-strategy', 'exit-strategy', () => storeExitStrategyDaily()));

  const ok = steps.filter((s) => s.ok).length;
  return { steps, ok, failed: steps.length - ok };
};

/**
 * Refresh the BTC dashboard + global market snapshot together. They're coupled —
 * global market posture is derived from the BTC signals — so a standalone admin
 * "market" sync runs both in order. Returns 1 when BTC signals were produced.
 */
export const syncBtcAndGlobal = async (): Promise<number> => {
  const dominanceChange = await latestDominanceChange();
  const btcSignals = await syncBtc(dominanceChange);
  await syncGlobal(btcSignals);
  return btcSignals ? 1 : 0;
};

export { syncCoins, syncBtc, syncGlobal, syncEcosystems };
