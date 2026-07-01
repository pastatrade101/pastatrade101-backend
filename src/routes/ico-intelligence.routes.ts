import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getIcoProjectsCtrl, getIcoProjectCtrl, exportIcoCsvCtrl } from '../controllers/ico-intelligence.controller';

const router = Router();

// Early Project Radar. The list is open to any logged-in user but returns only a
// 1-card PREVIEW unless the plan enables access_early_project_radar (soft-gate in
// the controller). Export + detail stay fully gated.
router.use(authenticate);

router.get('/', getIcoProjectsCtrl);
router.get('/export.csv', requireFeature('access_early_project_radar'), exportIcoCsvCtrl); // before :id
router.get('/:id', requireFeature('access_early_project_radar'), getIcoProjectCtrl);

export default router;
