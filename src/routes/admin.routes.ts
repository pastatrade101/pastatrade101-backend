import { Router } from 'express';
import {
  listSyncJobs,
  triggerCoingeckoSync,
  triggerDefillamaSync,
  triggerFullSync,
  triggerPriceSeriesSync,
  triggerGoogleTrendsSync,
  triggerOnchainSync,
  triggerSupplySync,
  onchainStatus,
  triggerRiskSync,
  triggerSocialSync,
  triggerWikipediaSync,
  triggerYoutubeSync
} from '../controllers/admin.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';

const router = Router();

// Admin-only. Sync runs are long; consider moving to a queue in production.
router.use(authenticate, adminOnly);

router.get('/sync-jobs', listSyncJobs);
router.post('/sync', triggerFullSync);
router.post('/sync/coingecko', triggerCoingeckoSync);
router.post('/sync/defillama', triggerDefillamaSync);
router.post('/sync/risk', triggerRiskSync);
router.post('/sync/onchain', triggerOnchainSync);
router.post('/sync/onchain-supply', triggerSupplySync);
router.get('/onchain/status', onchainStatus);
router.post('/sync/price-series', triggerPriceSeriesSync);
router.post('/sync/social-metrics', triggerSocialSync);
router.post('/sync/google-trends', triggerGoogleTrendsSync);
router.post('/sync/wikipedia', triggerWikipediaSync);
router.post('/sync/youtube', triggerYoutubeSync);

export default router;
