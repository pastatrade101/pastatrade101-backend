import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getActiveOffers, listOffersAdmin } from '../services/membership/offers.service';

// Fields the public pricing page needs — never leak internal columns.
const PUBLIC_FIELDS = ['plan_id', 'billing_interval', 'offer_price', 'original_price', 'offer_label', 'starts_at', 'ends_at'] as const;

// GET /api/v1/offers — currently-live offers only (deduped per plan+interval).
export const listActiveOffers = asyncHandler(async (_req, res) => {
  const rows = await getActiveOffers();
  const items = rows.map((o) => Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, o[k]])));
  return sendSuccess(res, 'Active offers fetched successfully.', { items });
});

// ── Admin ──────────────────────────────────────────────────────────────────

// GET /api/v1/admin/offers — every offer with computed status + plan name.
export const adminListOffers = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Offers fetched successfully.', { items: await listOffersAdmin() });
});

// Reject an end-before-start window (DB also enforces it; a 422 is clearer).
const assertWindow = (starts_at?: string, ends_at?: string) => {
  if (starts_at && ends_at && new Date(ends_at).getTime() <= new Date(starts_at).getTime()) {
    throw new AppError('Offer end time must be after the start time.', 422);
  }
};

// POST /api/v1/admin/offers
export const adminCreateOffer = asyncHandler(async (req, res) => {
  // Guard against a dangling plan_id (FK would also catch it, but a clean 404 is nicer).
  const { data: plan } = await supabase.from('plans').select('id').eq('id', req.body.plan_id).maybeSingle();
  if (!plan) throw new AppError('Plan not found.', 404);
  assertWindow(req.body.starts_at, req.body.ends_at);
  if (Number(req.body.offer_price) > Number(req.body.original_price)) {
    throw new AppError('Offer price cannot be higher than the original price.', 422);
  }
  const { data, error } = await supabase.from('pricing_offers').insert(req.body).select('*').single();
  if (error) throw new AppError('Unable to create offer.', 500, [error]);
  return sendSuccess(res, 'Offer created successfully.', data, 201);
});

// PATCH /api/v1/admin/offers/:id
export const adminUpdateOffer = asyncHandler(async (req, res) => {
  assertWindow(req.body.starts_at, req.body.ends_at);
  const { data, error } = await supabase
    .from('pricing_offers')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('*')
    .maybeSingle();
  if (error) throw new AppError('Unable to update offer.', 500, [error]);
  if (!data) throw new AppError('Offer not found.', 404);
  return sendSuccess(res, 'Offer updated successfully.', data);
});

// DELETE /api/v1/admin/offers/:id — hard delete is fine; offers are not referenced
// by any historical record (payments store the amount charged, not the offer id).
export const adminDeleteOffer = asyncHandler(async (req, res) => {
  const { error } = await supabase.from('pricing_offers').delete().eq('id', req.params.id);
  if (error) throw new AppError('Unable to delete offer.', 500, [error]);
  return sendSuccess(res, 'Offer deleted successfully.');
});
