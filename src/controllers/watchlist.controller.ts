import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import {
  ecoSignal,
  ecoConfidence,
  statusOf,
  whatChanged,
  confirmationNeeded,
  riskWarnings,
  autoWhyWatching,
  autoNote,
  summarize,
  type WlMetrics,
  type ItemState,
  type Confidence
} from '../services/watchlist/intelligence';

const TODAY = () => new Date().toISOString().slice(0, 10);

const ownWatchlistOrThrow = async (watchlistId: string, userId: string) => {
  const { data } = await supabase.from('watchlists').select('id, user_id, name, created_at').eq('id', watchlistId).maybeSingle();
  if (!data) throw new AppError('Watchlist not found.', 404);
  if (data.user_id !== userId) throw new AppError('You do not have access to this watchlist.', 403);
  return data;
};

// Confirm an item belongs to a watchlist the caller owns; returns the item row.
const ownItemOrThrow = async (watchlistId: string, itemId: string, userId: string) => {
  await ownWatchlistOrThrow(watchlistId, userId);
  const { data } = await supabase.from('watchlist_items').select('*').eq('id', itemId).eq('watchlist_id', watchlistId).maybeSingle();
  if (!data) throw new AppError('Watchlist item not found.', 404);
  return data;
};

interface Resolved {
  name: string;
  metrics: WlMetrics | null;
  score: number | null;
  signal: string;
  confidence: Confidence;
  detail: Record<string, unknown> | null;
}

// Resolve an item's live state from its source table.
const resolveTarget = async (item: { item_type: string; ref_id: string | null; display_name: string | null }): Promise<Resolved> => {
  if (item.item_type === 'ecosystem' && item.ref_id) {
    const { data } = await supabase
      .from('ecosystems')
      .select('name, slug, metrics:ecosystem_metrics(tvl, tvl_change_30d, stablecoin_mcap, dex_volume_change_7d, native_token_30d, strength_score)')
      .eq('id', item.ref_id)
      .maybeSingle();
    const raw = data?.metrics;
    const metrics = (Array.isArray(raw) ? raw[0] : raw) as WlMetrics | null;
    return {
      name: data?.name ?? item.display_name ?? 'Unknown',
      metrics: metrics ?? null,
      score: metrics?.strength_score ?? null,
      signal: ecoSignal(metrics ?? null),
      confidence: ecoConfidence(metrics ?? null),
      detail: data ?? null
    };
  }
  if (item.item_type === 'coin' && item.ref_id) {
    const { data } = await supabase
      .from('coins')
      .select('symbol, name, image_url, current_price, price_change_pct_24h, strength_score, signal')
      .eq('id', item.ref_id)
      .maybeSingle();
    return {
      name: data?.name ?? item.display_name ?? 'Unknown',
      metrics: null,
      score: data?.strength_score ?? null,
      signal: data?.signal ?? 'No data',
      confidence: data?.strength_score != null ? 'Medium' : 'Low',
      detail: data ?? null
    };
  }
  if (item.item_type === 'sector' && item.ref_id) {
    const { data } = await supabase.from('sectors').select('name, slug').eq('id', item.ref_id).maybeSingle();
    return { name: data?.name ?? item.display_name ?? 'Unknown', metrics: null, score: null, signal: 'No data', confidence: 'Low', detail: data ?? null };
  }
  return { name: item.display_name ?? 'Unknown', metrics: null, score: null, signal: 'No data', confidence: 'Low', detail: null };
};

