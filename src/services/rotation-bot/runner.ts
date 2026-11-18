import { runRotation } from '../rotation-backtest/engine';
import { loadPriceMatrix } from '../rotation-backtest/rotationData.service';
import { INDEXES, isIndexId, readIndexLineUp, type IndexId } from '../rotation-index/rotationIndex.service';
import { BinanceError, createBinance, type Balance, type OrderResult } from './binance';
import { botKeys, liveEnabled, maxBudgetUsdt } from './config';
import { BotStop } from './errors';
import { applyBuy, applySell, newLedger, reconcile, type Ledger } from './ledger';
import { buyAmounts, pickUniverse, planFollow, planReview, rankUniverse, reviewStatus, STYLES, topUpBuys, type StyleKey } from './planner';
import { fromUnits, isTradablePair, rulesFor, sizeBuy, sizeSell, toUnits, type SymbolRules } from './sizing';
import { buildSnapshot, saveBotSnapshot, type BotSnapshot } from './snapshot';
import { openLedgerStore, type BotMode } from './store';

// One run of the rotation bot — shared by the command line (src/scripts/rotation-bot.ts)
// and the admin page's buttons (the server). It trades Binance SPOT for the owner's
// own account: market orders only, and only the bot's "sleeve" (the budget and the
// coins its ledger says it bought), never the rest of the account.
//
// Every line it prints goes to `out`, so the command line shows it and the admin
// page gets it back as the run's log.

export interface BotRunOptions {
  mode: BotMode;
  style?: StyleKey;
  /** Copy this Rotation Index instead of running the rule. */
  follow?: IndexId;
  budget?: number;
  /** Show the plan; send nothing, save nothing. */
  dryRun?: boolean;
  /** Read the account and save a snapshot only — never trades. */
  snapshot?: boolean;
  force?: boolean;
  /** The owner confirmed a live run. */
  yes?: boolean;
  reset?: boolean;
  /** 'cli' may keep the ledger in a file; 'admin' (the server) trades only with the database ledger. */
  caller: 'cli' | 'admin';
  /** The coins the owner saw in the preview and confirmed: a real run whose orders differ stops instead. */
  expect?: { sell: string[]; buy: string[] };
  /** Add this much USDT from the Spot wallet to a started sleeve and buy the index's coins with it. */
  topUp?: number;
}

export interface BotPlan {
  keep: string[];
  sell: { asset: string; reason: string }[];
  buy: { asset: string; usdt: number | null }[];
}

export interface BotOutcome {
  kind: 'reset' | 'balance-check' | 'waiting' | 'in-sync' | 'not-due' | 'preview' | 'traded';
  /** One plain sentence. */
  summary: string;
  /** What the run would do (preview) or set out to do (traded). */
  plan: BotPlan | null;
  /** The snapshot this run saved for the admin page, if any. */
  snapshot: BotSnapshot | null;
}

