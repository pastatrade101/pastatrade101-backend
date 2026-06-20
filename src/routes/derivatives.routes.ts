import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getDerivatives } from '../controllers/derivatives.controller';

const router = Router();

// Derivatives / Leverage Risk — Mid + Premium.
router.use(authenticate, requireFeature('access_derivatives'));
router.get('/', getDerivatives);

export default router;
