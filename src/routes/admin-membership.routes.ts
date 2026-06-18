import { Router } from 'express';
import {
  adminArchivePlan,
  adminCancelSubscription,
  adminCreatePlan,
  adminExtendSubscription,
  adminGetPlan,
  adminGetSubscription,
  adminGetUser,
  adminListPaymentAttempts,
  adminListPayments,
  adminListPlans,
  adminListSubscriptions,
  adminListUsers,
  adminMarkPaymentReviewed,
  adminUpdateAttemptFollowup,
  adminSetUserPlan,
  adminSetUserStatus,
  adminUpdateFeature,
  adminUpdatePlan,
  adminUpsertFeature
} from '../controllers/admin-membership.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createPlanSchema,
  extendSchema,
  featureSchema,
  followupSchema,
  paymentIdParam,
  planFeatureParams,
  planIdParam,
  setUserPlanSchema,
  setUserStatusSchema,
  subscriptionIdParam,
  updateFeatureSchema,
  updatePlanSchema,
  userIdParam
} from '../schemas/membership.schema';

const router = Router();

// Admin-only membership management. Mounted alongside the existing /admin sync routes.
router.use(authenticate, adminOnly);

// Plans
router.get('/plans', adminListPlans);
router.post('/plans', validate({ body: createPlanSchema }), adminCreatePlan);
router.get('/plans/:id', validate({ params: planIdParam }), adminGetPlan);
router.put('/plans/:id', validate({ params: planIdParam, body: updatePlanSchema }), adminUpdatePlan);
router.delete('/plans/:id', validate({ params: planIdParam }), adminArchivePlan);
router.post('/plans/:id/features', validate({ params: planIdParam, body: featureSchema }), adminUpsertFeature);
router.put('/plans/:id/features/:featureId', validate({ params: planFeatureParams, body: updateFeatureSchema }), adminUpdateFeature);

// Users
router.get('/users', adminListUsers);
router.get('/users/:id', validate({ params: userIdParam }), adminGetUser);
router.put('/users/:id/plan', validate({ params: userIdParam, body: setUserPlanSchema }), adminSetUserPlan);
router.put('/users/:id/status', validate({ params: userIdParam, body: setUserStatusSchema }), adminSetUserStatus);
router.post('/users/:id/extend-subscription', validate({ params: userIdParam, body: extendSchema }), adminExtendSubscription);
router.post('/users/:id/cancel-subscription', validate({ params: userIdParam }), adminCancelSubscription);

// Subscriptions visibility layer (actions reuse the /users/:id/* endpoints above).
router.get('/subscriptions', adminListSubscriptions);
router.get('/subscriptions/:id', validate({ params: subscriptionIdParam }), adminGetSubscription);

// Payment events visibility layer.
router.get('/payments', adminListPayments);
router.put('/payments/:id/reviewed', validate({ params: paymentIdParam }), adminMarkPaymentReviewed);

// Upgrade follow-ups (abandoned / failed / cancelled attempts).
router.get('/payment-attempts', adminListPaymentAttempts);
router.put('/payment-attempts/:id/followup', validate({ params: paymentIdParam, body: followupSchema }), adminUpdateAttemptFollowup);

export default router;
