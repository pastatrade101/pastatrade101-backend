import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import {
  adminListReports,
  adminGenerateReport,
  adminGetReport,
  adminUpdateReport,
  adminPublishReport,
  adminArchiveReport,
  adminExportReport,
  adminListTemplates,
  adminCreateTemplate,
  adminUpdateTemplate,
  adminDeleteTemplate
} from '../controllers/admin-report.controller';

const router = Router();
router.use(authenticate, adminOnly);

router.get('/reports', adminListReports);
router.post('/reports/generate', adminGenerateReport);
router.get('/reports/:id', adminGetReport);
router.put('/reports/:id', adminUpdateReport);
router.post('/reports/:id/publish', adminPublishReport);
router.post('/reports/:id/archive', adminArchiveReport);
router.post('/reports/:id/export', adminExportReport);

router.get('/report-templates', adminListTemplates);
router.post('/report-templates', adminCreateTemplate);
router.put('/report-templates/:id', adminUpdateTemplate);
router.delete('/report-templates/:id', adminDeleteTemplate);

export default router;
