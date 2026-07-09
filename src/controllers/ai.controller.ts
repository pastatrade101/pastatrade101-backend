import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { resolveUserAccess, canAccess, limitFor } from '../services/membership/plan-access';
import { countUsageThisMonth, incrementUsage, hasChargedRead, recordChargedRead } from '../services/membership/usage.service';
import { interpretModule, factsHashFor, type SignalInput } from '../services/ai/interpretation.service';
import { aiEnabled } from '../services/ai/anthropic';

const USAGE_KEY = 'ai_interpretations'; // counter in usage_limits (monthly)
const LIMIT_KEY = 'max_ai_interpretations'; // plan limit
const GATE = 'access_ai_interpretation'; // who may ask

// GET /api/v1/ai/usage — the UI reads this to show "N left" and whether to show
// the ask button or the locked upsell teaser. Never charges.
export const getAiUsage = asyncHandler(async (req, res) => {
  const access = await resolveUserAccess(req.user!.sub);
  const allowed = canAccess(access, GATE);
  const limit = limitFor(access, LIMIT_KEY); // null = unlimited (admin / plan)
  const used = allowed ? await countUsageThisMonth(req.user!.sub, USAGE_KEY) : 0;
  return sendSuccess(res, 'AI usage fetched.', {
    enabled: aiEnabled(),
    allowed,
    used,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - used)
  });
});

// POST /api/v1/ai/interpret — interpret a module's signals.
// Charge model: one credit per UNIQUE read — the first time this user interprets
// a module's exact data (facts_hash) in the month. Re-viewing / refreshing the
// same data is free (and bypasses the quota gate, since it's already owned);
// only a data change costs another credit.
export const interpret = asyncHandler(async (req, res) => {
  const access = await resolveUserAccess(req.user!.sub);
  if (!canAccess(access, GATE)) throw new AppError('AI interpretation is a premium feature.', 403, [{ code: 'not_allowed' }]);
  if (!aiEnabled()) throw new AppError('AI interpretation is temporarily unavailable.', 503, [{ code: 'unavailable' }]);

  const { module, title, signals, lang } = req.body as { module: string; title: string; signals: SignalInput[]; lang: 'en' | 'sw' };

  const limit = limitFor(access, LIMIT_KEY);
  const factsHash = factsHashFor(signals);
  const alreadyPaid = await hasChargedRead(req.user!.sub, module, factsHash);
  const used = await countUsageThisMonth(req.user!.sub, USAGE_KEY);

  // Only a NEW read (unowned data) is subject to the monthly quota.
  if (!alreadyPaid && limit != null && used >= limit) {
    throw new AppError('You have used all your AI interpretations for this month.', 429, [{ code: 'quota_exhausted', used, limit }]);
  }

  const read = await interpretModule({ module, title, signals, lang });
  if (!read) throw new AppError('There is not enough live data to interpret this yet.', 422, [{ code: 'no_read' }]);

  let newUsed = used;
  if (!alreadyPaid) {
    await incrementUsage(req.user!.sub, USAGE_KEY);
    await recordChargedRead(req.user!.sub, module, factsHash);
    newUsed = used + 1;
  }
  return sendSuccess(res, 'Interpretation generated.', {
    read,
    charged: !alreadyPaid,
    used: newUsed,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - newUsed)
  });
});
