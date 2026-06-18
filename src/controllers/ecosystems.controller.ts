import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';

// Ecosystems joined with their latest computed metrics. PostgREST embeds the
// 1:1 ecosystem_metrics row via the FK relationship.
const ECO_SELECT = `
  id, slug, name, defillama_slug, native_coin_gecko_id, description, is_active,
  metrics:ecosystem_metrics (
    tvl, tvl_change_7d, tvl_change_30d, stablecoin_mcap, dex_volume_24h,
    dex_volume_change_7d, fees_24h, revenue_24h, native_token_30d,
    strength_score, signal, updated_at
  )
`;

// PostgREST returns an embedded 1:1 relation as an array; flatten to an object.
const flatten = (row: Record<string, unknown>): Record<string, unknown> => {
  const metrics = row.metrics;
  return { ...row, metrics: Array.isArray(metrics) ? (metrics[0] ?? null) : (metrics ?? null) };
};

const rankByScore = (rows: Record<string, unknown>[]) =>
  rows
    .map(flatten)
    .sort((a, b) => {
      const sa = (a.metrics as { strength_score?: number } | null)?.strength_score ?? -1;
      const sb = (b.metrics as { strength_score?: number } | null)?.strength_score ?? -1;
      return sb - sa;
    })
    .map((row, i) => ({ rank: i + 1, ...row }));

// GET /api/v1/ecosystems  and  GET /api/v1/ecosystems/rankings
export const listEcosystems = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from('ecosystems').select(ECO_SELECT).eq('is_active', true);
  if (error) throw new AppError('Unable to load ecosystems.', 500, [error]);
  return sendSuccess(res, 'Ecosystems fetched successfully.', { items: rankByScore(data ?? []) });
});

// GET /api/v1/ecosystems/:id  (accepts uuid or slug)
export const getEcosystem = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const column = /^[0-9a-f]{8}-/i.test(id) ? 'id' : 'slug';

  const { data, error } = await supabase.from('ecosystems').select(ECO_SELECT).eq(column, id).maybeSingle();
  if (error) throw new AppError('Unable to load ecosystem.', 500, [error]);
  if (!data) throw new AppError('Ecosystem not found.', 404);

  const eco = flatten(data);

  const { data: history } = await supabase
    .from('ecosystem_tvl_history')
    .select('snapshot_date, tvl')
    .eq('ecosystem_id', eco.id as string)
    .order('snapshot_date', { ascending: true });

  return sendSuccess(res, 'Ecosystem fetched successfully.', { ...eco, tvl_history: history ?? [] });
});

// GET /api/v1/ecosystems/:id/metrics
export const getEcosystemMetrics = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const column = /^[0-9a-f]{8}-/i.test(id) ? 'id' : 'slug';

  const { data: eco } = await supabase.from('ecosystems').select('id').eq(column, id).maybeSingle();
  if (!eco) throw new AppError('Ecosystem not found.', 404);

  const { data } = await supabase.from('ecosystem_metrics').select('*').eq('ecosystem_id', eco.id).maybeSingle();
  return sendSuccess(res, 'Ecosystem metrics fetched successfully.', data ?? {});
});
