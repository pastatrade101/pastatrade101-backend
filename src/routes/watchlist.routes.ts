import { Router } from 'express';
import {
  addItem,
  createAlert,
  createWatchlist,
  deleteAlert,
  getItemDetail,
  getWatchlist,
  listWatchlists,
  removeItem,
  updateItem
} from '../controllers/watchlist.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireFeature, requireLimit } from '../middleware/feature.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  addItemSchema,
  alertParamsSchema,
  createAlertSchema,
  createWatchlistSchema,
  idParamSchema,
  itemParamsSchema,
  updateItemSchema
} from '../schemas/watchlist.schema';

const router = Router();

// All watchlist routes require a signed-in user.
router.use(authenticate);

router.get('/', listWatchlists);
router.post('/', validate({ body: createWatchlistSchema }), createWatchlist);
router.get('/:id', validate({ params: idParamSchema }), getWatchlist);

router.post('/:id/items', validate({ params: idParamSchema, body: addItemSchema }), requireLimit('max_watchlist_items'), addItem);
router.put('/:id/items/:itemId', validate({ params: itemParamsSchema, body: updateItemSchema }), updateItem);
router.delete('/:id/items/:itemId', validate({ params: itemParamsSchema }), removeItem);
router.get('/:id/items/:itemId/detail', validate({ params: itemParamsSchema }), getItemDetail);

router.post('/:id/items/:itemId/alerts', requireFeature('access_alerts'), validate({ params: itemParamsSchema, body: createAlertSchema }), createAlert);
router.delete('/:id/items/:itemId/alerts/:alertId', validate({ params: alertParamsSchema }), deleteAlert);

export default router;
