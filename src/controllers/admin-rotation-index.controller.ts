import type { Request, Response } from 'express';
import { BotStop } from '../services/rotation-bot/errors';
import { BOT_FOLLOWS, readLiveWallet } from '../services/rotation-bot/live';
import { runBot } from '../services/rotation-bot/runner';
import { readBotSnapshots } from '../services/rotation-bot/snapshot';
import type { BotMode } from '../services/rotation-bot/store';
import { getRotationIndexView, isIndexId, stepRotationIndex, type IndexId } from '../services/rotation-index/rotationIndex.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';

const indexId = (req: Request): IndexId => {
  const id = (req.params.id as string | undefined) ?? 'rotation-balanced';
  if (!isIndexId(id)) throw new AppError(`Unknown index: ${id}`, 404);
  return id;
};

// GET /api/v1/admin/rotation-index/:id? — the tracked index, its holdings and reviews.
export const adminRotationIndex = asyncHandler(async (req: Request, res: Response) => {
  return sendSuccess(res, 'Rotation index fetched.', await getRotationIndexView(indexId(req)));
});

// POST /api/v1/admin/rotation-index/:id?/update — add any final days not saved yet.
export const adminStepRotationIndex = asyncHandler(async (req: Request, res: Response) => {
  const r = await stepRotationIndex(indexId(req));
  return sendSuccess(res, r.added ? `Added ${r.added} day(s).` : 'Already up to date.', r);
});

// GET /api/v1/admin/rotation-index/bot — the newest snapshot the rotation bot saved
// for each mode (live, testnet): its sleeve, the Spot wallet and recent trades.
export const adminRotationBot = asyncHandler(async (_req: Request, res: Response) => {
  return sendSuccess(res, 'Rotation bot snapshot fetched.', await readBotSnapshots());
});

const botMode = (req: Request): BotMode => {
  const m = req.params.mode;
  if (m !== 'live' && m !== 'testnet') throw new AppError(`Unknown bot mode: ${m}`, 404);
  return m;
};

/** First-run budget from the request body (USDT), if any. */
const budgetOf = (req: Request): number | undefined => {
  const b = (req.body as { budget?: unknown } | undefined)?.budget;
  if (b == null || b === '') return undefined;
  const n = Number(b);
  if (!(n > 0 && n <= 10_000_000)) throw new AppError('The budget must be a positive USDT amount.', 400);
  return n;
};

// GET /api/v1/admin/rotation-index/bot/:mode/live — the Binance account right now
// (balances and prices read with this server's key; read-only) and whether this
// server may trade. The page polls it.
export const adminBotLive = asyncHandler(async (req: Request, res: Response) => {
  const fresh = req.query.fresh === '1';
  return sendSuccess(res, 'Live wallet fetched.', await readLiveWallet(botMode(req), { fresh }));
});

/** Run the bot for the admin page and hand back its log, also when it stops on purpose. */
const runForAdmin = async (req: Request, res: Response, kind: 'preview' | 'run') => {
  const mode = botMode(req);
  const budget = budgetOf(req);
  const body = (req.body ?? {}) as { confirm?: unknown; expect?: { sell?: unknown; buy?: unknown } };
  const confirmed = body.confirm === true;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []);
  const expect = kind === 'run' && body.expect ? { sell: list(body.expect.sell), buy: list(body.expect.buy) } : undefined;
  if (kind === 'run' && !expect) throw new AppError('Preview the run and confirm its orders first.', 400);
  if (kind === 'run' && !confirmed) throw new AppError('Confirm the run first.', 400);
  const log: string[] = [];
  const who = req.user?.sub ?? 'unknown';
  if (kind === 'run') console.log(`[rotation-bot] ${mode} run started from the admin page by user ${who}`);
  try {
    const outcome = await runBot(
      { mode, follow: BOT_FOLLOWS, budget, dryRun: kind === 'preview', yes: kind === 'run' && confirmed, caller: 'admin', expect },
      (line) => {
        log.push(line);
        if (kind === 'run') console.log(`[rotation-bot ${mode}] ${line}`);
      }
    );
    if (kind === 'run') console.log(`[rotation-bot] ${mode} run finished: ${outcome.summary}`);
    const wallet = kind === 'run' ? await readLiveWallet(mode, { fresh: true }).catch(() => null) : null;
    return sendSuccess(res, outcome.summary, { ok: true, outcome, log, wallet });
  } catch (e) {
    const message = e instanceof BotStop ? e.message : `The run failed: ${e instanceof Error ? e.message : String(e)}`;
    if (kind === 'run') console.error(`[rotation-bot] ${mode} run stopped: ${message}`);
    if (!(e instanceof BotStop)) console.error(e);
    const wallet = kind === 'run' ? await readLiveWallet(mode, { fresh: true }).catch(() => null) : null;
    return sendSuccess(res, message, { ok: false, message, log, wallet });
  }
};

// POST /api/v1/admin/rotation-index/bot/:mode/preview { budget? } — what a run would
// do now (a dry run: nothing is sent to Binance and nothing is saved).
export const adminBotPreview = asyncHandler(async (req: Request, res: Response) => runForAdmin(req, res, 'preview'));

// POST /api/v1/admin/rotation-index/bot/:mode/run { confirm: true, expect: { sell, buy }, budget? }
// — copy the Rotation Index now with this server's key. `expect` is the preview the
// owner confirmed; if the orders differ now, the run stops before placing any. Live needs BOT_LIVE_ENABLED=true and
// BOT_MAX_BUDGET_USDT on the server and a key that cannot withdraw.
export const adminBotRun = asyncHandler(async (req: Request, res: Response) => runForAdmin(req, res, 'run'));