// Evaluate a single alert against the item's current state. Returns a fired
// event payload, or null when the condition is not met.
const evalAlert = (
  alert: { metric: string; operator: string; threshold: string },
  ctx: { score: number | null; signal: string; previousSignal: string | null; metrics: WlMetrics | null }
): { value: string; message: string } | null => {
  const cmp = (a: number, op: string, b: number) => (op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : false);
  if (alert.metric === 'signal' && alert.operator === 'changes_to') {
    if (ctx.signal === alert.threshold && ctx.previousSignal !== alert.threshold)
      return { value: ctx.signal, message: `Signal changed to ${alert.threshold}.` };
    return null;
  }
  const value =
    alert.metric === 'score'
      ? ctx.score
      : alert.metric === 'tvl_change_30d'
        ? (ctx.metrics?.tvl_change_30d ?? null)
        : alert.metric === 'dex_volume_change_7d'
          ? (ctx.metrics?.dex_volume_change_7d ?? null)
          : alert.metric === 'native_token_30d'
            ? (ctx.metrics?.native_token_30d ?? null)
            : null;
  if (value == null) return null;
  const threshold = Number(alert.threshold);
  if (!Number.isFinite(threshold)) return null;
  if (cmp(value, alert.operator, threshold))
    return { value: String(value), message: `${alert.metric} ${alert.operator} ${threshold} (now ${value}).` };
  return null;
};

// Refresh one item: recompute current state, persist change tracking, append
// daily history, evaluate alerts. Side-effects are best-effort (won't fail the
// request if the v2 migration hasn't run). Returns the enriched item for the UI.
const refreshItem = async (item: Record<string, any>) => {
  const r = await resolveTarget(item as never);

  // Baseline for legacy items added before the v2 columns existed.
  const scoreWhenAdded = item.score_when_added ?? r.score;
  const signalWhenAdded = item.signal_when_added ?? r.signal;
  const confidenceWhenAdded = (item.confidence_when_added ?? r.confidence) as Confidence;
  const previousSignal = (item.current_signal ?? signalWhenAdded) as string;

  const state: ItemState = {
    name: r.name,
    type: item.item_type,
    metrics: r.metrics,
    scoreWhenAdded,
    signalWhenAdded,
    previousSignal,
    currentScore: r.score,
    currentSignal: r.signal,
    confidence: r.confidence
  };

  const status = statusOf(state);
  const why = item.why_watching ?? autoWhyWatching(r.name, r.signal, r.metrics);

  // Persist tracking (best-effort).
  try {
    await supabase
      .from('watchlist_items')
      .update({
        display_name: r.name,
        score_when_added: scoreWhenAdded,
        signal_when_added: signalWhenAdded,
        confidence_when_added: confidenceWhenAdded,
        why_watching: why,
        previous_signal: previousSignal,
        current_score: r.score,
        current_signal: r.signal,
        status,
        last_refreshed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id);

    await supabase
      .from('watchlist_item_history')
      .upsert(
        { watchlist_item_id: item.id, snapshot_date: TODAY(), score: r.score, signal: r.signal, confidence: r.confidence, status },
        { onConflict: 'watchlist_item_id,snapshot_date' }
      );

    // Alerts (only fire at most once per ~20h per alert).
    const { data: alerts } = await supabase.from('watchlist_alerts').select('*').eq('watchlist_item_id', item.id).eq('is_active', true);
    for (const a of alerts ?? []) {
      const recentlyFired = a.last_triggered_at && Date.now() - Date.parse(a.last_triggered_at) < 20 * 3600 * 1000;
      if (recentlyFired) continue;
      const hit = evalAlert(a, { score: r.score, signal: r.signal, previousSignal, metrics: r.metrics });
      if (!hit) continue;
      await supabase.from('watchlist_alert_events').insert({ alert_id: a.id, watchlist_item_id: item.id, value: hit.value, message: hit.message });
      await supabase.from('watchlist_alerts').update({ last_triggered_at: new Date().toISOString() }).eq('id', a.id);
    }
  } catch {
    /* tracking is best-effort; the enriched payload below still returns */
  }

  return {
    id: item.id,
    item_type: item.item_type,
    ref_id: item.ref_id,
    created_at: item.created_at,
    name: r.name,
    score: r.score,
    score_when_added: scoreWhenAdded,
    score_change: r.score != null && scoreWhenAdded != null ? Number((r.score - scoreWhenAdded).toFixed(1)) : null,
    signal: r.signal,
    signal_when_added: signalWhenAdded,
    previous_signal: previousSignal,
    confidence: r.confidence,
    status,
    why_watching: why,
    user_note: item.user_note ?? null,
    what_changed: whatChanged(state),
    confirmation_needed: confirmationNeeded(r.metrics),
    risk_warnings: riskWarnings(r.metrics),
    auto_note: autoNote(state),
    metrics: r.metrics,
    detail: r.detail,
    last_updated: new Date().toISOString(),
    _state: state,
    _status: status
  };
};

// ── Endpoints ────────────────────────────────────────────────────────────────

// GET /api/v1/watchlists
export const listWatchlists = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('watchlists')
    .select('id, name, created_at, watchlist_items(count)')
    .eq('user_id', req.user!.sub)
    .order('created_at', { ascending: true });
  if (error) throw new AppError('Unable to load watchlists.', 500, [error]);
  return sendSuccess(res, 'Watchlists fetched successfully.', { items: data ?? [] });
});

