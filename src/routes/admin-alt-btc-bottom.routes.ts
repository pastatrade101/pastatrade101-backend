import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { adminSyncAltBtcBottom } from '../controllers/admin-alt-btc-bottom.controller';

const router = Router();

router.use(authenticate, adminOnly);
router.post('/alt-btc-bottom/sync', adminSyncAltBtcBottom);

export default router;
