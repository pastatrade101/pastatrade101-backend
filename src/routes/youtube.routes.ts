import { Router } from 'express';
import { listVideos } from '../controllers/youtube.controller';

const router = Router();

// Public — used by the landing page video section.
router.get('/videos', listVideos);

export default router;
