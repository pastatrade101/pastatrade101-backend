import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getMacroMarket, getMacroRegime } from '../controllers/macro-regime.controller';

const router = Router();

// Macro Regime — Mid + Premium (Free is locked-preview on the frontend).
router.use(authenticate, requireFeature('access_macro_regime'));
router.get('/', getMacroRegime);
router.get('/market', getMacroMarket);

export default router;
