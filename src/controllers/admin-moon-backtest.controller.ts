import type { Request, Response } from 'express';
import { cacheStatus } from '../services/moon-backtest/data';
import { JobBusy, currentJob, startJob } from '../services/moon-backtest/jobs';
import { COMPARE_SET, DEFAULT_PARAMS, normalizeParams } from '../services/moon-backtest/presets';
import { deleteRun, getRun, listRuns, runsTableReady } from '../services/moon-backtest/store';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';

// Admin-only: the moon backtest (breakouts from long sideways ranges, replayed over
// Binance's daily history, dead coins included). Read-only market data — nothing
// here touches the Binance account.

const who = (req: Request) => req.user?.sub ?? 'unknown';

const start = async (req: Request, runs: Parameters<typeof startJob>[0]) => {
  try {
    const job = await startJob(runs, who(req));
    console.log(`[moon-backtest] ${who(req)} started ${runs.length} run(s): ${runs.map((r) => r.name).join(' | ')}`);
    return job;
  } catch (e) {
    if (e instanceof JobBusy) throw new AppError(e.message, 409);
    throw new AppError(e instanceof Error ? e.message : String(e), 400);
  }
};

// GET /api/v1/admin/moon-backtest — saved runs, the running job, the default rules.
export const adminMoonBacktest = asyncHandler(async (_req: Request, res: Response) => {
  const [tableReady, runs] = await Promise.all([runsTableReady(), listRuns()]);
  return sendSuccess(res, 'Moon backtest fetched.', {
    tableReady,
    runs,
    job: currentJob(),
    cache: cacheStatus(),
    defaults: DEFAULT_PARAMS,
    compareSet: COMPARE_SET.map((c) => c.name)
  });
});

// GET /api/v1/admin/moon-backtest/runs/:id — one run in full (trades, equity curve).
export const adminMoonBacktestRun = asyncHandler(async (req: Request, res: Response) => {
  const row = await getRun(String(req.params.id));
  if (!row) throw new AppError('Backtest not found.', 404);
  return sendSuccess(res, 'Backtest fetched.', row);
});

// POST /api/v1/admin/moon-backtest/run — one backtest with the given rules.
export const adminMoonBacktestStart = asyncHandler(async (req: Request, res: Response) => {
  const params = normalizeParams((req.body?.params ?? {}) as Record<string, unknown>);
  const raw = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  const name = raw || `${params.timeframe === 'daily' ? 'Daily' : 'Weekly'} · ${params.baseBars}-${params.timeframe === 'daily' ? 'day' : 'week'} base · stop ${params.stopLossPct}% · trail ${params.trailPct}%`;
  return sendSuccess(res, 'Backtest started.', await start(req, [{ name, params }]), 202);
});

// POST /api/v1/admin/moon-backtest/compare — the comparison set, one run per variant.
export const adminMoonBacktestCompare = asyncHandler(async (req: Request, res: Response) => {
  const runs = COMPARE_SET.map((c) => ({ name: c.name, params: normalizeParams(c.params as Record<string, unknown>) }));
  return sendSuccess(res, 'Comparison started.', await start(req, runs), 202);
});

// DELETE /api/v1/admin/moon-backtest/runs/:id
export const adminMoonBacktestDelete = asyncHandler(async (req: Request, res: Response) => {
  if (!(await deleteRun(String(req.params.id)))) throw new AppError('Backtest not found.', 404);
  return sendSuccess(res, 'Backtest deleted.', null);
});
