import { Router } from 'express';
import { compareCoins, getMarketOscillator, getRatio, getSignals, listCoins } from '../controllers/altcoin-btc.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature } from '../middleware/feature.middleware';

const router = Router();

// Altcoin vs BTC Lab is a Mid+ feature (basic on Mid; advanced filters on Premium).
router.use(authenticate, requireFeature('access_altcoin_btc_lab'));

router.get('/coins', listCoins);
router.get('/ratio/:coinId', getRatio);
router.get('/compare', compareCoins);
router.get('/market-oscillator', getMarketOscillator);
router.get('/signals', getSignals);

export default router;
