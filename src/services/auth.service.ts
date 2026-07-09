import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';
import { assignDefaultFreePlan } from './membership/subscription.service';
import type { AuthTokenPayload, UserRole } from '../types';

// Public OAuth client id — safe to bake in; overridable via GOOGLE_CLIENT_ID.
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '744124991412-nd76lcjqqq2935f8sqonr90ho2gq4aqj.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const signToken = (user: { id: string; email: string; role: UserRole; full_name: string | null }) => {
  const payload: AuthTokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.full_name ?? ''
  };

  const token = jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']
  });

  return { token, user: payload, expiresIn: env.JWT_EXPIRES_IN };
};

export const registerUser = async (email: string, password: string, fullName?: string) => {
  const normalizedEmail = email.toLowerCase();

  const { data: existing, error: lookupError } = await supabase
    .from('users')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (lookupError) throw new AppError('Unable to register user.', 500, [lookupError]);
  if (existing) throw new AppError('An account with this email already exists.', 409);

  const passwordHash = await bcrypt.hash(password, 10);

  const { data: user, error } = await supabase
    .from('users')
    .insert({
      email: normalizedEmail,
      password_hash: passwordHash,
      full_name: fullName ?? null,
      role: 'subscriber'
    })
    .select('id,email,role,full_name')
    .single();

  if (error) throw new AppError('Unable to register user.', 500, [error]);

  // New users start on the Free plan. Best-effort — registration must not fail
  // if the membership tables aren't seeded yet.
  try {
    await assignDefaultFreePlan((user as { id: string }).id);
  } catch {
    /* membership not configured — user defaults to free at access-resolution time */
  }

  return signToken(user as never);
};

export const loginUser = async (email: string, password: string) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('id,email,password_hash,full_name,role,is_active')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (error) throw new AppError('Unable to authenticate user.', 500, [error]);
  if (!user || !user.is_active) throw new AppError('Invalid email or password.', 401);
  // Google-only accounts have no password — steer them to the Google button.
  if (!user.password_hash) throw new AppError('This account uses Google sign-in. Please continue with Google.', 401);

  const isValidPassword = await bcrypt.compare(password, user.password_hash);
  if (!isValidPassword) throw new AppError('Invalid email or password.', 401);

  await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

  return signToken(user as never);
};

/**
 * Sign in / sign up with a Google ID token (from the "Sign in with Google"
 * button). Verifies the token with Google, then find-or-creates the user in our
 * own users table and issues our normal JWT — no password involved.
 */
export const googleAuth = async (credential: string) => {
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw new AppError('Google sign-in could not be verified. Please try again.', 401);
  }
  if (!payload?.email || payload.email_verified === false) {
    throw new AppError('Your Google account email is not verified.', 401);
  }

  const email = payload.email.toLowerCase();
  const fullName = payload.name ?? null;
  const avatar = payload.picture ?? null;

  // Existing user → sign them in (link the Google identity, refresh avatar/name).
  const { data: existing } = await supabase
    .from('users')
    .select('id,email,role,full_name,is_active')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    if (!existing.is_active) throw new AppError('This account is disabled.', 403);
    await supabase
      .from('users')
      .update({ last_login_at: new Date().toISOString(), auth_provider: 'google', avatar_url: avatar, full_name: existing.full_name ?? fullName })
      .eq('id', existing.id);
    return signToken(existing as never);
  }

  // New user → create (no password), assign Free plan best-effort.
  const { data: user, error } = await supabase
    .from('users')
    .insert({ email, full_name: fullName, role: 'subscriber', auth_provider: 'google', avatar_url: avatar })
    .select('id,email,role,full_name')
    .single();

  if (error) throw new AppError('Unable to create your account.', 500, [error]);

  try {
    await assignDefaultFreePlan((user as { id: string }).id);
  } catch {
    /* membership not configured — defaults to free at access-resolution time */
  }

  return signToken(user as never);
};
