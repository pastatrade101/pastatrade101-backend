import { Router } from 'express';
import { getCoins, getCondition, getGlobal, getOverview } from '../controllers/market.controller';

const router = Router();

// Public market data (guests can view a limited overview per the SRS).
router.get('/overview', getOverview);
router.get('/global', getGlobal);
router.get('/coins', getCoins);
router.get('/condition', getCondition);

export default router;