// POST /api/v1/watchlists
export const createWatchlist = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('watchlists')
    .insert({ user_id: req.user!.sub, name: req.body.name })
    .select('id, name, created_at')
    .single();
  if (error) throw new AppError('Unable to create watchlist.', 500, [error]);
  return sendSuccess(res, 'Watchlist created successfully.', data, 201);
});

// GET /api/v1/watchlists/:id  — enriched items + summary + premium takeaway
export const getWatchlist = asyncHandler(async (req, res) => {
  const watchlist = await ownWatchlistOrThrow(req.params.id, req.user!.sub);
  const { data: items } = await supabase.from('watchlist_items').select('*').eq('watchlist_id', watchlist.id).order('created_at', { ascending: true });

  const enriched = await Promise.all((items ?? []).map(refreshItem));
  const summary = summarize(enriched.map((e) => ({ state: e._state, status: e._status })));

  // Recent unread alert events across the whole list.
  let alert_events: unknown[] = [];
  if (enriched.length) {
    const { data: ev } = await supabase
      .from('watchlist_alert_events')
      .select('id, watchlist_item_id, triggered_at, message, value, is_read')
      .in(
        'watchlist_item_id',
        enriched.map((e) => e.id)
      )
      .order('triggered_at', { ascending: false })
      .limit(20);
    alert_events = ev ?? [];
  }

  // Strip internal fields before sending.
  const cleaned = enriched.map(({ _state, _status, ...rest }) => rest);
  return sendSuccess(res, 'Watchlist fetched successfully.', { ...watchlist, items: cleaned, summary, alert_events });
});

// POST /api/v1/watchlists/:id/items  — snapshots score/signal/confidence at add
export const addItem = asyncHandler(async (req, res) => {
  await ownWatchlistOrThrow(req.params.id, req.user!.sub);
  const { item_type, ref_id, why_watching } = req.body as { item_type: string; ref_id: string | null; why_watching?: string };

  const { data: existing } = await supabase
    .from('watchlist_items')
    .select('id')
    .eq('watchlist_id', req.params.id)
    .eq('item_type', item_type)
    .eq('ref_id', ref_id)
    .maybeSingle();
  if (existing) return sendSuccess(res, 'Item already on watchlist.', { id: existing.id });

  const r = await resolveTarget({ item_type, ref_id, display_name: null });
  let { data, error } = await supabase
    .from('watchlist_items')
    .insert({
      watchlist_id: req.params.id,
      item_type,
      ref_id,
      display_name: r.name,
      score_when_added: r.score,
      signal_when_added: r.signal,
      confidence_when_added: r.confidence,
      current_score: r.score,
      current_signal: r.signal,
      previous_signal: r.signal,
      status: 'No change',
      why_watching: why_watching?.trim() || autoWhyWatching(r.name, r.signal, r.metrics)
    })
    .select('id')
    .single();

  // Fallback for databases where the v2 columns aren't migrated yet.
  if (error) {
    ({ data, error } = await supabase
      .from('watchlist_items')
      .insert({ watchlist_id: req.params.id, item_type, ref_id })
      .select('id')
      .single());
  }
  if (error) throw new AppError('Unable to add item to watchlist.', 500, [error]);
  return sendSuccess(res, 'Item added to watchlist.', data, 201);
});

