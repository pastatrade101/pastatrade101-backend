import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getOverview } from '../controllers/overview.controller';

const router = Router();

// Daily market command center (all signed-in users; content is tier-gated).
router.use(authenticate);
router.get('/', getOverview);

export default router;
