import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/role.middleware';
import { adminListIcoCtrl, adminGetIcoCtrl, adminReviewIcoCtrl, adminSyncIcoCtrl, adminExportIcoCsvCtrl, adminAddWatchCtrl, adminRemoveWatchCtrl } from '../controllers/admin-ico.controller';

const router = Router();
router.use(authenticate, adminOnly);

router.get('/ico-projects', adminListIcoCtrl);
router.get('/ico-projects/export.csv', adminExportIcoCsvCtrl); // before :id
router.post('/ico-projects/sync', adminSyncIcoCtrl);
router.post('/ico-projects/watch', adminAddWatchCtrl);
router.delete('/ico-projects/watch/:id', adminRemoveWatchCtrl);
router.get('/ico-projects/:id', adminGetIcoCtrl);
router.patch('/ico-projects/:id/review', adminReviewIcoCtrl);

export default router;
