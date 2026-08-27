import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { isConnectConfigured, listTemplates } from '../services/notifications/connect.client';
import { getRule, resolveAudience } from '../services/notifications/notifier.service';
import { suggestVariables } from '../services/notifications/suggestions.service';
import {
  notifyAltcoinBreadth,
  notifyExitThreshold,
  notifyRiskBand,
  sendAnnouncement
} from '../services/notifications/triggers.service';

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

/**
 * What this template would say if it went out right now.
 *
 * An admin hand-typing "0.75" and a ladder action into three boxes is how a
 * message goes out saying something the dashboard does not. Every value these
 * templates need is already computed, so the form offers it and the admin
 * corrects it, rather than the other way round.
 */
export const adminSuggestVariables = asyncHandler(async (req: Request, res: Response) => {
  const template = String(req.query.template ?? '').trim();
  if (!template) throw new AppError('A template name is required.', 400);

  const suggestion = await suggestVariables(template);
  if (!suggestion) {
    // A manual announcement has no live source; an empty form is the honest answer.
    return sendSuccess(res, 'No live data maps to this template.', { live: false, variables: [], labels: [], source: '' });
  }
  return sendSuccess(res, suggestion.live ? 'Filled from live data.' : suggestion.source, suggestion);
});

export const adminSendAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  const templateName = String(req.body?.template_name ?? '').trim();
  if (!templateName) throw new AppError('An approved template name is required.', 400);
  const variables = Array.isArray(req.body?.variables) ? req.body.variables.map((v: unknown) => String(v)) : [];

  // Meta rejects a parameter-count mismatch with error 132000, and by then the
  // send is already recorded. Catch it here, where we can say which template
  // wanted how many.
  const template = (await listTemplates()).find((t) => t.name === templateName);
  if (template && template.variableCount !== variables.length) {
    throw new AppError(
      `${templateName} needs ${template.variableCount} value${template.variableCount === 1 ? '' : 's'}, but ${variables.length} ${variables.length === 1 ? 'was' : 'were'} given. Separate them with |.`,
      400
    );
  }

  const summary = await sendAnnouncement({
    templateName,
    templateLanguage: req.body?.template_language ? String(req.body.template_language) : undefined,
    variables,
    note: req.body?.note ? String(req.body.note) : undefined,
    triggeredBy: req.user!.sub
  });
  return sendSuccess(res, summary.reason ?? 'Announcement dispatched.', summary);
});

/**
 * Fire a market alert by hand — the same path the scheduler uses, including the
 * change detection. Sending the same zone twice from here is refused for the same
 * reason it is refused automatically: it is not news.
 */
export const adminSendMarketAlert = asyncHandler(async (req: Request, res: Response) => {
  const kind = String(req.body?.kind ?? '');
  const by = req.user!.sub;

  if (kind === 'risk.band_changed') {
    const zone = String(req.body?.zone ?? '').trim();
    if (!zone) throw new AppError('A zone is required, e.g. "the Good DCA zone".', 400);
    const summary = await notifyRiskBand(
      { zone, score: req.body?.score ?? '', lastVisit: req.body?.last_visit ?? null },
      by
    );
    return sendSuccess(res, summary.reason ?? 'Alert dispatched.', summary);
  }

  if (kind === 'exit.threshold_crossed') {
    const threshold = req.body?.threshold;
    if (threshold === undefined || threshold === null || threshold === '') {
      throw new AppError('A threshold is required, e.g. 0.75.', 400);
    }
    const summary = await notifyExitThreshold(
      {
        threshold,
        above: req.body?.above !== false,
        ladder: String(req.body?.ladder ?? 'Review your exit ladder')
      },
      by
    );
    return sendSuccess(res, summary.reason ?? 'Alert dispatched.', summary);
  }

  if (kind === 'altcoin.signal') {
    const label = String(req.body?.label ?? '').trim();
    if (!label) throw new AppError('A breadth label is required, e.g. "Broad strength".', 400);
    const summary = await notifyAltcoinBreadth(
      {
        percent: req.body?.percent ?? '',
        previousPercent: req.body?.previous_percent ?? '',
        label
      },
      by
    );
    return sendSuccess(res, summary.reason ?? 'Alert dispatched.', summary);
  }

  throw new AppError('kind must be risk.band_changed, exit.threshold_crossed or altcoin.signal.', 400);
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
