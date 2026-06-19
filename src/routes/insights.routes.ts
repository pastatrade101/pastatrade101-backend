import { Router } from 'express';
import { listInsights, getInsight } from '../controllers/insights.controller';

const router = Router();

// Public — no auth (SEO content surface for published reports).
router.get('/', listInsights);
router.get('/:slug', getInsight);

export default router;
