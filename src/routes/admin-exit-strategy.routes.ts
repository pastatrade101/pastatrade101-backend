import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { getExitSettings, updateExitSettings, triggerExitSync, recalcExit } from '../controllers/admin-exit-strategy.controller';

const router = Router();
router.use(authenticate, adminOnly);

router.get('/exit-strategy/settings', getExitSettings);
router.put('/exit-strategy/settings', updateExitSettings);
router.post('/exit-strategy/sync', triggerExitSync);
router.post('/exit-strategy/recalculate', recalcExit);

export default router;
