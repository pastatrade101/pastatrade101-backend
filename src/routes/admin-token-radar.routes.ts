import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { adminTokenRadarStatsCtrl } from '../controllers/token-radar.controller';

const router = Router();
router.use(authenticate, adminOnly);

router.get('/token-radar/stats', adminTokenRadarStatsCtrl);

export default router;
