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
 *   npm run bot:rotation -- --follow --budget 1000     testnet: copy the index this mode follows instead
 *                                                     (Balanced + BTC switch for both modes, see BOT_FOLLOWS in
 *                                                     services/rotation-bot/live.ts)
 *   npm run bot:rotation -- --follow                   on an existing ledger: switch it to copying that index
 *   npm run bot:rotation -- --follow=rotation-balanced testnet: copy plain Balanced (no BTC switch) instead
 *                                                     (a testnet sleeve may move between indexes; a live one only
 *                                                     ever follows BOT_FOLLOWS.live, and moves to it on its next run)
 * Following, the sleeve holds exactly the coins the index holds: it sells what the
 * index sold and buys what it bought, once the index has saved the fill. The ledger
 * remembers it, so later runs follow without the flag.
 *
 * Live trading is OFF unless backend/.env sets BOT_LIVE_ENABLED=true and
 * BOT_MAX_BUDGET_USDT, has BINANCE_API_KEY / BINANCE_API_SECRET for a key with
 * withdrawals disabled, and the command adds `--mode live --yes`.
 *
 * The bot only trades its own "sleeve" (the budget and the coins it bought, kept in the
 * rotation_bot_ledgers table — or backend/.bot/rotation-<mode>.json until that table
 * exists), never the rest of the account. Spot market orders only — no withdrawals,
 * transfers, margin or futures exist in its client.
 *
 *   npm run bot:rotation -- --top-up 100 --dry-run      add 100 USDT from Spot to a sleeve that copies the index
 *                                                     and buy its coins at the index's weights (drop --dry-run to do it)
 *
 *   Once the investor books are started (admin page), money in and out is per person:
 *   npm run bot:rotation -- --top-up 50 --investor juma-ally --dry-run    money in for Juma (units at today's price)
 *   npm run bot:rotation -- --withdraw 20 --investor juma-ally --dry-run  pay 20 USDT of Juma's share out (or --withdraw all)
 *
 *   npm run bot:rotation -- --mode live --snapshot    balance check: read the account and save a snapshot for
 *                                                     the admin page. Never places an order, so no --yes needed.
 *
 * The admin Rotation Index page runs the same bot on the server (Refresh, Preview, Run)
 * with the server's own key; the logic lives in services/rotation-bot/runner.ts.
 *
 * After every real run (not a dry run) it saves a snapshot — the sleeve, the Spot
 * wallet and recent trades — to rotation_bot_snapshots for the admin Rotation Index
 * page. Only the snapshot leaves this machine, never the key.
 */
import '../config/env';
import { BotStop } from '../services/rotation-bot/errors';
import { STYLES, type StyleKey } from '../services/rotation-bot/planner';
import { BOT_FOLLOWS } from '../services/rotation-bot/live';
import { runBot, type BotRunOptions } from '../services/rotation-bot/runner';
import { INDEXES, isIndexId } from '../services/rotation-index/rotationIndex.service';

const fail = (msg: string): never => {
  throw new BotStop(msg);
};

const parseArgs = (argv: string[]): BotRunOptions => {
  const a: BotRunOptions = { mode: 'testnet', dryRun: false, snapshot: false, force: false, yes: false, reset: false, caller: 'cli' };
  let bareFollow = false;
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i] ?? fail(`${flag} needs a value.`);
    if (flag === '--mode') {
      const v = value();
      if (v !== 'testnet' && v !== 'live') fail('--mode must be testnet or live.');
      a.mode = v as BotRunOptions['mode'];
    } else if (flag === '--style') {
      const v = value();
      if (!(v in STYLES)) fail('--style must be steady, balanced or bold.');
      a.style = v as StyleKey;
    } else if (flag === '--budget') {
      a.budget = Number(value());
      if (!(a.budget > 0)) fail('--budget must be a positive USDT amount.');
    } else if (flag === '--top-up') {
      a.topUp = Number(value());
      if (!(a.topUp > 0)) fail('--top-up must be a positive USDT amount.');
    } else if (flag === '--withdraw') {
      const v = value();
      a.withdraw = v === 'all' ? 'all' : Number(v);
      if (a.withdraw !== 'all' && !(a.withdraw > 0)) fail('--withdraw must be a positive USDT amount, or all.');
    } else if (flag === '--investor') {
      a.investorId = value();
    } else if (flag === '--follow') {
      // Bare --follow is the index this mode follows (set once the mode is known); --follow=<id> names one.
      if (inline === undefined) bareFollow = true;
      else a.follow = isIndexId(inline) ? inline : fail(`--follow: unknown index "${inline}". Known: ${Object.keys(INDEXES).join(', ')}.`);
    } else if (flag === '--dry-run') a.dryRun = true;
    else if (flag === '--snapshot') a.snapshot = true;
    else if (flag === '--force') a.force = true;
    else if (flag === '--yes') a.yes = true;
    else if (flag === '--reset') a.reset = true;
    else fail(`Unknown option ${flag}. See the comment at the top of src/scripts/rotation-bot.ts.`);
  }
  if (bareFollow) a.follow = BOT_FOLLOWS[a.mode];
  return a;
};

const main = async () => {
  await runBot(parseArgs(process.argv.slice(2)), (line) => console.log(line));
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (e instanceof BotStop) console.error(`\n✗ ${e.message}`);
    else console.error('\n✗ Bot run failed:', e);
    process.exit(1);
  });
