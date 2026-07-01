import { Router, raw } from 'express';
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
  adminUploadReportCover,
  adminListTemplates,
  adminCreateTemplate,
  adminUpdateTemplate,
  adminDeleteTemplate
} from '../controllers/admin-report.controller';

const router = Router();
router.use(authenticate, adminOnly);

router.get('/reports', adminListReports);
router.post('/reports/generate', adminGenerateReport);
// Cover image upload — raw image bytes (route-level parser overrides the global JSON body).
router.post('/reports/cover-upload', raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: '6mb' }), adminUploadReportCover);
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
