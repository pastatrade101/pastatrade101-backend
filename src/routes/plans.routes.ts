import { Router } from 'express';
import { getPlanBySlug, listPlans } from '../controllers/plans.controller';
import { validate } from '../middleware/validate.middleware';
import { slugParam } from '../schemas/membership.schema';

const router = Router();

// Public — used by the pricing page.
router.get('/', listPlans);
router.get('/:slug', validate({ params: slugParam }), getPlanBySlug);

export default router;