const fail = (msg: string): never => {
  throw new BotStop(msg);
};
const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const todayUtc = () => new Date().toISOString().slice(0, 10);
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const runBot = async (a: BotRunOptions, out: (line: string) => void = () => {}): Promise<BotOutcome> => {
  const say = (s = '') => out(s);
  const warn = (s: string) => out(`  ! ${s}`);
  const cli = a.caller === 'cli';
  const live = a.mode === 'live';
  const dryRun = !!a.dryRun;
  const snapshotOnly = !!a.snapshot;
  const keys = botKeys(a.mode);
  const maxBudget = maxBudgetUsdt();
  const done = (kind: BotOutcome['kind'], summary: string, plan: BotPlan | null = null, snapshot: BotSnapshot | null = null): BotOutcome => ({ kind, summary, plan, snapshot });

  if (snapshotOnly && (dryRun || a.reset || a.force)) fail('--snapshot only reads the account; it does not combine with --dry-run, --reset or --force.');
  if (live && !dryRun && !snapshotOnly) {
    if (!liveEnabled()) fail('Live trading is off. It needs BOT_LIVE_ENABLED=true in backend/.env.');
    if (!(maxBudget > 0)) fail('Live trading needs BOT_MAX_BUDGET_USDT in backend/.env (the most the bot may manage).');
    if (!a.yes) fail(cli ? 'A live run places real orders with real money. Add --yes to confirm.' : 'A live run places real orders with real money — confirm it first.');
  }
  if (a.topUp !== undefined && !(a.topUp > 0)) fail('The amount to add must be a positive USDT amount.');
  if (a.topUp && (snapshotOnly || a.reset || a.force || a.style)) fail('Adding to the sleeve does not combine with --snapshot, --reset, --force or --style.');
  if (a.reset && live) fail('--reset is for testnet only. A live ledger is the record of real money; edit it by hand if you must.');

  const store = await openLedgerStore(a.mode, { fileFallback: cli });
  const release = dryRun || snapshotOnly ? async () => {} : await store.lock();
  try {
    if (a.reset) {
      if (!dryRun) await store.clear();
      say('Testnet ledger cleared. Coins it bought stay in the testnet account; the bot just stops tracking them.');
      if (!a.budget) return done('reset', 'Testnet ledger cleared.');
    }

    let ledger: Ledger | null = a.reset ? null : await store.load({ adopt: !dryRun && !snapshotOnly });
    for (const n of store.notes) warn(n);
    const followId = a.follow ?? ledger?.follow;
    const following: IndexId | undefined =
      followId === undefined ? undefined : isIndexId(followId) ? followId : fail(`This ledger follows "${followId}", which is not a known index.`);
    if (ledger?.follow && a.follow && a.follow !== ledger.follow) fail(`This ${a.mode} ledger follows ${ledger.follow}, not ${a.follow}.`);
    if (following && a.style) fail('--style does not apply when following the index: the index sets the rule.');
    if (following && a.force) fail('--force does not apply when following the index: the index decides when to trade.');
    if (!following && ledger && a.style && a.style !== ledger.style) {
      fail(`This ${a.mode} ledger follows ${STYLES[ledger.style].label}. Switching style mid-way mixes two rules — use --reset on testnet to start over.`);
    }
    const style = following ? INDEXES[following].config.style : STYLES[a.style ?? ledger?.style ?? 'balanced'];
    const fresh = !ledger;
    /** An existing sleeve switching from its own rule to copying the index. */
    const converting = !!following && !!ledger && !ledger.follow;
    if (!ledger) {
      const budget = a.budget ?? (dryRun ? 1000 : snapshotOnly ? maxBudget : NaN);
      if (!(budget > 0) && !snapshotOnly) fail(cli ? 'First run: choose the budget the bot may use, e.g. --budget 1000 (USDT).' : 'First run: enter the budget the bot may use (USDT).');
      if (live && budget > maxBudget) {
        const msg = `Budget ${usd(budget)} USDT is above BOT_MAX_BUDGET_USDT (${usd(maxBudget)}).`;
        // A dry run only shows the plan, so it can preview a budget before the cap is set.
        if (dryRun || snapshotOnly) warn(`${msg} A real run would stop here.`);
        else fail(msg);
      }
      ledger = newLedger(a.mode, style.key, budget);
    } else if (a.budget) {
      warn(`The budget only applies to the first run; this ledger's budget is ${usd(ledger.budgetUsdt)} USDT.`);
    }
    const L = ledger;
    if (following) {
      L.follow = following;
      L.style = style.key;
    }
    /** Note this run on the books, so the admin page can say when the bot last ran and what it did. */
    const stamp = (summary: string) => {
      L.lastRun = { at: new Date().toISOString(), summary, by: a.caller };
    };

    const bn = createBinance({ mode: a.mode, ...keys });
    if (!dryRun && !bn.hasKeys) {
      fail(
        `No ${a.mode} API key. Put ${live ? 'BINANCE_API_KEY and BINANCE_API_SECRET' : 'BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET'} in backend/.env${cli ? ', or add --dry-run' : ''}.`
      );
    }

    // ── Market data: saved daily closes (the rule's input) + Binance pairs and prices ──
    const [m, symbols, livePrices, lineUp] = await Promise.all([
      loadPriceMatrix(),
      bn.exchangeInfo(),
      bn.prices(),
      following ? readIndexLineUp(following) : Promise.resolve(null)
    ]);
    const pairs = new Map<string, SymbolRules>();
    const rulesBySymbol = new Map<string, SymbolRules>();
    for (const s of symbols) {
      if (!isTradablePair(s)) continue;
      const r = rulesFor(s);
      pairs.set(s.baseAsset, r);
      rulesBySymbol.set(s.symbol, r);
    }
    const btc = m.prices.bitcoin ?? fail('No saved BTC series — run the price-series sync first.');
    const lastIdx = m.dates.length - 1;
    const asOf = m.dates[lastIdx];
    const today = todayUtc();
    const age = dayDiff(asOf, today);
    if (age > 2) {
      const msg = `Saved prices end ${asOf} (${age} days old). The daily price sync has not run — refusing to trade on stale data.`;
      if (dryRun || snapshotOnly) warn(msg);
      else fail(msg);
    }
    if (following && !lineUp) fail(`${INDEXES[following].label} has not started yet — there is nothing to follow.`);
    if (lineUp) {
      const idxAge = dayDiff(lineUp.date, today);
      if (idxAge > 3) {
        const msg = `The index was last saved for ${lineUp.date} (${idxAge} days ago). The server's daily price sync may have stopped — refusing to copy an old line-up.`;
        if (dryRun || snapshotOnly) warn(msg);
        else fail(msg);
      }
    }
    // Following: only the coins the index holds need a Binance pair. Otherwise: the style's universe.
    const targetIds = lineUp ? lineUp.holdings.map((h) => h.coin) : [];
    const { picked, skipped } = lineUp
      ? pickUniverse(m.coins.filter((c) => targetIds.includes(c.id)), m.prices, lastIdx, pairs, livePrices, Number.POSITIVE_INFINITY)
      : pickUniverse(m.coins, m.prices, lastIdx, pairs, livePrices, style.universeSize);
    if (!lineUp && picked.length < style.topN) fail(`Only ${picked.length} coins qualify on Binance — fewer than ${style.topN} slots.`);
    const ranking = lineUp ? [] : rankUniverse(picked, m.prices, btc, style, lastIdx);
    const byId = new Map(picked.map((c) => [c.id, c]));
    const symbolOf = new Map(m.coins.map((c) => [c.id, c.symbol]));
    const assetOf = (id: string) => byId.get(id)?.asset ?? L.positions[id]?.asset ?? symbolOf.get(id) ?? id;
    const whyNot = (id: string) => skipped.find((x) => x.asset === symbolOf.get(id))?.reason ?? "not in the Lab's coin list";

    say(
      `Pastatrade rotation bot · ${live ? 'LIVE — REAL MONEY' : 'TESTNET — demo funds'} · ${lineUp ? `follows ${lineUp.label}` : style.label}${dryRun ? ' · DRY RUN' : snapshotOnly ? ' · BALANCE CHECK (no orders)' : ''}`
    );
    if (lineUp) {
      say(`Index saved to ${lineUp.date}${lineUp.savedAt ? ` (at ${lineUp.savedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}, at ${lineUp.nav.toFixed(2)} points. Prices: Binance ${a.mode}.`);
      say(`  holds: ${lineUp.holdings.map((h) => `${assetOf(h.coin)} ${h.weightPct.toFixed(1)}% since ${h.entryDate}`).join(' · ') || 'nothing (all cash)'}`);
      if (lineUp.pending) {
        const p = lineUp.pending;
        say(
          `  review decided ${p.decided}: sell ${p.sells.map((x) => `${assetOf(x.coin)} (${x.reason})`).join(', ') || '—'} · buy ${p.adds.map(assetOf).join(', ') || '—'}. It fills at the next close; the bot copies it once that fill is saved.`
        );
      }
      say(`  last review ${lineUp.lastReview ?? '—'} · next review ${lineUp.nextReview ?? '—'}`);
      say();
    } else {
      say(`Rule input: saved daily closes to ${asOf}. Prices: Binance ${a.mode}.`);
      say();
      say(`Universe — top ${style.universeSize} by market cap that Binance trades against USDT:`);
      say(`  ${picked.map((c) => c.asset).join(' ')}`);
      if (skipped.length) say(`  skipped: ${skipped.map((s) => `${s.asset} (${s.reason})`).join(', ')}`);
      const unit = style.signal === 'momentum' ? '%' : 'x';
      say(`Ranking today (${style.signal === 'momentum' ? `${style.lookbackDays}-day change` : 'risk-adjusted momentum'}${style.filter === 'none' ? '' : `, filter: ${style.filter}`}):`);
      say(
        `  ${
          ranking
            .slice(0, style.worstRankHeld + 2)
            .map((r) => `#${r.rank} ${assetOf(r.coin)} ${unit === '%' ? pct(r.score * 100) : `${r.score.toFixed(2)}x`}`)
            .join(' · ') || 'no coin qualifies — the rule sits in cash'
        }`
      );

      // What this exact rule did on these coins (past results, not a forecast).
      const sub: Record<string, (number | null)[]> = {};
      for (const c of picked) sub[c.id] = m.prices[c.id];
      const bt = runRotation({
        dates: m.dates,
        prices: sub,
        btc,
        startIndex: style.lookbackDays,
        params: { ...style, feePct: 0.1, initialCash: 1000 }
      });
      say(
        `Backtest of this rule on these coins, ${bt.dates[0]} → ${asOf}: ${pct(bt.metrics.strategy.totalReturnPct)} (BTC ${pct(bt.metrics.btc.totalReturnPct)}), worst drop ${bt.metrics.strategy.maxDrawdownPct.toFixed(0)}%. Past results, not a forecast.`
      );
      say();
    }

    // ── Account: safety checks, recover an interrupted order, reconcile ──
    let usdtFree = Infinity;
    let spotBalances: Map<string, Balance> | null = null;
    const notes: string[] = [];
    if (bn.hasKeys) {
      await bn.syncTime();
      if (live) {
        const r = await bn.apiRestrictions();
        if (r.enableWithdrawals) fail('This API key can WITHDRAW funds. Turn withdrawals off for it on Binance — the bot refuses to run with it.');
        if (!r.enableSpotAndMarginTrading) {
          const msg = 'This API key does not have spot trading enabled. On Binance › API Management, edit the key and tick "Enable Spot & Margin Trading" (Binance allows it only once the key is restricted to trusted IPs).';
          if (dryRun || snapshotOnly) warn(`${msg} A real run would stop here.`);
          else fail(msg);
        }
        if (!r.ipRestrict) warn('This API key is not restricted to an IP address. Restrict it to the machine that runs the bot.');
      }
      if (L.pending) {
        const p = L.pending;
        const o = await bn.findOrder(p.symbol, p.clientOrderId);
        const rules = rulesBySymbol.get(p.symbol);
        if (!o) notes.push(`The interrupted ${p.side} ${p.symbol} was never placed.`);
        else if (Number(o.executedQty) > 0 && rules) {
          if (p.side === 'BUY') applyBuy(L, p.coin, rules, o, today, p.reason);
          else applySell(L, p.coin, rules, o, livePrices.get(p.symbol) ?? 0, p.reason);
          notes.push(`Recovered the interrupted ${p.side} ${p.symbol}: ${o.executedQty} ${p.asset} (${o.status}).`);
        } else notes.push(`The interrupted ${p.side} ${p.symbol} did not fill (${o.status}).`);
        if (!dryRun) L.pending = null;
      }
      const bal = await bn.balances();
      spotBalances = bal;
      const free = new Map([...bal].map(([asset, b]) => [asset, b.free]));
      notes.push(...reconcile(L, free));
      usdtFree = Number(free.get('USDT') ?? 0);
      if (fresh && usdtFree < L.budgetUsdt) {
        const msg = `The account has ${usd(usdtFree)} USDT free — less than the ${usd(L.budgetUsdt)} USDT budget.`;
        if (dryRun || snapshotOnly) warn(msg);
        else fail(msg);
      }
    }
    for (const n of notes) warn(n);

    const valueOf = (id: string) => {
      const p = L.positions[id];
      return p ? Number(p.qty) * (livePrices.get(p.symbol) ?? 0) : 0;
    };
    const printSleeve = (title: string) => {
      const held = Object.values(L.positions);
      const invested = held.reduce((s, p) => s + valueOf(p.coin), 0);
      const equity = L.cashUsdt + invested;
      say(`${title}: ${usd(equity)} USDT (${pct((equity / L.budgetUsdt - 1) * 100)} on the ${usd(L.budgetUsdt)} budget)`);
      for (const p of held) {
        const v = valueOf(p.coin);
        say(`  ${p.asset.padEnd(7)} ${p.qty.padStart(16)}  ${usd(v).padStart(11)} USDT  ${pct((v / p.costUsdt - 1) * 100).padStart(7)}  since ${p.entryDate}`);
      }
      say(`  ${'Cash'.padEnd(7)} ${''.padStart(16)}  ${usd(L.cashUsdt).padStart(11)} USDT`);
      if (Object.keys(L.dust).length) say(`  dust (too small to sell): ${Object.entries(L.dust).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    };
    printSleeve(fresh ? 'Sleeve (new)' : 'Sleeve now');
    say();

    /** Save what the sleeve and the Spot wallet hold, for the admin page. Never fails the run. */
    const saveSnapshot = async (status: string, { started = true, refresh = false } = {}): Promise<BotSnapshot | null> => {
      if (dryRun || !bn.hasKeys) return null;
      try {
        if (refresh) spotBalances = await bn.balances();
        const snap = buildSnapshot({
          ledger: L,
          started,
          prices: livePrices,
          balances: spotBalances,
          status,
          index: lineUp ? { id: lineUp.id, date: lineUp.date } : null,
          nextReview: lineUp ? lineUp.nextReview : reviewStatus(L.lastReview, today, style.rebalanceDays).nextReview
        });
        await saveBotSnapshot(snap);
        say('Snapshot saved for the admin Rotation Index page.');
        return snap;
      } catch (e) {
        warn(`Snapshot not saved for the admin page: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    };

    const place = async (side: 'BUY' | 'SELL', coin: string, rules: SymbolRules, value: string, reason: string): Promise<OrderResult | null> => {
      const clientOrderId = `ptrot_${Date.now().toString(36)}_${side[0]}_${rules.base}`.slice(0, 36);
      // Booked before the order is sent, so a crash or timeout leaves a trail the next run follows up.
      L.pending = { clientOrderId, symbol: rules.symbol, side, coin, asset: rules.base, reason, createdAt: new Date().toISOString() };
      await store.save(L);
      try {
        const o = side === 'BUY' ? await bn.marketBuy(rules.symbol, value, clientOrderId) : await bn.marketSell(rules.symbol, value, clientOrderId);
        if (side === 'BUY') applyBuy(L, coin, rules, o, today, reason);
        else applySell(L, coin, rules, o, livePrices.get(rules.symbol) ?? 0, reason);
        L.pending = null;
        await store.save(L);
        return o;
      } catch (e) {
        if (e instanceof BinanceError && e.rejected) {
          L.pending = null;
          await store.save(L);
          warn(`${side} ${rules.symbol} rejected by Binance: ${e.message}`);
          return null;
        }
        // No answer: the order may exist. `pending` stays so the next run looks it up.
        throw e;
      }
    };

    /** A real run copies only the orders the owner confirmed in the preview. */
    const checkExpect = (sell: string[], buy: string[]) => {
      if (!a.expect || dryRun) return;
      const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
      if (!same(sell, a.expect.sell) || !same(buy, a.expect.buy)) {
        fail(`The orders changed since the preview (now: sell ${sell.join(', ') || '—'}, buy ${buy.join(', ') || '—'}). Nothing was placed — check again and confirm the new orders.`);
      }
    };

    if (snapshotOnly) {
      const status = fresh ? 'Balance check — the sleeve has not bought anything yet.' : 'Balance check — no orders placed.';
      return done('balance-check', status, null, await saveSnapshot(status, { started: !fresh }));
    }

    if (a.topUp) {
      // ── Add money to a sleeve that already copies the index ──
      const add = a.topUp;
      const idx = lineUp ?? fail('Adding to the sleeve works only when it copies the Rotation Index.');
      if (fresh) fail('The sleeve has not started yet — set the first-run budget instead of adding to it.');
      if (idx.pending && dayDiff(idx.pending.decided, idx.date) <= 2) {
        fail(`The index has a review waiting to fill (decided ${idx.pending.decided}). Add to the sleeve after the bot has copied it.`);
      }
      const sync = planFollow(Object.keys(L.positions), targetIds.filter((id) => byId.has(id)));
      if (sync.drops.length || sync.adds.length) fail('The sleeve does not match the index yet — press Run now first so it copies the index, then add to it.');
      const outside = usdtFree - L.cashUsdt;
      if (add > outside + 1e-6) {
        const msg = `Only ${usd(Math.max(0, outside))} USDT in Spot is outside the sleeve — less than the ${usd(add)} USDT to add. Deposit to Spot first.`;
        if (dryRun) warn(`${msg} A real run would stop here.`);
        else fail(msg);
      }
      const before = L.budgetUsdt;
      const after = Math.round((before + add) * 1e8) / 1e8;
      if (live && after > maxBudget) {
        const msg = `Adding ${usd(add)} USDT makes the sleeve ${usd(after)} USDT — above BOT_MAX_BUDGET_USDT (${usd(maxBudget)}). Raise it in backend/.env first.`;
        if (dryRun) warn(`${msg} A real run would stop here.`);
        else fail(msg);
      }
      L.budgetUsdt = after;
      L.cashUsdt = Math.round((L.cashUsdt + add) * 1e8) / 1e8;
      L.topUps = [...(L.topUps ?? []), { at: new Date().toISOString(), usdt: add }];
      const weights = new Map(idx.holdings.map((h) => [h.coin, h.weightPct]));
      const held = Object.keys(L.positions).map((coin) => ({ coin, value: valueOf(coin) }));
      const equity = L.cashUsdt + held.reduce((x, h) => x + h.value, 0);
      const buys = topUpBuys(held, weights, L.cashUsdt, equity);
      say(`Add ${usd(add)} USDT to the sleeve (budget ${usd(before)} → ${usd(after)} USDT), spread over the index's coins by its weights:`);
      for (const b of buys) say(`  ${dryRun ? 'would buy' : 'buy'} ${assetOf(b.coin)} for ~${usd(b.amount)} USDT (${(weights.get(b.coin) ?? 0).toFixed(1)}% in the index)`);
      const tPlan: BotPlan = {
        keep: held.map((h) => assetOf(h.coin)),
        sell: [],
        buy: buys.map((b) => ({ asset: assetOf(b.coin), usdt: Math.round(b.amount * 100) / 100 }))
      };
      checkExpect([], tPlan.buy.map((b) => b.asset));
      if (dryRun) {
        say();
        say('DRY RUN — nothing was sent to Binance and nothing was saved.');
        return done('preview', `Adding ${usd(add)} USDT would buy ${tPlan.buy.map((b) => b.asset).join(', ') || 'nothing'}.`, tPlan);
      }

      // The new budget and cash are booked first, so the money is the sleeve's even if an order fails.
      await store.save(L);
      say();
      const topped: string[] = [];
      for (const b of buys) {
        const c = byId.get(b.coin)!;
        const size = sizeBuy(c.rules, b.amount, c.price);
        if (!size.ok) {
          warn(`${c.asset}: not bought (${size.reason}) — that part stays as cash in the sleeve.`);
          continue;
        }
        const o = await place('BUY', b.coin, c.rules, size.value, 'added to the sleeve');
        if (o) {
          topped.push(c.asset);
          say(`  BOUGHT ${o.executedQty} ${c.asset} for ${usd(Number(o.cummulativeQuoteQty))} USDT`);
        }
      }
      const summary = `Added ${usd(add)} USDT to the sleeve: bought ${topped.join(', ') || 'nothing'}.`;
      stamp(summary);
      await store.save(L);
      say();
      printSleeve('Sleeve after adding');
      return done('traded', summary, tPlan, await saveSnapshot(summary, { refresh: true }));
    }

    let plan: { keep: string[]; drops: { coin: string; reason: string }[]; adds: string[] };
    let buyReason = 'entered the top slots';
    if (lineUp) {
      // ── Follow the index: hold what it holds ──
      // While the index has a review waiting to fill, copy nothing: its holdings are
      // about to change (and right after the index starts they are empty), so trading
      // now would buy coins it is about to sell or sell coins it is about to buy.
      // A review stuck unfilled for days (a coin with no price) no longer blocks.
      if (lineUp.pending && dayDiff(lineUp.pending.decided, lineUp.date) <= 2) {
        const why = `The index has a review waiting to fill (decided ${lineUp.pending.decided}). The bot copies it once that fill is saved — nothing to do today.`;
        say(why);
        // A sleeve switching to the index only switches once it copies a fill.
        if (!dryRun && !fresh && !converting) {
          stamp(`Waited for the index to fill its review decided ${lineUp.pending.decided}.`);
          await store.save(L);
        }
        if (fresh || converting) say('Nothing was bought and nothing was saved.');
        const snap = await saveSnapshot(`Waiting for the index to fill its review decided ${lineUp.pending.decided}.`, { started: !fresh });
        return done('waiting', why, null, snap);
      }
      if (lineUp.pending) warn(`The index's review from ${lineUp.pending.decided} still hasn't fully filled — copying what it holds now.`);
      const raw = planFollow(Object.keys(L.positions), targetIds);
      for (const c of raw.adds.filter((id) => !byId.has(id))) {
        warn(`${assetOf(c)}: the index holds it, but it can't be bought on Binance ${a.mode} (${whyNot(c)}) — its slot stays in cash.`);
      }
      plan = { ...raw, adds: raw.adds.filter((id) => byId.has(id)) };
      if (!plan.drops.length && !plan.adds.length) {
        const why = `The sleeve matches the index — nothing to do today.${lineUp.pending ? ' The bot copies the pending review once its fill is saved.' : ''}`;
        say(why);
        if (!dryRun && !fresh) {
          stamp('Matched the index — nothing to trade.');
          await store.save(L);
        }
        if (converting && !dryRun) say('This ledger now follows the index.');
        const snap = await saveSnapshot(`Matches the index — nothing to trade.${lineUp.pending ? ` Its review decided ${lineUp.pending.decided} fills at the next close.` : ''}`, { started: !fresh });
        return done('in-sync', why, { keep: plan.keep.map(assetOf), sell: [], buy: [] }, snap);
      }
      buyReason = 'the index holds it';
      say(`Copy the index ${today}${converting ? ' (switching this sleeve to follow the index)' : ''}:`);
    } else {
      const status = reviewStatus(L.lastReview, today, style.rebalanceDays);
      if (!status.due && !a.force) {
        const why = `Next review ${status.nextReview} (in ${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'}). Nothing to do today — the rule does nothing between reviews.`;
        say(why);
        if (!dryRun) {
          stamp(`Not a review day — next review ${status.nextReview}.`);
          await store.save(L);
        }
        return done('not-due', why, null, await saveSnapshot(`Next review ${status.nextReview} — nothing to trade until then.`));
      }
      // ── Review ──
      plan = planReview(Object.keys(L.positions), ranking, new Set(picked.map((c) => c.id)), style);
      say(`Review ${today}${status.due ? '' : ' (forced)'}:`);
    }
    say(`  keep: ${plan.keep.map(assetOf).join(', ') || '—'}`);
    say(`  sell: ${plan.drops.map((d) => `${assetOf(d.coin)} (${d.reason})`).join(', ') || '—'}`);
    say(`  buy:  ${plan.adds.map(assetOf).join(', ') || '—'}`);
    const planOut = (amounts: Map<string, number>): BotPlan => ({
      keep: plan.keep.map(assetOf),
      sell: plan.drops.map((d) => ({ asset: assetOf(d.coin), reason: d.reason })),
      buy: plan.adds.map((id) => ({ asset: assetOf(id), usdt: amounts.has(id) ? Math.round(amounts.get(id)! * 100) / 100 : null }))
    });

    checkExpect(plan.drops.map((d) => assetOf(d.coin)), plan.adds.map(assetOf));

    if (dryRun) {
      const proceeds = plan.drops.reduce((s, d) => s + valueOf(d.coin) * 0.999, 0);
      const cash = L.cashUsdt + proceeds;
      const kept = plan.keep.reduce((s, id) => s + valueOf(id), 0);
      const amounts = new Map<string, number>();
      for (const b of buyAmounts(plan.adds, cash, cash + kept, style.topN, style.topN - plan.keep.length)) {
        amounts.set(b.coin, b.amount);
        say(`  would buy ${assetOf(b.coin)} for ~${usd(b.amount)} USDT`);
      }
      say();
      say('DRY RUN — nothing was sent to Binance and nothing was saved.');
      const p = planOut(amounts);
      const summary = [p.sell.length ? `sell ${p.sell.map((x) => x.asset).join(', ')}` : '', p.buy.length ? `buy ${p.buy.map((x) => x.asset).join(', ')}` : '']
        .filter(Boolean)
        .join(', then ');
      return done('preview', `A run now would ${summary || 'place no order'}.`, p);
    }


    say();
    const sold: string[] = [];
    const bought: string[] = [];
    const amounts = new Map<string, number>();
    for (const d of plan.drops) {
      const pos = L.positions[d.coin];
      const rules = rulesBySymbol.get(pos.symbol);
      const price = livePrices.get(pos.symbol);
      if (!rules || !price) {
        warn(`${pos.asset}: ${pos.symbol} is not tradable right now — it keeps its slot until it can be sold.`);
        continue;
      }
      const size = sizeSell(rules, pos.qty, price);
      if (!size.ok) {
        warn(`${pos.asset}: cannot sell (${size.reason}) — moved to dust, slot freed.`);
        L.dust[pos.asset] = fromUnits(toUnits(L.dust[pos.asset] ?? '0') + toUnits(pos.qty));
        delete L.positions[d.coin];
        continue;
      }
      const o = await place('SELL', d.coin, rules, size.value, d.reason);
      if (o) {
        sold.push(pos.asset);
        say(`  SOLD   ${o.executedQty} ${pos.asset} for ${usd(Number(o.cummulativeQuoteQty))} USDT (${d.reason})`);
      }
    }

    if (plan.drops.length) usdtFree = Number((await bn.balances()).get('USDT')?.free ?? 0);
    const kept = Object.keys(L.positions);
    const equity = L.cashUsdt + kept.reduce((s, id) => s + valueOf(id), 0);
    const cash = Math.min(L.cashUsdt, usdtFree);
    for (const b of buyAmounts(plan.adds, cash, equity, style.topN, style.topN - kept.length)) {
      amounts.set(b.coin, b.amount);
      const c = byId.get(b.coin)!;
      const size = sizeBuy(c.rules, b.amount, c.price);
      if (!size.ok) {
        warn(`${c.asset}: not bought (${size.reason}) — the slot stays in cash.`);
        continue;
      }
      const o = await place('BUY', b.coin, c.rules, size.value, buyReason);
      if (o) {
        bought.push(c.asset);
        say(`  BOUGHT ${L.positions[b.coin]?.qty ?? o.executedQty} ${c.asset} for ${usd(Number(o.cummulativeQuoteQty))} USDT`);
      }
    }

    L.lastReview = today;
    const did = [sold.length ? `sold ${sold.join(', ')}` : '', bought.length ? `bought ${bought.join(', ')}` : ''].filter(Boolean).join(', ') || 'no order filled';
    const summary = `${lineUp ? 'Copied the index' : 'Reviewed'}: ${did}.`;
    stamp(summary);
    await store.save(L);
    say();
    printSleeve('Sleeve after the review');
    if (L.feesBnb > 0) say(`  fees paid in BNB so far: ${L.feesBnb} BNB (outside the sleeve)`);
    if (lineUp) say(`Next index review ${lineUp.nextReview ?? '—'}. The bot copies it once the index saves the fill.`);
    else say(`Next review ${reviewStatus(L.lastReview, today, style.rebalanceDays).nextReview}.`);
    return done('traded', summary, planOut(amounts), await saveSnapshot(summary, { refresh: true }));
  } finally {
    await release();
  }
};
