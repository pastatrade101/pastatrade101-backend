import { Router } from 'express';
import {
  adminAddUserNote,
  adminArchivePlan,
  adminCancelSubscription,
  adminCreatePlan,
  adminExtendSubscription,
  adminGetPlan,
  adminGetSubscription,
  adminGetUser,
  adminListPaymentAttempts,
  adminListPayments,
  adminRevenue,
  adminListPlans,
  adminListSubscriptions,
  adminListUsers,
  adminMarkPaymentReviewed,
  adminUpdateAttemptFollowup,
  adminSetUserPlan,
  adminSetUserStatus,
  adminUpdateFeature,
  adminUpdatePlan,
  adminUpsertFeature,
  adminUserMetrics
} from '../controllers/admin-membership.controller';
import { adminListOffers, adminCreateOffer, adminUpdateOffer, adminDeleteOffer } from '../controllers/offers.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createOfferSchema,
  createPlanSchema,
  extendSchema,
  featureSchema,
  followupSchema,
  offerIdParam,
  paymentIdParam,
  planFeatureParams,
  planIdParam,
  setUserPlanSchema,
  setUserStatusSchema,
  subscriptionIdParam,
  updateFeatureSchema,
  updateOfferSchema,
  updatePlanSchema,
  userIdParam,
  userNoteSchema
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

// Pricing offers (temporary discounts) — never mutate the real plan price.
router.get('/offers', adminListOffers);
router.post('/offers', validate({ body: createOfferSchema }), adminCreateOffer);
router.patch('/offers/:id', validate({ params: offerIdParam, body: updateOfferSchema }), adminUpdateOffer);
router.delete('/offers/:id', validate({ params: offerIdParam }), adminDeleteOffer);

// Users — /users/metrics must precede /users/:id so it isn't captured as an id.
router.get('/users', adminListUsers);
router.get('/users/metrics', adminUserMetrics);
router.get('/users/:id', validate({ params: userIdParam }), adminGetUser);
router.put('/users/:id/plan', validate({ params: userIdParam, body: setUserPlanSchema }), adminSetUserPlan);
router.put('/users/:id/status', validate({ params: userIdParam, body: setUserStatusSchema }), adminSetUserStatus);
router.post('/users/:id/extend-subscription', validate({ params: userIdParam, body: extendSchema }), adminExtendSubscription);
router.post('/users/:id/cancel-subscription', validate({ params: userIdParam }), adminCancelSubscription);
router.post('/users/:id/note', validate({ params: userIdParam, body: userNoteSchema }), adminAddUserNote);

// Subscriptions visibility layer (actions reuse the /users/:id/* endpoints above).
router.get('/subscriptions', adminListSubscriptions);
router.get('/subscriptions/:id', validate({ params: subscriptionIdParam }), adminGetSubscription);

// Payment events visibility layer.
router.get('/revenue', adminRevenue);
router.get('/payments', adminListPayments);
router.put('/payments/:id/reviewed', validate({ params: paymentIdParam }), adminMarkPaymentReviewed);

// Upgrade follow-ups (abandoned / failed / cancelled attempts).
router.get('/payment-attempts', adminListPaymentAttempts);
router.put('/payment-attempts/:id/followup', validate({ params: paymentIdParam, body: followupSchema }), adminUpdateAttemptFollowup);

export default router;
