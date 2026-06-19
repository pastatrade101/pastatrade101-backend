import express, { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { adminGetLogRegressionSettings, adminImportLogRegressionCsv, adminRecalcLogRegression, adminUpdateLogRegressionSettings } from '../controllers/admin-log-regression.controller';

const router = Router();

router.use(authenticate, adminOnly);

// CSV import accepts raw CSV text (the global JSON parser ignores text/csv); a
// route-level text parser allows the larger payloads a full price history needs.
router.post('/data-import/log-regression', express.text({ type: ['text/csv', 'text/plain'], limit: '25mb' }), adminImportLogRegressionCsv);

router.get('/charts/log-regression/settings', adminGetLogRegressionSettings);
router.put('/charts/log-regression/settings/:asset', adminUpdateLogRegressionSettings);
router.post('/charts/log-regression/:asset/recalculate', adminRecalcLogRegression);

export default router;
