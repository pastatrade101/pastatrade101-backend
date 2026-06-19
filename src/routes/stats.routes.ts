import { Router } from 'express';
import { getPublicStats } from '../controllers/stats.controller';

const router = Router();

// Public — no auth (drives the landing page social-proof counts).
router.get('/', getPublicStats);

export default router;
