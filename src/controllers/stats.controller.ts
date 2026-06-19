import { supabase } from '../config/supabase';
import { cached } from '../utils/cache';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

// GET /api/v1/stats — public, lightweight landing-page stats (real counts).
// Cached 60s so the landing page never hammers the DB.
export const getPublicStats = asyncHandler(async (_req, res) => {
  const stats = await cached(
    'public:stats',
    async () => {
      const [{ count: users }, { count: coins }] = await Promise.all([
        supabase.from('users').select('id', { count: 'exact', head: true }),
        supabase.from('coins').select('id', { count: 'exact', head: true }).eq('is_tracked', true)
      ]);
      return { users: users ?? 0, coins: coins ?? 0 };
    },
    60
  );
  return sendSuccess(res, 'Public stats fetched successfully.', stats);
});
