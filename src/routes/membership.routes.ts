import { Router } from 'express';
import {
  cancelMyAttempt,
  cancelMySubscription,
  getMyFeatures,
  getMyPendingAttempt,
  getMyPlan,
  getMyUsage,
  requestUpgrade,
  verifyMyPayment
} from '../controllers/membership.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { cancelAttemptSchema, upgradeSchema } from '../schemas/membership.schema';

const router = Router();

// All /me routes require a signed-in user.
router.use(authenticate);

router.get('/plan', getMyPlan);
router.get('/features', getMyFeatures);
router.get('/usage', getMyUsage);
router.post('/upgrade', validate({ body: upgradeSchema }), requestUpgrade);
router.post('/verify-payment', verifyMyPayment);
router.post('/cancel-subscription', cancelMySubscription);
router.get('/payment-attempts/pending', getMyPendingAttempt);
router.post('/payment-attempts/cancel', validate({ body: cancelAttemptSchema }), cancelMyAttempt);

export default router;
