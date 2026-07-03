import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getChainsCtrl, analyzeCtrl, myReportsCtrl, getReportCtrl } from '../controllers/token-radar.controller';

const router = Router();

// Token Position Radar — every plan has the feature; volume is capped by the
// max_token_scans_daily limit (enforced in the controller).
router.use(authenticate, requireFeature('access_token_radar'));

router.get('/chains', getChainsCtrl);
router.post('/analyze', analyzeCtrl);
router.get('/reports', myReportsCtrl);
router.get('/reports/:id', getReportCtrl);

export default router;
