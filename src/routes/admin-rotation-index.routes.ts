import { Router } from 'express';
import {
  adminBotFund,
  adminBotFundAddInvestor,
  adminBotFundEditInvestor,
  adminBotFundStart,
  adminBotLive,
  adminBotPreview,
  adminBotRun,
  adminRotationBot,
  adminRotationIndex,
  adminStepRotationIndex
} from '../controllers/admin-rotation-index.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';

const router = Router();

// Rotation Index — private to admins while it builds a track record.
router.use(authenticate, adminOnly);

router.get('/rotation-index', adminRotationIndex);
// Before '/:id' so "bot" is not read as an index id.
router.get('/rotation-index/bot', adminRotationBot);
router.get('/rotation-index/bot/:mode/live', adminBotLive);
router.post('/rotation-index/bot/:mode/preview', adminBotPreview);
router.post('/rotation-index/bot/:mode/run', adminBotRun);
router.get('/rotation-index/bot/:mode/fund', adminBotFund);
router.post('/rotation-index/bot/:mode/fund/start', adminBotFundStart);
router.post('/rotation-index/bot/:mode/fund/investors', adminBotFundAddInvestor);
router.patch('/rotation-index/bot/:mode/fund/investors/:id', adminBotFundEditInvestor);
router.get('/rotation-index/:id', adminRotationIndex);
router.post('/rotation-index/update', adminStepRotationIndex);
router.post('/rotation-index/:id/update', adminStepRotationIndex);

export default router;
