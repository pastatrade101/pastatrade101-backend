import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getDerivatives, getDerivativesHistoryCtrl } from '../controllers/derivatives.controller';

const router = Router();

// Derivatives / Leverage Risk — Mid + Premium.
router.use(authenticate, requireFeature('access_derivatives'));
router.get('/', getDerivatives);
router.get('/history', getDerivativesHistoryCtrl);

export default router;
