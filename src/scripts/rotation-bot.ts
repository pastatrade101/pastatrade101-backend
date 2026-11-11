/**
 * Pastatrade rotation bot — follows a Rotation Lab style on Binance SPOT for the
 * owner's own account. Testnet (demo funds) is the default.
 *
 *   npm run bot:rotation -- --dry-run                  show the plan; no keys needed, nothing sent or saved
 *   npm run bot:rotation -- --budget 1000              testnet: first run, buys the line-up with 1,000 demo USDT
 *   npm run bot:rotation                               testnet: trades only when a review is due
 *   npm run bot:rotation -- --force                    testnet: review now even if not due
 *   npm run bot:rotation -- --reset                    testnet: forget the testnet ledger
 *   options: --style steady|balanced|bold (first run; default balanced)
 *
 * Live trading is OFF unless backend/.env sets BOT_LIVE_ENABLED=true and
 * BOT_MAX_BUDGET_USDT, has BINANCE_API_KEY / BINANCE_API_SECRET for a key with
 * withdrawals disabled, and the command adds `--mode live --yes`.
 *
 * The bot only trades its own "sleeve" (the budget and the coins it bought, kept in
 * backend/.bot/rotation-<mode>.json), never the rest of the account. Spot market
 * orders only — no withdrawals, transfers, margin or futures exist in its client.
 */
import '../config/env';
import { runRotation } from '../services/rotation-backtest/engine';
import { loadPriceMatrix } from '../services/rotation-backtest/rotationData.service';
import { BinanceError, createBinance, type BinanceMode, type OrderResult } from '../services/rotation-bot/binance';
import {
  acquireLock,
  applyBuy,
  applySell,
  defaultStateDir,
  deleteLedger,
  loadLedger,
  newLedger,
  reconcile,
  saveLedger,
  type Ledger
} from '../services/rotation-bot/ledger';
import { buyAmounts, pickUniverse, planReview, rankUniverse, reviewStatus, STYLES, type StyleKey } from '../services/rotation-bot/planner';
import { fromUnits, isTradablePair, rulesFor, sizeBuy, sizeSell, toUnits, type SymbolRules } from '../services/rotation-bot/sizing';

class Stop extends Error {}
const fail = (msg: string): never => {
  throw new Stop(msg);
};

interface Args {
  mode: BinanceMode;
  style?: StyleKey;
  budget?: number;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  reset: boolean;
}

const parseArgs = (argv: string[]): Args => {
  const a: Args = { mode: 'testnet', dryRun: false, force: false, yes: false, reset: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i] ?? fail(`${flag} needs a value.`);
    if (flag === '--mode') {
      const v = value();
      if (v !== 'testnet' && v !== 'live') fail('--mode must be testnet or live.');
      a.mode = v as BinanceMode;
    } else if (flag === '--style') {
      const v = value();
      if (!(v in STYLES)) fail('--style must be steady, balanced or bold.');
      a.style = v as StyleKey;
    } else if (flag === '--budget') {
      a.budget = Number(value());
      if (!(a.budget > 0)) fail('--budget must be a positive USDT amount.');
    } else if (flag === '--dry-run') a.dryRun = true;
    else if (flag === '--force') a.force = true;
    else if (flag === '--yes') a.yes = true;
    else if (flag === '--reset') a.reset = true;
    else fail(`Unknown option ${flag}. See the comment at the top of src/scripts/rotation-bot.ts.`);
  }
  return a;
};

