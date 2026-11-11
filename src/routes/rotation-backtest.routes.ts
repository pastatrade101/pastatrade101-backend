import { Router } from 'express';
import { rotationMeta, rotationRun } from '../controllers/rotation-backtest.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { validate } from '../middleware/validate.middleware';
import { runRotationSchema } from '../schemas/rotation-backtest.schema';

const router = Router();

// Rotation Backtest Lab — Premium (admins bypass plan gating).
router.use(authenticate, requireFeature('access_rotation_backtest'));

router.get('/meta', rotationMeta);
router.post('/run', validate({ body: runRotationSchema }), rotationRun);

export default router;
