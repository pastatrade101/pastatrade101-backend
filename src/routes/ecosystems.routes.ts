import { Router } from 'express';
import { getEcosystem, getEcosystemMetrics, listEcosystems } from '../controllers/ecosystems.controller';

const router = Router();

router.get('/', listEcosystems);
router.get('/rankings', listEcosystems); // same payload, already ranked by score
router.get('/:id', getEcosystem);
router.get('/:id/metrics', getEcosystemMetrics);

export default router;
