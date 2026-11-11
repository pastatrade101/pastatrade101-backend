import { Router } from 'express';
import { adminRotationIndex, adminStepRotationIndex } from '../controllers/admin-rotation-index.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';

const router = Router();

// Rotation Index — private to admins while it builds a track record.
router.use(authenticate, adminOnly);

router.get('/rotation-index', adminRotationIndex);
router.get('/rotation-index/:id', adminRotationIndex);
router.post('/rotation-index/update', adminStepRotationIndex);
router.post('/rotation-index/:id/update', adminStepRotationIndex);

export default router;
