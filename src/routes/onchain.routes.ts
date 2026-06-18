import { Router } from 'express';
import { supplyProfitLoss, supplyProfitLossHistory } from '../controllers/onchain.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';

const router = Router();

// Supply in Profit & Loss is a Premium on-chain feature.
router.get('/supply-profit-loss', authenticate, requireFeature('access_onchain_metrics'), supplyProfitLoss);
router.get('/supply-profit-loss/history', authenticate, requireFeature('access_onchain_metrics'), supplyProfitLossHistory);

export default router;