// PUT /api/v1/watchlists/:id/items/:itemId  — edit why-watching / user note
export const updateItem = asyncHandler(async (req, res) => {
  await ownItemOrThrow(req.params.id, req.params.itemId, req.user!.sub);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof req.body.why_watching === 'string') patch.why_watching = req.body.why_watching.trim();
  if (typeof req.body.user_note === 'string') patch.user_note = req.body.user_note.trim();
  const { error } = await supabase.from('watchlist_items').update(patch).eq('id', req.params.itemId);
  if (error) throw new AppError('Unable to update item.', 500, [error]);
  return sendSuccess(res, 'Item updated.');
});

// DELETE /api/v1/watchlists/:id/items/:itemId
export const removeItem = asyncHandler(async (req, res) => {
  await ownWatchlistOrThrow(req.params.id, req.user!.sub);
  const { error } = await supabase.from('watchlist_items').delete().eq('id', req.params.itemId).eq('watchlist_id', req.params.id);
  if (error) throw new AppError('Unable to remove item.', 500, [error]);
  return sendSuccess(res, 'Item removed from watchlist.');
});

// GET /api/v1/watchlists/:id/items/:itemId/detail  — history + alerts + events
export const getItemDetail = asyncHandler(async (req, res) => {
  const item = await ownItemOrThrow(req.params.id, req.params.itemId, req.user!.sub);
  const enriched = await refreshItem(item);
  const [{ data: history }, { data: alerts }, { data: events }] = await Promise.all([
    supabase.from('watchlist_item_history').select('snapshot_date, score, signal, confidence, status').eq('watchlist_item_id', item.id).order('snapshot_date', { ascending: true }),
    supabase.from('watchlist_alerts').select('*').eq('watchlist_item_id', item.id).order('created_at', { ascending: true }),
    supabase.from('watchlist_alert_events').select('*').eq('watchlist_item_id', item.id).order('triggered_at', { ascending: false }).limit(20)
  ]);
  const { _state, _status, ...rest } = enriched;
  return sendSuccess(res, 'Item detail fetched.', { item: rest, history: history ?? [], alerts: alerts ?? [], events: events ?? [] });
});

// POST /api/v1/watchlists/:id/items/:itemId/alerts
export const createAlert = asyncHandler(async (req, res) => {
  const item = await ownItemOrThrow(req.params.id, req.params.itemId, req.user!.sub);
  const { metric, operator, threshold, label } = req.body;
  const { data, error } = await supabase
    .from('watchlist_alerts')
    .insert({ watchlist_item_id: item.id, metric, operator, threshold: String(threshold), label: label ?? null })
    .select('*')
    .single();
  if (error) throw new AppError('Unable to create alert.', 500, [error]);
  return sendSuccess(res, 'Alert created.', data, 201);
});

// DELETE /api/v1/watchlists/:id/items/:itemId/alerts/:alertId
export const deleteAlert = asyncHandler(async (req, res) => {
  const item = await ownItemOrThrow(req.params.id, req.params.itemId, req.user!.sub);
  const { error } = await supabase.from('watchlist_alerts').delete().eq('id', req.params.alertId).eq('watchlist_item_id', item.id);
  if (error) throw new AppError('Unable to delete alert.', 500, [error]);
  return sendSuccess(res, 'Alert deleted.');
});
