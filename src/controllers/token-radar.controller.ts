import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { analyzeToken, getReport, listMyReports, scansToday, DISCLAIMER } from '../services/token-radar/tokenRadar.service';
import { CHAINS, chainOf } from '../services/token-radar/chainConfig';
import { resolveUserAccess, limitFor } from '../services/membership/plan-access';

// Token Position Radar — user endpoints. Auth + feature gate applied by the
// router; the daily scan allowance is enforced here per plan (admins unlimited).

// GET /api/v1/token-radar/chains — supported networks + the caller's allowance.
export const getChainsCtrl = asyncHandler(async (req, res) => {
  const access = await resolveUserAccess(req.user!.sub);
  const limit = limitFor(access, 'max_token_scans_daily');
  const used = limit === null ? 0 : await scansToday(req.user!.sub);
  return sendSuccess(res, 'Chains loaded.', {
    chains: Object.values(CHAINS).map((c) => ({ slug: c.slug, name: c.name, native: c.nativeCurrency, type: c.type, status: c.status, popular: !!c.popular })),
    allowance: { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) }
  });
});

// POST /api/v1/token-radar/analyze  { chain, input, fresh? }
export const analyzeCtrl = asyncHandler(async (req, res) => {
  const chain = String(req.body?.chain ?? '').trim().toLowerCase();
  const input = String(req.body?.input ?? '').trim();
  const fresh = req.body?.fresh === true;
  if (!chain) throw new AppError('Please select a network.', 400);
  if (chain !== 'auto' && !chainOf(chain)) throw new AppError('Unsupported network.', 400);
  if (!input) throw new AppError('Please enter a token address or ticker.', 400);

  const userId = req.user!.sub;
  const access = await resolveUserAccess(userId);
  const ensureQuota = async () => {
    const limit = limitFor(access, 'max_token_scans_daily');
    if (limit === null) return; // unlimited (admin / unconfigured plan)
    const used = await scansToday(userId);
    if (used >= limit) {
      throw new AppError(`You have reached your daily token scan limit (${limit}). Upgrade to Premium for more scans.`, 403);
    }
  };

  const outcome = await analyzeToken(chain, input, userId, fresh, ensureQuota);
  if (outcome.status === 'error') return sendSuccess(res, 'Token not found.', { status: 'error', message: outcome.message });
  if (outcome.status === 'matches') {
    return sendSuccess(res, 'Multiple tokens matched — pick the exact one.', { status: 'matches', matches: outcome.matches, disclaimer: DISCLAIMER });
  }
  if (outcome.status === 'chains') {
    return sendSuccess(res, 'This address exists on multiple networks — pick one.', { status: 'chains', options: outcome.options });
  }
  return sendSuccess(res, 'Analysis completed.', { status: 'completed', report: outcome.report });
});

// GET /api/v1/token-radar/reports — my recent analyses.
export const myReportsCtrl = asyncHandler(async (req, res) => {
  const items = await listMyReports(req.user!.sub);
  return sendSuccess(res, 'Reports loaded.', { items });
});

// GET /api/v1/token-radar/reports/:id — owner (or admin) only.
export const getReportCtrl = asyncHandler(async (req, res) => {
  const { data } = await supabase.from('token_analysis_reports').select('*').eq('id', req.params.id).maybeSingle();
  if (!data) throw new AppError('Report not found.', 404);
  const isOwner = data.user_id === req.user!.sub;
  const isAdmin = req.user!.role === 'admin';
  if (!isOwner && !isAdmin) throw new AppError('Report not found.', 404); // don't leak existence
  const report = await getReport(req.params.id);
  return sendSuccess(res, 'Report loaded.', { report });
});

// ── Admin analytics ──────────────────────────────────────────────────────────
// GET /api/v1/admin/token-radar/stats
export const adminTokenRadarStatsCtrl = asyncHandler(async (_req, res) => {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data: recent } = await supabase
    .from('token_analysis_reports')
    .select('id, user_id, chain, token_symbol, token_name, token_address, final_rating, confidence_score, risk_score, created_at, user:users(email)')
    .gte('created_at', weekAgo)
    .order('created_at', { ascending: false })
    .limit(1000);

  const rows = recent ?? [];
  const today = rows.filter((r) => new Date(r.created_at as string) >= dayStart);

  const countBy = (key: (r: (typeof rows)[number]) => string | null) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r);
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count);
  };
  const avg = (vals: (number | null)[]) => {
    const nums = vals.filter((v): v is number => v != null);
    return nums.length ? Math.round(nums.reduce((s, v) => s + v, 0) / nums.length) : null;
  };

  return sendSuccess(res, 'Token radar stats loaded.', {
    scans_today: today.length,
    scans_7d: rows.length,
    by_chain: countBy((r) => r.chain as string),
    top_tokens: countBy((r) => (r.token_symbol ? `${r.token_symbol} (${(r.chain as string) ?? ''})` : null)).slice(0, 10),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    top_users: countBy((r) => ((Array.isArray(r.user) ? (r.user[0] as any) : (r.user as any))?.email ?? null)).slice(0, 10),
    avg_confidence: avg(rows.map((r) => r.confidence_score as number | null)),
    avg_risk: avg(rows.map((r) => r.risk_score as number | null)),
    latest: rows.slice(0, 20)
  });
});
