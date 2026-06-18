import { env } from '../config/env';
import { isSupabaseConfigured } from '../config/supabase';
import { runFullSync } from './sync';
import { syncPriceSeries } from './sync/sync-price-series';
import { withJob } from './sync/sync-jobs';
import { syncRisk } from './sync/sync-risk';
import { syncOnchain } from './sync/sync-onchain';
import { syncSocialMetrics } from './sync/sync-social-metrics';

// Lightweight in-process scheduler — no external cron or dependency. Runs the
// syncs on intervals while the server is up. Each job guards against overlapping
// runs so a slow sync can't stack up. Disable with SCHEDULER_ENABLED=false.

type JobKey = 'full' | 'prices' | 'risk' | 'social' | 'onchain';
const inFlight: Record<JobKey, boolean> = { full: false, prices: false, risk: false, social: false, onchain: false };

const guard = async (key: JobKey, label: string, task: () => Promise<unknown>) => {
  if (inFlight[key]) {
    console.log(`[scheduler] ${label} still running — skipping this tick`);
    return;
  }
  inFlight[key] = true;
  try {
    console.log(`[scheduler] ${label} starting…`);
    const result = await task();
    console.log(`[scheduler] ${label} done:`, result);
  } catch (error) {
    console.error(`[scheduler] ${label} failed:`, error instanceof Error ? error.message : error);
  } finally {
    inFlight[key] = false;
  }
};

// Wrap the heavy single-stage syncs in a sync_jobs row so they appear in Admin.
const runPriceSeries = () => withJob('coingecko', 'price-series', undefined, () => syncPriceSeries());
const runRisk = () => withJob('risk', 'risk', undefined, () => syncRisk());
const runSocial = () => withJob('social', 'social-metrics', undefined, () => syncSocialMetrics());
// On-chain fetches BGeometrics (4 req) then recomputes the composite. If it's
// rate-limited it throws → logged as a failed job → retried on the next tick.
const runOnchain = () => withJob('bgeometrics', 'onchain', undefined, () => syncOnchain());

export const startScheduler = (): void => {
  if (!env.SCHEDULER_ENABLED) {
    console.log('[scheduler] disabled (SCHEDULER_ENABLED=false)');
    return;
  }
  if (!isSupabaseConfigured) {
    console.log('[scheduler] not started — Supabase is not configured');
    return;
  }

  const fullMs = env.FULL_SYNC_INTERVAL_MIN * 60_000;
  const priceMs = env.PRICE_SYNC_INTERVAL_HOURS * 3_600_000;
  const riskMs = env.RISK_SYNC_INTERVAL_HOURS * 3_600_000;
  const onchainMs = env.ONCHAIN_SYNC_INTERVAL_HOURS * 3_600_000;

  setInterval(() => void guard('full', 'full sync', () => runFullSync()), fullMs);
  setInterval(() => void guard('prices', 'price-series sync', runPriceSeries), priceMs);
  setInterval(() => void guard('risk', 'risk sync', runRisk), riskMs);
  setInterval(() => void guard('social', 'social-metrics sync', runSocial), riskMs);
  setInterval(() => void guard('onchain', 'on-chain sync', runOnchain), onchainMs);

  console.log(
    `[scheduler] enabled — full every ${env.FULL_SYNC_INTERVAL_MIN}m, ` +
      `price-series every ${env.PRICE_SYNC_INTERVAL_HOURS}h, risk every ${env.RISK_SYNC_INTERVAL_HOURS}h, ` +
      `on-chain every ${env.ONCHAIN_SYNC_INTERVAL_HOURS}h`
  );

  if (env.SCHEDULER_RUN_ON_BOOT) {
    // Staggered so we don't fire everything at once on startup.
    setTimeout(() => void guard('full', 'initial full sync', () => runFullSync()), 8_000);
    setTimeout(() => void guard('prices', 'initial price-series sync', runPriceSeries), 30_000);
    setTimeout(() => void guard('risk', 'initial risk sync', runRisk), 60_000);
    setTimeout(() => void guard('onchain', 'initial on-chain sync', runOnchain), 90_000);
  }
};
