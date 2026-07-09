import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getChannelVideos } from '../services/youtube.service';

// GET /api/v1/youtube/videos — public; latest uploads for the landing page.
export const listVideos = asyncHandler(async (req, res) => {
  const limit = Math.min(12, Math.max(1, Number(req.query.limit) || 6));
  const items = await getChannelVideos(limit);
  return sendSuccess(res, 'Videos fetched successfully.', { items });
});
