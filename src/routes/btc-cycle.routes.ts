import { Router } from 'express';
import {
  getRiskScore,
  getRoiFromCycleLow,
  getRoiFromHalving,
  getYearOverlay
} from '../controllers/btc-cycle.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';

const router = Router();

// BTC Cycle Lab is a Premium feature.
router.use(authenticate, requireFeature('access_btc_cycle_lab'));

router.get('/roi-from-cycle-low', getRoiFromCycleLow);
router.get('/roi-from-halving', getRoiFromHalving);
router.get('/year-overlay', getYearOverlay);
router.get('/ytd-roi', getYearOverlay); // same dataset, per the spec's naming
router.get('/risk-score', getRiskScore);
// Still to come: /std-bands, /valuation-models.

export default router;