const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const say = (s = '') => console.log(s);
const warn = (s: string) => console.log(`  ! ${s}`);
const todayUtc = () => new Date().toISOString().slice(0, 10);
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const main = async () => {
  const a = parseArgs(process.argv.slice(2));
  const live = a.mode === 'live';
  const keys = live
    ? { apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET }
    : { apiKey: process.env.BINANCE_TESTNET_API_KEY, apiSecret: process.env.BINANCE_TESTNET_API_SECRET };
  const maxBudget = Number(process.env.BOT_MAX_BUDGET_USDT || 0);

  if (live && !a.dryRun) {
    if (process.env.BOT_LIVE_ENABLED !== 'true') fail('Live trading is off. It needs BOT_LIVE_ENABLED=true in backend/.env.');
    if (!(maxBudget > 0)) fail('Live trading needs BOT_MAX_BUDGET_USDT in backend/.env (the most the bot may manage).');
    if (!a.yes) fail('A live run places real orders with real money. Add --yes to confirm.');
  }
  if (a.reset && live) fail('--reset is for testnet only. A live ledger is the record of real money; edit it by hand if you must.');

  const dir = defaultStateDir();
  const release = a.dryRun ? () => {} : acquireLock(dir, a.mode);
  try {
    if (a.reset) {
      if (!a.dryRun) deleteLedger(dir, 'testnet');
      say('Testnet ledger cleared. Coins it bought stay in the testnet account; the bot just stops tracking them.');
      if (!a.budget) return;
    }

    let ledger: Ledger | null = a.reset ? null : loadLedger(dir, a.mode);
    if (ledger && a.style && a.style !== ledger.style) {
      fail(`This ${a.mode} ledger follows ${STYLES[ledger.style].label}. Switching style mid-way mixes two rules — use --reset on testnet to start over.`);
    }
    const style = STYLES[a.style ?? ledger?.style ?? 'balanced'];
    const fresh = !ledger;
    if (!ledger) {
      const budget = a.budget ?? (a.dryRun ? 1000 : NaN);
      if (!(budget > 0)) fail('First run: choose the budget the bot may use, e.g. --budget 1000 (USDT).');
      if (live && budget > maxBudget) fail(`Budget ${usd(budget)} USDT is above BOT_MAX_BUDGET_USDT (${usd(maxBudget)}).`);
      ledger = newLedger(a.mode, style.key, budget);
    } else if (a.budget) {
      warn(`--budget only applies to the first run; this ledger's budget is ${usd(ledger.budgetUsdt)} USDT.`);
    }
    const L = ledger;

    const bn = createBinance({ mode: a.mode, ...keys });
    if (!a.dryRun && !bn.hasKeys) {
      fail(
        `No ${a.mode} API key. Put ${live ? 'BINANCE_API_KEY and BINANCE_API_SECRET' : 'BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET'} in backend/.env, or add --dry-run.`
      );
    }

    // ── Market data: saved daily closes (the rule's input) + Binance pairs and prices ──
    const [m, symbols, livePrices] = await Promise.all([loadPriceMatrix(), bn.exchangeInfo(), bn.prices()]);
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
      if (a.dryRun) warn(msg);
      else fail(msg);
    }
    const { picked, skipped } = pickUniverse(m.coins, m.prices, lastIdx, pairs, livePrices, style.universeSize);
    if (picked.length < style.topN) fail(`Only ${picked.length} coins qualify on Binance — fewer than ${style.topN} slots.`);
    const ranking = rankUniverse(picked, m.prices, btc, style, lastIdx);
    const byId = new Map(picked.map((c) => [c.id, c]));
    const assetOf = (id: string) => byId.get(id)?.asset ?? L.positions[id]?.asset ?? id;

    say(`Pastatrade rotation bot · ${live ? 'LIVE — REAL MONEY' : 'TESTNET — demo funds'} · ${style.label}${a.dryRun ? ' · DRY RUN' : ''}`);
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

    // ── Account: safety checks, recover an interrupted order, reconcile ──
    let usdtFree = Infinity;
    const notes: string[] = [];
    if (bn.hasKeys) {
      await bn.syncTime();
      if (live) {
        const r = await bn.apiRestrictions();
        if (r.enableWithdrawals) fail('This API key can WITHDRAW funds. Turn withdrawals off for it on Binance — the bot refuses to run with it.');
        if (!r.enableSpotAndMarginTrading && !a.dryRun) fail('This API key does not have spot trading enabled.');
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
        if (!a.dryRun) L.pending = null;
      }
      const bal = await bn.balances();
      const free = new Map([...bal].map(([asset, b]) => [asset, b.free]));
      notes.push(...reconcile(L, free));
      usdtFree = Number(free.get('USDT') ?? 0);
      if (fresh && usdtFree < L.budgetUsdt) {
        const msg = `The account has ${usd(usdtFree)} USDT free — less than the ${usd(L.budgetUsdt)} USDT budget.`;
        if (a.dryRun) warn(msg);
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

    const status = reviewStatus(L.lastReview, today, style.rebalanceDays);
    if (!status.due && !a.force) {
      say(`Next review ${status.nextReview} (in ${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'}). Nothing to do today — the rule does nothing between reviews.`);
      if (!a.dryRun && notes.length) saveLedger(dir, L);
      return;
    }

    // ── Review ──
    const plan = planReview(Object.keys(L.positions), ranking, new Set(picked.map((c) => c.id)), style);
    say(`Review ${today}${status.due ? '' : ' (forced)'}:`);
    say(`  keep: ${plan.keep.map(assetOf).join(', ') || '—'}`);
    say(`  sell: ${plan.drops.map((d) => `${assetOf(d.coin)} (${d.reason})`).join(', ') || '—'}`);
    say(`  buy:  ${plan.adds.map(assetOf).join(', ') || '—'}`);

    if (a.dryRun) {
      const proceeds = plan.drops.reduce((s, d) => s + valueOf(d.coin) * 0.999, 0);
      const cash = L.cashUsdt + proceeds;
      const kept = plan.keep.reduce((s, id) => s + valueOf(id), 0);
      for (const b of buyAmounts(plan.adds, cash, cash + kept, style.topN, style.topN - plan.keep.length)) {
        say(`  would buy ${assetOf(b.coin)} for ~${usd(b.amount)} USDT`);
      }
      say();
      say('DRY RUN — nothing was sent to Binance and nothing was saved.');
      return;
    }

    const place = async (side: 'BUY' | 'SELL', coin: string, rules: SymbolRules, value: string, reason: string): Promise<OrderResult | null> => {
      const clientOrderId = `ptrot_${Date.now().toString(36)}_${side[0]}_${rules.base}`.slice(0, 36);
      L.pending = { clientOrderId, symbol: rules.symbol, side, coin, asset: rules.base, reason, createdAt: new Date().toISOString() };
      saveLedger(dir, L);
      try {
        const o = side === 'BUY' ? await bn.marketBuy(rules.symbol, value, clientOrderId) : await bn.marketSell(rules.symbol, value, clientOrderId);
        if (side === 'BUY') applyBuy(L, coin, rules, o, today, reason);
        else applySell(L, coin, rules, o, livePrices.get(rules.symbol) ?? 0, reason);
        L.pending = null;
        saveLedger(dir, L);
        return o;
      } catch (e) {
        if (e instanceof BinanceError && e.rejected) {
          L.pending = null;
          saveLedger(dir, L);
          warn(`${side} ${rules.symbol} rejected by Binance: ${e.message}`);
          return null;
        }
        // No answer: the order may exist. `pending` stays so the next run looks it up.
        throw e;
      }
    };

    say();
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
      if (o) say(`  SOLD   ${o.executedQty} ${pos.asset} for ${usd(Number(o.cummulativeQuoteQty))} USDT (${d.reason})`);
    }

    if (plan.drops.length) usdtFree = Number((await bn.balances()).get('USDT')?.free ?? 0);
    const kept = Object.keys(L.positions);
    const equity = L.cashUsdt + kept.reduce((s, id) => s + valueOf(id), 0);
    const cash = Math.min(L.cashUsdt, usdtFree);
    for (const b of buyAmounts(plan.adds, cash, equity, style.topN, style.topN - kept.length)) {
      const c = byId.get(b.coin)!;
      const size = sizeBuy(c.rules, b.amount, c.price);
      if (!size.ok) {
        warn(`${c.asset}: not bought (${size.reason}) — the slot stays in cash.`);
        continue;
      }
      const o = await place('BUY', b.coin, c.rules, size.value, 'entered the top slots');
      if (o) say(`  BOUGHT ${L.positions[b.coin]?.qty ?? o.executedQty} ${c.asset} for ${usd(Number(o.cummulativeQuoteQty))} USDT`);
    }

    L.lastReview = today;
    saveLedger(dir, L);
    say();
    printSleeve('Sleeve after the review');
    if (L.feesBnb > 0) say(`  fees paid in BNB so far: ${L.feesBnb} BNB (outside the sleeve)`);
    say(`Next review ${reviewStatus(L.lastReview, today, style.rebalanceDays).nextReview}.`);
  } finally {
    release();
  }
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (e instanceof Stop) console.error(`\n✗ ${e.message}`);
    else console.error('\n✗ Bot run failed:', e);
    process.exit(1);
  });
