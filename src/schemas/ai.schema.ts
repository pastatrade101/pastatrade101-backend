import { z } from 'zod';

export const interpretSchema = z.object({
  module: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  lang: z.enum(['en', 'sw']).default('en'),
  signals: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        label: z.string().max(160).nullable().optional(),
        value: z.union([z.string().max(80), z.number()]).nullable().optional(),
        meaning: z.string().max(400).nullable().optional(),
        tone: z.string().max(20).nullable().optional()
      })
    )
    .min(1)
    .max(12)
});
