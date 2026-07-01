import { supabase } from '../config/supabase';
import { runFullSync, syncCoins, syncEcosystems, syncBtcAndGlobal } from '../services/sync';
import { storeMacroRegimeDaily } from '../services/macro-regime/macroRegime.service';
import { syncPriceSeries } from '../services/sync/sync-price-series';
import { syncRisk } from '../services/sync/sync-risk';
import { syncOnchain, getOnchainStatus } from '../services/sync/sync-onchain';
import { syncSupplyProfitLoss } from '../services/sync/supply-profit-loss.service';
import { syncSocialMetrics } from '../services/sync/sync-social-metrics';
import { withJob } from '../services/sync/sync-jobs';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';

// GET /api/v1/admin/sync-jobs
export const listSyncJobs = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('sync_jobs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) throw new AppError('Unable to load sync jobs.', 500, [error]);
  return sendSuccess(res, 'Sync jobs fetched successfully.', { items: data ?? [] });
});

// POST /api/v1/admin/sync  — run the entire pipeline
export const triggerFullSync = asyncHandler(async (req, res) => {
  const result = await runFullSync(req.user!.sub);
  return sendSuccess(res, 'Full sync completed.', result);
});

// POST /api/v1/admin/sync/coingecko  — coins only
export const triggerCoingeckoSync = asyncHandler(async (req, res) => {
  const result = await withJob('coingecko', 'coins', req.user!.sub, () => syncCoins(1));
  return sendSuccess(res, 'CoinGecko sync completed.', result);
});

// POST /api/v1/admin/sync/market  — BTC dashboard + global market snapshot (coupled)
export const triggerMarketSync = asyncHandler(async (req, res) => {
  const result = await withJob('coingecko', 'market', req.user!.sub, () => syncBtcAndGlobal());
  return sendSuccess(res, 'BTC + global market sync completed.', result);
});

// POST /api/v1/admin/sync/macro-regime  — traditional-market backdrop (Twelve Data)
export const triggerMacroSync = asyncHandler(async (req, res) => {
  const result = await withJob('twelvedata', 'macro-regime', req.user!.sub, () => storeMacroRegimeDaily());
  return sendSuccess(res, 'Macro regime sync completed.', result);
});

// POST /api/v1/admin/sync/defillama  — ecosystems only
export const triggerDefillamaSync = asyncHandler(async (req, res) => {
  const result = await withJob('defillama', 'ecosystems', req.user!.sub, () => syncEcosystems());
  return sendSuccess(res, 'DefiLlama sync completed.', result);
});

// POST /api/v1/admin/sync/risk  — rebuild the full risk model (heavier; run occasionally)
export const triggerRiskSync = asyncHandler(async (req, res) => {
  const result = await withJob('risk', 'risk', req.user!.sub, () => syncRisk());
  return sendSuccess(res, 'Risk model sync completed.', result);
});

// POST /api/v1/admin/sync/onchain  — refresh BGeometrics on-chain metrics (recomputes the composite)
export const triggerOnchainSync = asyncHandler(async (req, res) => {
  const result = await withJob('bgeometrics', 'onchain', req.user!.sub, () => syncOnchain());
  return sendSuccess(res, 'On-chain metrics sync completed.', result);
});

// POST /api/v1/admin/sync/onchain-supply  — supply profit/loss only (2 API calls,
// does NOT re-fetch the 4 risk metrics — cheap against the 15/day free quota).
export const triggerSupplySync = asyncHandler(async (req, res) => {
  const result = await withJob('bgeometrics', 'onchain-supply', req.user!.sub, () => syncSupplyProfitLoss());
  return sendSuccess(res, 'Supply profit/loss sync completed.', result);
});

// GET /api/v1/admin/onchain/status  — provider + freshness for the admin panel
export const onchainStatus = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'On-chain status fetched.', await getOnchainStatus());
});

// POST /api/v1/admin/sync/social-metrics  — all social sources (Trends + Wikipedia + Fear & Greed + YouTube)
export const triggerSocialSync = asyncHandler(async (req, res) => {
  const result = await withJob('social', 'social-metrics', req.user!.sub, () => syncSocialMetrics());
  return sendSuccess(res, 'Social metrics sync completed.', result);
});

// Per-source admin syncs recompute the full Social Risk Score (sources are
// combined), so they run the same sync with a source-specific job label.
export const triggerGoogleTrendsSync = asyncHandler(async (req, res) => {
  const result = await withJob('social', 'google-trends', req.user!.sub, () => syncSocialMetrics());
  return sendSuccess(res, 'Google Trends sync completed.', result);
});
export const triggerWikipediaSync = asyncHandler(async (req, res) => {
  const result = await withJob('social', 'wikipedia', req.user!.sub, () => syncSocialMetrics());
  return sendSuccess(res, 'Wikipedia sync completed.', result);
});
export const triggerYoutubeSync = asyncHandler(async (req, res) => {
  const result = await withJob('social', 'youtube', req.user!.sub, () => syncSocialMetrics());
  return sendSuccess(res, 'YouTube sync completed.', result);
});

// POST /api/v1/admin/sync/price-series  — prebake BTC + top-100 series for the Labs
// (heavy: ~100 CoinGecko calls; run on a schedule). Lets users read saved data.
export const triggerPriceSeriesSync = asyncHandler(async (req, res) => {
  const result = await withJob('coingecko', 'price-series', req.user!.sub, () => syncPriceSeries());
  return sendSuccess(res, 'Lab price-series sync completed.', result);
});
