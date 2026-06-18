import { Router } from 'express';
import { getDashboard, getDcaScore, getDrawdown, getVolatility } from '../controllers/btc.controller';

const router = Router();

router.get('/dashboard', getDashboard);
router.get('/dca-score', getDcaScore);
router.get('/drawdown', getDrawdown);
router.get('/volatility', getVolatility);

export default router;
