import { Router } from 'express';
import { getCatalog, getChart } from '../controllers/charts.controller';

const router = Router();

router.get('/', getCatalog);
router.get('/:key', getChart);

export default router;
