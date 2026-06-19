import { z } from 'zod';

const billingInterval = z.enum(['monthly', 'yearly', 'lifetime', 'manual']);
const subStatus = z.enum(['active', 'trialing', 'past_due', 'cancelled', 'expired', 'manual', 'suspended']);

export const upgradeSchema = z.object({
  plan_slug: z.string().min(1),
  billing_interval: billingInterval.optional(),
  phone: z.string().max(30).optional()
});

export const createPlanSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers or hyphens'),
  description: z.string().max(400).optional(),
  badge: z.string().max(40).nullable().optional(),
  monthly_price: z.number().min(0).optional(),
  yearly_price: z.number().min(0).optional(),
  currency: z.string().max(8).optional(),
  billing_interval: billingInterval.optional(),
  is_active: z.boolean().optional(),
  is_popular: z.boolean().optional(),
  is_hidden: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  trial_days: z.number().int().min(0).optional()
});

export const updatePlanSchema = createPlanSchema.partial();

export const featureSchema = z.object({
  feature_key: z.string().min(1).max(60),
  is_enabled: z.boolean().optional(),
  limit_value: z.number().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional()
});

export const updateFeatureSchema = z.object({
  is_enabled: z.boolean().optional(),
  limit_value: z.number().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional()
});

export const setUserPlanSchema = z
  .object({
    plan_id: z.string().uuid().optional(),
    plan_slug: z.string().optional(),
    status: subStatus.optional(),
    billing_interval: billingInterval.optional(),
    current_period_start: z.string().optional(),
    current_period_end: z.string().optional(),
    note: z.string().max(500).optional()
  })
  .refine((v) => v.plan_id || v.plan_slug, { message: 'plan_id or plan_slug is required.' });

export const setUserStatusSchema = z.object({ status: subStatus, note: z.string().max(500).optional() });
export const extendSchema = z.object({ days: z.number().int().positive(), note: z.string().max(500).optional() });
export const userNoteSchema = z.object({ note: z.string().min(1).max(1000) });

export const cancelAttemptSchema = z.object({ reason: z.string().max(500).optional() });
export const followupSchema = z
  .object({
    followup_status: z.enum(['open', 'contacted', 'resolved', 'ignored']).optional(),
    followup_note: z.string().max(1000).optional()
  })
  .refine((v) => v.followup_status !== undefined || v.followup_note !== undefined, { message: 'Nothing to update.' });

export const planIdParam = z.object({ id: z.string().uuid() });
export const planFeatureParams = z.object({ id: z.string().uuid(), featureId: z.string().uuid() });
export const userIdParam = z.object({ id: z.string().uuid() });
export const subscriptionIdParam = z.object({ id: z.string().uuid() });
export const paymentIdParam = z.object({ id: z.string().uuid() });
export const slugParam = z.object({ slug: z.string().min(1).max(40) });
