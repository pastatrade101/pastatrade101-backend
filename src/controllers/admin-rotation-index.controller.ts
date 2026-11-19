import type { Request, Response } from 'express';
import { BotStop } from '../services/rotation-bot/errors';
import { addBooksInvestor, editBooksInvestor, linkBooksAccount, readFundView, startBooks } from '../services/rotation-bot/fund-books';
import { BOT_FOLLOWS, readLiveWallet } from '../services/rotation-bot/live';
import { runBot } from '../services/rotation-bot/runner';
import { readBotSnapshots } from '../services/rotation-bot/snapshot';
import type { BotMode } from '../services/rotation-bot/store';
import { getRotationIndexView, isIndexId, stepRotationIndex, type IndexId } from '../services/rotation-index/rotationIndex.service';
import { replayPeriods, replayRotationIndex } from '../services/rotation-index/replay';
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

// GET /api/v1/admin/rotation-index/replay/periods — the replay's limits and ready-made periods.
export const adminReplayPeriods = asyncHandler(async (req: Request, res: Response) => {
  return sendSuccess(res, 'Replay periods fetched.', await replayPeriods(indexId(req)));
});

// GET /api/v1/admin/rotation-index/replay?from=&to=&btc_trend= — the index replayed over a
// period, optionally next to the same rule with a BTC trend cash switch (btc_trend = the
// average's length in days, 0 = off). A check on saved prices: nothing is saved or traded.
export const adminReplayIndex = asyncHandler(async (req: Request, res: Response) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  const btcTrend = Number(req.query.btc_trend ?? 0);
  try {
    return sendSuccess(res, 'Replay done.', await replayRotationIndex(indexId(req), from, to, Number.isFinite(btcTrend) ? btcTrend : -1));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(error instanceof Error ? error.message : 'The replay failed.', 400);
  }
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

/** A USDT amount from the request body (the first-run budget or a top-up), if any. */
const usdtOf = (req: Request, field: 'budget' | 'topUp'): number | undefined => {
  const b = (req.body as Record<string, unknown> | undefined)?.[field];
  if (b == null || b === '') return undefined;
  const n = Number(b);
  if (!(n > 0 && n <= 10_000_000)) throw new AppError(`The ${field === 'budget' ? 'budget' : 'amount to add'} must be a positive USDT amount.`, 400);
  return n;
};

/** A pay-out amount: a positive USDT amount, or "all". */
const withdrawOf = (v: unknown): number | 'all' | undefined => {
  if (v == null || v === '') return undefined;
  if (v === 'all') return 'all';
  const n = Number(v);
  if (!(n > 0 && n <= 10_000_000)) throw new AppError('The amount to pay out must be a positive USDT amount, or all.', 400);
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
  const budget = usdtOf(req, 'budget');
  const topUp = usdtOf(req, 'topUp');
  const body = (req.body ?? {}) as { confirm?: unknown; expect?: { sell?: unknown; buy?: unknown }; withdraw?: unknown; investorId?: unknown };
  const withdraw = withdrawOf(body.withdraw);
  const investorId = typeof body.investorId === 'string' && body.investorId.trim() ? body.investorId.trim().slice(0, 64) : undefined;
  const confirmed = body.confirm === true;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []);
  const expect = kind === 'run' && body.expect ? { sell: list(body.expect.sell), buy: list(body.expect.buy) } : undefined;
  if (kind === 'run' && !expect) throw new AppError('Preview the run and confirm its orders first.', 400);
  if (kind === 'run' && !confirmed) throw new AppError('Confirm the run first.', 400);
  const log: string[] = [];
  const who = req.user?.sub ?? 'unknown';
  const what = topUp ? `top-up of ${topUp} USDT${investorId ? ` for ${investorId}` : ''}` : withdraw !== undefined ? `pay-out of ${withdraw} to ${investorId}` : 'run';
  if (kind === 'run') console.log(`[rotation-bot] ${mode} ${what} started from the admin page by user ${who}`);
  try {
    const outcome = await runBot(
      { mode, follow: BOT_FOLLOWS[mode], budget, dryRun: kind === 'preview', yes: kind === 'run' && confirmed, caller: 'admin', expect, topUp, withdraw, investorId },
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

// POST /api/v1/admin/rotation-index/bot/:mode/preview { budget?, topUp? } — what a run (or adding topUp USDT) would
// do now (a dry run: nothing is sent to Binance and nothing is saved).
export const adminBotPreview = asyncHandler(async (req: Request, res: Response) => runForAdmin(req, res, 'preview'));

// POST /api/v1/admin/rotation-index/bot/:mode/run { confirm: true, expect: { sell, buy }, budget?, topUp? }
// — copy the Rotation Index now with this server's key. `expect` is the preview the
// owner confirmed; if the orders differ now, the run stops before placing any. Live needs BOT_LIVE_ENABLED=true and
// BOT_MAX_BUDGET_USDT on the server and a key that cannot withdraw.
export const adminBotRun = asyncHandler(async (req: Request, res: Response) => runForAdmin(req, res, 'run'));

/** Book-only changes stop on purpose with a reason the page shows as-is. */
const books = async <T>(res: Response, message: string, work: () => Promise<T>) => {
  try {
    return sendSuccess(res, message, await work());
  } catch (e) {
    if (e instanceof BotStop) throw new AppError(e.message, 400);
    throw e;
  }
};

const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

// GET /api/v1/admin/rotation-index/bot/:mode/fund — the investor books with today's
// Binance prices: units, value, money in and out, and gain per person (read-only).
export const adminBotFund = asyncHandler(async (req: Request, res: Response) => {
  return sendSuccess(res, 'Investor books fetched.', await readFundView(botMode(req)));
});

// POST /api/v1/admin/rotation-index/bot/:mode/fund/start { ownerName } — open the books:
// the sleeve as it stands belongs to the owner. Writes the books only; no orders.
export const adminBotFundStart = asyncHandler(async (req: Request, res: Response) => {
  const mode = botMode(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  console.log(`[rotation-bot] ${mode} investor books started by user ${req.user?.sub ?? 'unknown'}`);
  return books(res, 'Investor books started.', () => startBooks(mode, text(body.ownerName) ?? '', `admin:${req.user?.sub ?? 'unknown'}`));
});

// POST /api/v1/admin/rotation-index/bot/:mode/fund/investors { name, note? } — add a person (no money yet).
export const adminBotFundAddInvestor = asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return books(res, 'Investor added.', () => addBooksInvestor(botMode(req), { name: text(body.name) ?? '', note: text(body.note) }));
});

// PATCH /api/v1/admin/rotation-index/bot/:mode/fund/investors/:id { name?, note? } — rename or change the note.
export const adminBotFundEditInvestor = asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return books(res, 'Investor updated.', () => editBooksInvestor(botMode(req), String(req.params.id), { name: text(body.name), note: text(body.note) }));
});

// PUT /api/v1/admin/rotation-index/bot/:mode/fund/investors/:id/account { userId | null } — let a site account
// see this person's share (view only on their own page), or take that away. Writes the books only.
export const adminBotFundLinkAccount = asyncHandler(async (req: Request, res: Response) => {
  const mode = botMode(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = body.userId == null || body.userId === '' ? null : text(body.userId);
  if (body.userId != null && body.userId !== '' && !userId) throw new AppError('userId must be a string or null.', 400);
  console.log(`[rotation-bot] ${mode} investor ${String(req.params.id)} ${userId ? `linked to account ${userId}` : 'unlinked'} by user ${req.user?.sub ?? 'unknown'}`);
  return books(res, userId ? 'Account linked.' : 'Account unlinked.', () => linkBooksAccount(mode, String(req.params.id), userId ?? null));
});
