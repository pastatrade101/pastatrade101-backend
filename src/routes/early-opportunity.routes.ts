import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getCandidateCtrl, getCandidatesCtrl, getNarrativesCtrl, getNetworksCtrl, getRadarCtrl, getSourceStatusCtrl } from '../controllers/early-opportunity.controller';

const router = Router();

// Early Opportunity Radar — Mid + Premium (Free is locked-preview on the frontend).
router.use(authenticate, requireFeature('access_early_opportunity_radar'));

router.get('/', getRadarCtrl);
router.get('/candidates', getCandidatesCtrl);
router.get('/candidates/:id', getCandidateCtrl);
router.get('/networks', getNetworksCtrl);
router.get('/narratives', getNarrativesCtrl);
router.get('/source-status', getSourceStatusCtrl);

export default router;
