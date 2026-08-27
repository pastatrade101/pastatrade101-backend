import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { recordContactEvent } from '../services/notifications/connect.client';

// A member turning WhatsApp alerts on or off for themselves.
//
// This endpoint is the consent record. Meta can ask a business to show when and
// how a person agreed to be messaged, so the timestamp and the source are stored
// rather than a bare boolean — and opting out never deletes the number, it stamps
// a withdrawal, because "did they ever opt out?" is a question we must be able to
// answer later.

/** Digits only, with the country code. Rejects local-format numbers early. */
const normalise = (raw: string): string | null => {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  // A Tanzanian number typed as 07… is the most common mistake; make it +255.
  if (digits.startsWith('0') && digits.length === 10) return `255${digits.slice(1)}`;
  return digits;
};

export const getMyWhatsappPreference = asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('users')
    .select('whatsapp_number, whatsapp_opted_in_at, whatsapp_opted_out_at')
    .eq('id', req.user!.sub)
    .single();
  if (error) throw new AppError('Unable to load your notification settings.', 500, [error]);

  const row = data as { whatsapp_number: string | null; whatsapp_opted_in_at: string | null; whatsapp_opted_out_at: string | null };
  return sendSuccess(res, 'Notification settings fetched successfully.', {
    number: row.whatsapp_number,
    enabled: Boolean(row.whatsapp_opted_in_at && !row.whatsapp_opted_out_at),
    opted_in_at: row.whatsapp_opted_in_at,
    opted_out_at: row.whatsapp_opted_out_at
  });
});

export const updateMyWhatsappPreference = asyncHandler(async (req: Request, res: Response) => {
  const enabled = Boolean(req.body?.enabled);
  const now = new Date().toISOString();

  if (!enabled) {
    const { error } = await supabase.from('users').update({ whatsapp_opted_out_at: now }).eq('id', req.user!.sub);
    if (error) throw new AppError('Unable to update your notification settings.', 500, [error]);
    return sendSuccess(res, 'WhatsApp alerts turned off.', { enabled: false });
  }

  const number = normalise(String(req.body?.number ?? ''));
  if (!number) throw new AppError('Enter your WhatsApp number with the country code, e.g. +255 712 345 678.', 400);

  const { error } = await supabase
    .from('users')
    .update({
      whatsapp_number: number,
      whatsapp_opted_in_at: now,
      whatsapp_opt_in_source: 'settings',
      // Turning it back on clears the withdrawal — the new opt-in is the current truth.
      whatsapp_opted_out_at: null
    })
    .eq('id', req.user!.sub);
  if (error) throw new AppError('Unable to update your notification settings.', 500, [error]);

  // Put the new subscriber in front of a human: a contact and a line in the
  // WhatsApp inbox, and a push to whoever is watching it. Deliberately not
  // awaited — a member turning on alerts must never wait on our own plumbing,
  // and must never see it fail.
  void (async () => {
    const { data: person } = await supabase
      .from('users')
      .select('full_name, email')
      .eq('id', req.user!.sub)
      .single();
    const row = (person ?? {}) as { full_name?: string | null; email?: string | null };
    const [first, ...rest] = String(row.full_name ?? '').trim().split(/\s+/);
    await recordContactEvent({
      phone: number,
      firstName: first || null,
      lastName: rest.join(' ') || null,
      email: row.email ?? null,
      title: 'New WhatsApp subscriber',
      note: `${row.full_name || row.email || 'A member'} turned on WhatsApp report alerts.`,
      // One record per member per opt-in day, however many times they toggle.
      idempotencyKey: `optin:${req.user!.sub}:${new Date().toISOString().slice(0, 10)}`
    });
  })().catch((error: unknown) => {
    console.error('[notifications] opt-in notice failed:', error instanceof Error ? error.message : error);
  });

  return sendSuccess(res, 'WhatsApp alerts turned on.', { enabled: true, number });
});
