import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { adminDerivativesDiagnostics, adminSyncDerivatives } from '../controllers/admin-derivatives.controller';

const router = Router();

router.use(authenticate, adminOnly);

router.get('/derivatives/diagnostics', adminDerivativesDiagnostics);
router.post('/derivatives/sync', adminSyncDerivatives);

export default router;
