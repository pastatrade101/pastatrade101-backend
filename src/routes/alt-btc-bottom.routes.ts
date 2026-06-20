import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';
import { getBreadthCtrl, getCoinCtrl, getCoinsCtrl, getRadarCtrl, getRotationWaveCtrl } from '../controllers/alt-btc-bottom.controller';

const router = Router();

// Alt/BTC Bottom Radar — Mid + Premium (Free is locked-preview on the frontend).
router.use(authenticate, requireFeature('access_alt_btc_bottom_radar'));

router.get('/', getRadarCtrl);
router.get('/coins', getCoinsCtrl);
router.get('/coins/:coinId', getCoinCtrl);
router.get('/breadth', getBreadthCtrl);
router.get('/rotation-wave', getRotationWaveCtrl);

export default router;
