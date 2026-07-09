import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { getAiUsage, interpret } from '../controllers/ai.controller';
import { interpretSchema } from '../schemas/ai.schema';

const router = Router();

// Metered premium AI interpretation, shared across every module.
router.use(authenticate);
router.get('/usage', getAiUsage);
router.post('/interpret', validate({ body: interpretSchema }), interpret);

export default router;
