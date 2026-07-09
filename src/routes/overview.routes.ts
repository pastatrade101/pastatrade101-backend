import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getOverview, getMarketRead } from '../controllers/overview.controller';

const router = Router();

// Daily market command center (all signed-in users; content is tier-gated).
router.use(authenticate);
router.get('/', getOverview);
// Premium AI synthesis of the overview signals (separate call, non-blocking).
router.get('/market-read', getMarketRead);

export default router;
