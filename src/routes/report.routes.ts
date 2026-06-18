import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  listReports,
  getReportBySlug,
  getLatest,
  getLatestDaily,
  getLatestWeekly,
  getLatestMonthly,
  shareWhatsapp,
  shareTelegram,
  sharePublicPreview
} from '../controllers/report.controller';

const router = Router();

// All report views require a logged-in user; the plan decides full vs preview.
router.use(authenticate);

router.get('/', listReports);
router.get('/latest', getLatest);
router.get('/daily/latest', getLatestDaily);
router.get('/weekly/latest', getLatestWeekly);
router.get('/monthly/latest', getLatestMonthly);
router.get('/:id/share/whatsapp', shareWhatsapp);
router.get('/:id/share/telegram', shareTelegram);
router.get('/:id/share/public-preview', sharePublicPreview);
router.get('/:slug', getReportBySlug);

export default router;
