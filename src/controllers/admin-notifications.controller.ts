import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { isConnectConfigured, listTemplates } from '../services/notifications/connect.client';
import { getRule, resolveAudience } from '../services/notifications/notifier.service';
import { notifyMarketChange, sendAnnouncement } from '../services/notifications/triggers.service';

// Admin WhatsApp notifications: see the rules, see who would receive them, turn
// them on, and send an announcement by hand. Mounted under /api/v1/admin.

export const adminNotificationStatus = asyncHandler(async (_req: Request, res: Response) => {
  const [{ data: rules }, templates, { count: optedIn }] = await Promise.all([
    supabase.from('notification_rules').select('*').order('key'),
    listTemplates(),
    supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .not('whatsapp_opted_in_at', 'is', null)
      .is('whatsapp_opted_out_at', null)
  ]);

  return sendSuccess(res, 'Notification status fetched successfully.', {
    connected: isConnectConfigured(),
    opted_in_members: optedIn ?? 0,
    // Only APPROVED templates can carry a business-initiated message, so the
    // panel shows the status rather than pretending every template is usable.
    templates,
    rules: rules ?? []
  });
});

export const adminUpdateNotificationRule = asyncHandler(async (req: Request, res: Response) => {
  const allowed = ['enabled', 'plan_codes', 'template_name', 'template_language', 'min_hours_between', 'max_per_day', 'label', 'description'];
  const patch: Record<string, unknown> = {};
  for (const key of allowed) if (key in (req.body ?? {})) patch[key] = req.body[key];
  if (Object.keys(patch).length === 0) throw new AppError('Nothing to update.', 400);
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('notification_rules').update(patch).eq('key', req.params.key).select('*').single();
  if (error) throw new AppError('Unable to update the rule.', 500, [error]);
  return sendSuccess(res, 'Rule updated successfully.', data);
});

/** Who would get this rule right now — the number an admin wants before sending. */
export const adminPreviewAudience = asyncHandler(async (req: Request, res: Response) => {
  const rule = await getRule(req.params.key);
  if (!rule) throw new AppError('Rule not found.', 404);
  const audience = await resolveAudience(rule);
  return sendSuccess(res, 'Audience resolved successfully.', {
    count: audience.length,
    plans: rule.plan_codes,
    sample: audience.slice(0, 5).map((a) => ({ email: a.email, plan: a.plan_code }))
  });
});

export const adminSendAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  const templateName = String(req.body?.template_name ?? '').trim();
  if (!templateName) throw new AppError('An approved template name is required.', 400);
  const variables = Array.isArray(req.body?.variables) ? req.body.variables.map((v: unknown) => String(v)) : [];

  const summary = await sendAnnouncement({
    templateName,
    templateLanguage: req.body?.template_language ? String(req.body.template_language) : undefined,
    variables,
    note: req.body?.note ? String(req.body.note) : undefined,
    triggeredBy: req.user!.sub
  });
  return sendSuccess(res, summary.reason ?? 'Announcement dispatched.', summary);
});

/** Fire a market-change alert by hand — same path the scheduler would use. */
export const adminSendMarketAlert = asyncHandler(async (req: Request, res: Response) => {
  const kind = String(req.body?.kind ?? '');
  if (kind !== 'risk.band_changed' && kind !== 'regime.changed') {
    throw new AppError('kind must be risk.band_changed or regime.changed.', 400);
  }
  const label = String(req.body?.label ?? '').trim();
  if (!label) throw new AppError('A label is required (e.g. "Elevated").', 400);

  const summary = await notifyMarketChange(kind, { label, url: req.body?.url ? String(req.body.url) : undefined }, req.user!.sub);
  return sendSuccess(res, summary.reason ?? 'Alert dispatched.', summary);
});

export const adminListNotificationBatches = asyncHandler(async (_req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('notification_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new AppError('Unable to load notification history.', 500, [error]);
  return sendSuccess(res, 'History fetched successfully.', { items: data ?? [] });
});
