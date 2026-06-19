import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getExitStrategy, getExitHistory, getExitLadder, getExitEvents } from '../controllers/exit-strategy.controller';

const router = Router();

// Premium (+ Mid) feature.
router.use(authenticate, requireFeature('access_exit_strategy'));

router.get('/', getExitStrategy);
router.get('/history', getExitHistory);
router.get('/ladder', getExitLadder);
router.get('/events', getExitEvents);

export default router;
