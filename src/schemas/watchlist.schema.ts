import { z } from 'zod';

export const createWatchlistSchema = z.object({
  name: z.string().min(1).max(80).default('My Watchlist')
});

export const addItemSchema = z.object({
  item_type: z.enum(['coin', 'ecosystem', 'sector', 'pair', 'btc_risk', 'altcoin_regime']),
  ref_id: z.string().uuid().nullable().optional(),
  why_watching: z.string().max(400).optional()
});

export const updateItemSchema = z
  .object({
    why_watching: z.string().max(400).optional(),
    user_note: z.string().max(1000).optional()
  })
  .refine((v) => v.why_watching !== undefined || v.user_note !== undefined, { message: 'Nothing to update.' });

export const createAlertSchema = z.object({
  metric: z.enum(['score', 'signal', 'tvl_change_30d', 'dex_volume_change_7d', 'native_token_30d']),
  operator: z.enum(['>', '>=', '<', '<=', 'changes_to']),
  threshold: z.union([z.string(), z.number()]).transform((v) => String(v)),
  label: z.string().max(120).optional()
});

export const idParamSchema = z.object({
  id: z.string().uuid()
});

export const itemParamsSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid()
});

export const alertParamsSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  alertId: z.string().uuid()
});
