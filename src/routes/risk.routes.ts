import { Router } from 'express';
import { getDcaZones, getHistory, getMetricHistory, getMetrics, getOnchainHistory, getSummary, getTimeline } from '../controllers/risk.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';

const router = Router();

router.get('/summary', getSummary);
router.get('/metrics', getMetrics);
router.get('/metrics/:key/history', getMetricHistory);
router.get('/history', getHistory);
// On-chain detail history is a Premium feature.
router.get('/onchain-history', authenticate, requireFeature('access_onchain_metrics'), getOnchainHistory);
router.get('/dca-zones', getDcaZones);
router.get('/timeline', getTimeline);

export default router;
