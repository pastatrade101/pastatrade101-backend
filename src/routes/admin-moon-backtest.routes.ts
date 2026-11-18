import { Router } from 'express';
import { adminMoonBacktest, adminMoonBacktestCompare, adminMoonBacktestDelete, adminMoonBacktestRun, adminMoonBacktestStart } from '../controllers/admin-moon-backtest.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';

const router = Router();

// Moon backtest — private to admins.
router.use('/moon-backtest', authenticate, adminOnly);

router.get('/moon-backtest', adminMoonBacktest);
router.get('/moon-backtest/runs/:id', adminMoonBacktestRun);
router.post('/moon-backtest/run', adminMoonBacktestStart);
router.post('/moon-backtest/compare', adminMoonBacktestCompare);
router.delete('/moon-backtest/runs/:id', adminMoonBacktestDelete);

export default router;
