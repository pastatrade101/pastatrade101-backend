import { Router } from 'express';
import { getCatalog, getChart, getAltcoinSeasonIndex, getAltcoinSeasonHistory } from '../controllers/charts.controller';

const router = Router();

router.get('/', getCatalog);
// Specific routes before the catch-all /:key.
router.get('/altcoin-season-index/history', getAltcoinSeasonHistory);
router.get('/altcoin-season-index', getAltcoinSeasonIndex);
router.get('/:key', getChart);

export default router;
