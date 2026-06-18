import { createClient } from '@supabase/supabase-js';
import { env } from './env';

export const isSupabaseConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

if (!isSupabaseConfigured) {
  console.warn('Supabase credentials are not configured. Endpoints that touch the database will fail until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.');
}

export const supabase = createClient(
  env.SUPABASE_URL || 'http://localhost:54321',
  env.SUPABASE_SERVICE_ROLE_KEY || 'development-service-role-key',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);
