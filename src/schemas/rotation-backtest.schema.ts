import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const runRotationSchema = z
  .object({
    universe: z.enum(['top10', 'top20', 'top30', 'top50', 'all', 'custom']).default('top20'),
    coins: z.array(z.string().min(1).max(120)).max(40).optional(),
    signal: z.enum(['momentum', 'risk_adjusted']).default('momentum'),
    filter: z.enum(['none', 'positive', 'beat_btc']).default('none'),
    lookback_days: z.coerce.number().int().min(7).max(120).default(30),
    top_n: z.coerce.number().int().min(1).max(10).default(3),
    worst_rank_held: z.coerce.number().int().min(1).max(30).default(5),
    rebalance_days: z.coerce.number().int().refine((v) => [1, 7, 14, 30].includes(v), 'Rebalance every 1, 7, 14 or 30 days.').default(7),
    fee_pct: z.coerce.number().min(0).max(2).default(0.1),
    initial_cash: z.coerce.number().min(100).max(100_000_000).default(10000),
    start_date: isoDate.optional(),
    end_date: isoDate.optional()
  })
  .refine((v) => v.worst_rank_held >= v.top_n, { message: 'Keep-while-in-top must be at least the number of slots.', path: ['worst_rank_held'] })
  .refine((v) => v.universe !== 'custom' || (v.coins?.length ?? 0) >= v.top_n, {
    message: 'Pick at least as many coins as slots for a custom universe.',
    path: ['coins']
  })
  .refine((v) => !v.start_date || !v.end_date || v.start_date < v.end_date, { message: 'Start date must be before end date.', path: ['start_date'] });

export type RunRotationBody = z.infer<typeof runRotationSchema>;
