import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getLogRegression, getLogRegressionLatest } from '../controllers/log-regression.controller';

const router = Router();

// Logarithmic Regression Bands — enabled for all plans (ETH + advanced controls
// are tier-gated in the controller / UI; free gets a capped BTC preview).
router.use(authenticate, requireFeature('access_log_regression_charts'));

router.get('/:asset/latest', getLogRegressionLatest);
router.get('/:asset', getLogRegression);

export default router;
