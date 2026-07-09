import { Router } from 'express';
import { listActiveOffers } from '../controllers/offers.controller';

const router = Router();

// Public — the pricing page fetches currently-live offers alongside /plans.
router.get('/', listActiveOffers);

export default router;
