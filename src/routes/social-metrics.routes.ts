import { Router } from 'express';
import { getHistory, getLatest, getRiskScore, getSourceStatus } from '../controllers/social-metrics.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';

const router = Router();

// Social Metrics is a Mid+ feature (basic on Mid, full on Premium).
router.use(authenticate, requireFeature('access_social_metrics'));

router.get('/btc', getLatest);
router.get('/btc/history', getHistory);
router.get('/btc/risk-score', getRiskScore);
router.get('/btc/source-status', getSourceStatus);

export default router;
