import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getIcoProjectsCtrl, getIcoProjectCtrl, exportIcoCsvCtrl } from '../controllers/ico-intelligence.controller';

const router = Router();

// Early Project Radar — Mid + Premium (Free is locked-preview on the frontend).
router.use(authenticate, requireFeature('access_early_project_radar'));

router.get('/', getIcoProjectsCtrl);
router.get('/export.csv', exportIcoCsvCtrl); // before :id so it isn't captured
router.get('/:id', getIcoProjectCtrl);

export default router;
