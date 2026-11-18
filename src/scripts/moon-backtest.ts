/**
 * Moon backtest from the command line — the same engine the admin page runs.
 *
 *   npm run backtest:moon                       # bring the candles up to date, run the default rules
 *   npm run backtest:moon -- --compare          # the comparison set (daily vs weekly, exits, filters…)
 *   npm run backtest:moon -- --baseBars 52 --btcFilter false --stopLossPct 15
 *   npm run backtest:moon -- --compare --save   # also save every run for the admin page
 *   npm run backtest:moon -- --no-sync          # use the cached candles as they are
 *
 * Any rule in DEFAULT_PARAMS can be set as --<name> <value>. Read-only market data:
 * nothing here touches a Binance account.
 */
import 'dotenv/config';
import { loadHistory, syncHistory } from '../services/moon-backtest/data';
import { runMoonBacktest, type MoonParams, type MoonResult } from '../services/moon-backtest/engine';
import { COMPARE_SET, DEFAULT_PARAMS, normalizeParams } from '../services/moon-backtest/presets';
import { saveRun } from '../services/moon-backtest/store';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a === '--compare' || a === '--save' || a === '--no-sync' || a === '--trades'));
const overrides: Record<string, unknown> = {};
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].replace(/^--/, '');
  if (!argv[i].startsWith('--') || !(key in DEFAULT_PARAMS)) continue;
  const raw = argv[++i];
  overrides[key] = raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : key === 'takeProfits' ? JSON.parse(raw) : raw;
}

const pct = (x: number | null | undefined) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

const line = (name: string, r: MoonResult) => {
  const m = r.metrics.strategy;
  const s = r.stats;
  return [
    pad(name, 48),
    lpad(pct(m.totalReturnPct), 11),
    lpad(pct(m.cagrPct), 9),
    lpad(pct(m.maxDrawdownPct), 8),
    lpad(String(s.trades), 6),
    lpad(s.winRatePct == null ? '—' : `${s.winRatePct.toFixed(0)}%`, 5),
    lpad(pct(s.avgWinPct), 8),
    lpad(pct(s.avgLossPct), 8),
    lpad(s.profitFactor == null ? '—' : s.profitFactor.toFixed(2), 6),
    lpad(`${s.exposurePct.toFixed(0)}%`, 5)
  ].join(' ');
};

(async () => {
  if (!flags.has('--no-sync')) {
    let last = 0;
    const sync = await syncHistory((stage, done, total) => {
      if (Date.now() - last > 3000 || done === total) {
        last = Date.now();
        process.stdout.write(`\r${stage}: ${done}/${total}   `);
      }
    });
    console.log(`\nCandles: ${sync.pairs} pairs in ${sync.dir} (${sync.downloaded} downloaded, ${sync.refreshed} refreshed${sync.failed.length ? `, ${sync.failed.length} failed` : ''})`);
    for (const f of sync.failed.slice(0, 10)) console.log(`  ! ${f}`);
  }
  const history = loadHistory();
  console.log(`Loaded ${history.series.length} pairs (${history.delisted} no longer trading).\n`);

  const runs: { name: string; params: MoonParams }[] = flags.has('--compare')
    ? COMPARE_SET.map((c) => ({ name: c.name, params: normalizeParams({ ...c.params, ...overrides } as Record<string, unknown>) }))
    : [{ name: Object.keys(overrides).length ? `Custom: ${Object.entries(overrides).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}` : 'Default rules', params: normalizeParams(overrides) }];

  console.log(`${pad('Rules', 48)} ${lpad('Return', 11)} ${lpad('CAGR', 9)} ${lpad('MaxDD', 8)} ${lpad('Trades', 6)} ${lpad('Win', 5)} ${lpad('AvgWin', 8)} ${lpad('AvgLoss', 8)} ${lpad('PF', 6)} ${lpad('Expo', 5)}`);
  let btcShown = false;
  for (const run of runs) {
    const r = runMoonBacktest(history, run.params);
    if (!btcShown) {
      const b = r.metrics.btc;
      console.log(`${pad(`BTC buy & hold (${r.period.start} → ${r.period.end})`, 48)} ${lpad(pct(b.totalReturnPct), 11)} ${lpad(pct(b.cagrPct), 9)} ${lpad(pct(b.maxDrawdownPct), 8)}`);
      btcShown = true;
    }
    console.log(line(run.name, r));
    if (!flags.has('--compare')) {
      console.log('\nYear by year (strategy vs BTC, trades opened):');
      for (const y of r.byYear) console.log(`  ${y.year}  ${lpad(pct(y.strategyPct), 9)}  ${lpad(pct(y.btcPct), 9)}  ${y.trades}`);
      console.log('\nExits:');
      for (const e of r.exitReasons) console.log(`  ${pad(e.reason, 9)} ${lpad(String(e.count), 4)}  avg ${pct(e.avgReturnPct)}`);
      const s = r.stats;
      console.log(`\nSignals ${s.signals}, skipped for no free slot ${s.skippedNoSlot}, too little volume ${s.skippedLiquidity}; ${s.pairsTraded} different coins traded; fees $${s.feesUsd.toFixed(0)}, slippage $${s.slippageUsd.toFixed(0)}.`);
      if (s.btcFilterOpenPct != null) console.log(`The BTC filter allowed buying on ${s.btcFilterOpenPct.toFixed(0)}% of signal closes.`);
      const best = [...r.trades].sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 5);
      const worst = [...r.trades].sort((a, b) => a.pnlUsd - b.pnlUsd).slice(0, 5);
      console.log('\nBest trades:');
      for (const t of best) console.log(`  ${pad(t.symbol, 14)} ${t.entryDate} → ${t.exitDate}  ${lpad(pct(t.returnPct), 9)}  $${t.pnlUsd.toFixed(0)}  (${t.exitReason})`);
      console.log('Worst trades:');
      for (const t of worst) console.log(`  ${pad(t.symbol, 14)} ${t.entryDate} → ${t.exitDate}  ${lpad(pct(t.returnPct), 9)}  $${t.pnlUsd.toFixed(0)}  (${t.exitReason}${t.delisted ? ', delisted' : ''})`);
      if (flags.has('--trades')) for (const t of r.trades) console.log(`  ${pad(t.symbol, 14)} ${t.entryDate} → ${t.exitDate}  ${lpad(pct(t.returnPct), 9)}  ${t.exitReason}`);
      if (r.latestSignals.date) console.log(`\nBreakouts on the last signal close (${r.latestSignals.date}, BTC filter ${r.latestSignals.btcFilterOpen ? 'open' : 'closed'}): ${r.latestSignals.coins.map((c) => c.symbol).join(', ') || 'none'}`);
    }
    if (flags.has('--save')) console.log(`  saved as ${await saveRun(run.name, r, 'cli')}`);
  }
  console.log('\nPast results, not a forecast. Not financial advice.');
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
