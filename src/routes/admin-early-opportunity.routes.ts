import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { adminGetSettings, adminRecalculate, adminSync, adminSyncLogs, adminUpdateSettings } from '../controllers/admin-early-opportunity.controller';

const router = Router();

router.use(authenticate, adminOnly);

router.get('/early-opportunity/settings', adminGetSettings);
router.put('/early-opportunity/settings', adminUpdateSettings);
router.post('/early-opportunity/sync', adminSync);
router.post('/early-opportunity/recalculate', adminRecalculate);
router.get('/early-opportunity/sync-logs', adminSyncLogs);

export default router;
