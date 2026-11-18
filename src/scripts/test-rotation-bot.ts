/**
 * Rotation bot — tests for the pure parts (sizing, planning, ledger booking).
 * Run:  npm run test:bot
 * No network, no Binance, no database — exits non-zero on any failure.
 */
import { decide } from '../services/rotation-backtest/engine';
import type { OrderResult } from '../services/rotation-bot/binance';
import { applyBuy, applySell, newLedger, reconcile } from '../services/rotation-bot/ledger';
import { buyAmounts, pickUniverse, planFollow, planReview, reviewStatus, STYLES, topUpBuys } from '../services/rotation-bot/planner';
import { buildSnapshot } from '../services/rotation-bot/snapshot';
import { floorToStep, fromUnits, isTradablePair, rulesFor, sizeBuy, sizeSell, toUnits, type BinanceSymbol } from '../services/rotation-bot/sizing';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const sym = (base: string, step = '0.10000000', minQty = '0.10000000', minNotional = '5.00000000', extra: Partial<BinanceSymbol> = {}): BinanceSymbol => ({
  symbol: `${base}USDT`,
  status: 'TRADING',
  baseAsset: base,
  quoteAsset: 'USDT',
  orderTypes: ['LIMIT', 'MARKET'],
  quoteOrderQtyMarketAllowed: true,
  isSpotTradingAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty, maxQty: '9000000.00000000', stepSize: step },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '4946251.16443514', stepSize: '0.00000000' },
    { filterType: 'NOTIONAL', minNotional, applyMinToMarket: true, maxNotional: '9000000.00000000', applyMaxToMarket: false, avgPriceMins: 5 }
  ],
  ...extra
});

console.log('fixed-point sizing');
{
  check('0.3 floors to 0.3 on a 0.1 step (no float drift)', floorToStep('0.3', '0.1') === '0.3', floorToStep('0.3', '0.1'));
  check('0.1 + 0.2 as a number still floors to 0.3', floorToStep(0.1 + 0.2, '0.1') === '0.3', floorToStep(0.1 + 0.2, '0.1'));
  check('never rounds up past the balance', floorToStep('1234.56789', '0.001') === '1234.567');
  check('integer step', floorToStep('15.9', '1.00000000') === '15');
  check('huge quantities stay exact (BigInt)', floorToStep('123456789012.12345678', '0.01') === '123456789012.12');
  check('round trip', fromUnits(toUnits('0.00000001')) === '0.00000001' && fromUnits(toUnits('42')) === '42');
}

console.log('symbol rules');
{
  const r = rulesFor(sym('TRX'));
  check('uses LOT_SIZE step when MARKET_LOT_SIZE step is 0', r.stepSize === '0.10000000');
  check('reads NOTIONAL minimum', r.minNotional === 5);
  check('market max qty from MARKET_LOT_SIZE', r.maxMarketQty === '4946251.16443514');
  const legacy = rulesFor({ ...sym('OLD'), filters: [{ filterType: 'LOT_SIZE', minQty: '1', maxQty: '100', stepSize: '1' }, { filterType: 'MIN_NOTIONAL', minNotional: '10', applyToMarket: true }] });
  check('reads legacy MIN_NOTIONAL', legacy.minNotional === 10);
  check('tradable pair', isTradablePair(sym('TRX')));
  check('halted pair is not tradable', !isTradablePair(sym('TRX', undefined, undefined, undefined, { status: 'BREAK' })));
  check('non-USDT pair is not tradable', !isTradablePair({ ...sym('TRX'), quoteAsset: 'BTC' }));
}

console.log('order checks');
{
  const r = rulesFor(sym('TRX'));
  const sell = sizeSell(r, '1000.37', 0.3);
  check('sell rounds down to the step', sell.ok && sell.value === '1000.3', JSON.stringify(sell));
  check('sell below the 5 USDT minimum is refused', !sizeSell(r, '10', 0.3).ok);
  check('sell below min qty is refused', !sizeSell(r, '0.05', 1000).ok);
  const buy = sizeBuy(r, 333.3399, 0.3);
  check('buy rounds USDT down to cents', buy.ok && buy.value === '333.33', JSON.stringify(buy));
  check('buy below the minimum is refused', !sizeBuy(r, 4.99, 0.3).ok);
}

console.log('review schedule');
{
  check('first run is a review', reviewStatus(null, '2026-11-11', 7).due);
  const s = reviewStatus('2026-11-11', '2026-11-15', 7);
  check('not due mid-week', !s.due && s.nextReview === '2026-11-18' && s.daysLeft === 3, JSON.stringify(s));
  check('due on the day', reviewStatus('2026-11-11', '2026-11-18', 7).due);
  check('late runs still review', reviewStatus('2026-11-11', '2026-11-25', 7).due);
}

console.log('universe');
{
  const coins = ['bitcoin', 'leo-token', 'monero', 'tron', 'fake-ticker', 'ethereum'].map((id, i) => ({
    id,
    symbol: { bitcoin: 'BTC', 'leo-token': 'LEO', monero: 'XMR', tron: 'TRX', 'fake-ticker': 'ABC', ethereum: 'ETH' }[id]!,
    name: id,
    image: null,
    rank: i + 1
  }));
  const prices: Record<string, (number | null)[]> = { bitcoin: [70000], 'leo-token': [9], monero: [300], tron: [0.3], 'fake-ticker': [2], ethereum: [2000] };
  const pairs = new Map(['BTC', 'TRX', 'ABC', 'ETH'].map((b) => [b, rulesFor(sym(b))]));
  const live = new Map([
    ['BTCUSDT', 71000],
    ['TRXUSDT', 0.31],
    ['ABCUSDT', 0.02], // same ticker, a different token at 1% of the price
    ['ETHUSDT', 2050]
  ]);
  const u = pickUniverse(coins, prices, 0, pairs, live, 3);
  check('keeps market-cap order and skips coins Binance does not list', u.picked.map((c) => c.asset).join() === 'BTC,TRX,ETH', u.picked.map((c) => c.asset).join());
  check('skips LEO and XMR (no USDT pair)', u.skipped.filter((s) => s.reason.startsWith('no USDT')).map((s) => s.asset).join() === 'LEO,XMR');
  check('skips a ticker whose Binance price is far off (different token)', u.skipped.some((s) => s.asset === 'ABC'));
}

console.log('review plan');
{
  const style = STYLES.balanced; // topN 3, band 5
  const ranking = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((coin, i) => ({ coin, rank: i + 1, score: 1 - i / 10 }));
  const universe = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const p = planReview(['b', 'e', 'g'], ranking, universe, style);
  check('keeps holdings inside the hold band (b #2, e #5)', p.keep.join() === 'b,e');
  check('sells the one ranked #7', p.drops.length === 1 && p.drops[0].coin === 'g' && p.drops[0].reason === 'fell out of the hold band');
  check('fills the free slot with the best coin not held', p.adds.join() === 'a');
  const same = decide(['b', 'e', 'g'], ranking, style);
  check('same answer as the Rotation Lab engine', same.adds.join() === p.adds.join() && same.keep.join() === p.keep.join());
  const gone = planReview(['zzz'], ranking, universe, style);
  check('a holding that left the universe is sold with that reason', gone.drops[0]?.reason === 'left the universe');
}

console.log('follow the index');
{
  const p = planFollow(['tron', 'tether-gold', 'zcash'], ['tron', 'zcash', 'hyperliquid']);
  check('follow: keeps what the index still holds', JSON.stringify(p.keep) === '["tron","zcash"]', JSON.stringify(p.keep));
  check('follow: sells what the index sold', p.drops.length === 1 && p.drops[0].coin === 'tether-gold' && p.drops[0].reason === 'the index sold it', JSON.stringify(p.drops));
  check('follow: buys what the index bought', JSON.stringify(p.adds) === '["hyperliquid"]', JSON.stringify(p.adds));
  const start = planFollow([], ['tron', 'zcash', 'tether-gold']);
  check('follow: a new sleeve buys the whole line-up in the index order', JSON.stringify(start.adds) === '["tron","zcash","tether-gold"]' && !start.drops.length);
  const same = planFollow(['zcash', 'tron'], ['tron', 'zcash']);
  check('follow: a sleeve that matches the index does nothing', !same.drops.length && !same.adds.length);
  const cash = planFollow(['tron'], []);
  check('follow: an all-cash index sells everything', cash.drops.length === 1 && !cash.adds.length);
  const buys = buyAmounts(start.adds, 100, 100, 3, 3);
  check('follow: a new 100 USDT sleeve puts a third in each coin', buys.length === 3 && buys.every((b) => Math.abs(b.amount - 100 / 3) < 1e-9), JSON.stringify(buys));
}

console.log('buy sizing');
{
  const b = buyAmounts(['a', 'b'], 1000, 1000, 3, 3);
  check('each new slot gets 1/topN of equity', b.length === 2 && Math.abs(b[0].amount - 333.333) < 0.01 && Math.abs(b[1].amount - 333.333) < 0.01);
  const tight = buyAmounts(['a', 'b'], 400, 1000, 3, 2);
  check('never spends more cash than the sleeve has', tight.reduce((s, x) => s + x.amount, 0) <= 400 + 1e-9 && tight[1].amount < 70);
  check('respects free slots', buyAmounts(['a', 'b', 'c'], 1000, 1000, 3, 1).length === 1);

  // Top-up: 100 USDT more on a 3-coin sleeve worth ~100 → about 33.3 more of each.
  const w = new Map([['a', 33.4], ['b', 33.3], ['c', 33.3]]);
  const even = topUpBuys([{ coin: 'a', value: 33.4 }, { coin: 'b', value: 33.3 }, { coin: 'c', value: 33.3 }], w, 100, 200);
  check('top-up spreads the cash by index weight', even.length === 3 && Math.abs(even.reduce((x, b) => x + b.amount, 0) - 100) < 1e-6 && Math.abs(even[0].amount - 33.4) < 1e-6);
  // A coin that ran ahead of its weight gets less, one that lagged gets more.
  const drift = topUpBuys([{ coin: 'a', value: 50 }, { coin: 'b', value: 25 }, { coin: 'c', value: 25 }], new Map([['a', 33.33], ['b', 33.33], ['c', 33.34]]), 50, 150);
  check('top-up fills the coins below their weight first', drift.find((b) => b.coin === 'a') === undefined && Math.abs(drift.reduce((x, b) => x + b.amount, 0) - 50) < 1e-6);
  const tightCash = topUpBuys([{ coin: 'a', value: 10 }, { coin: 'b', value: 10 }], new Map([['a', 50], ['b', 50]]), 5, 120);
  check('top-up never spends more than the cash', Math.abs(tightCash.reduce((x, b) => x + b.amount, 0) - 5) < 1e-6);
  check('top-up with no cash buys nothing', topUpBuys([{ coin: 'a', value: 10 }], new Map([['a', 100]]), 0, 10).length === 0);
}

console.log('ledger booking');
{
  const rules = rulesFor(sym('TRX'));
  const l = newLedger('testnet', 'balanced', 1000);
  const buy: OrderResult = {
    symbol: 'TRXUSDT',
    orderId: 1,
    clientOrderId: 'x',
    status: 'FILLED',
    executedQty: '1000.0',
    cummulativeQuoteQty: '300.00',
    fills: [{ price: '0.3', qty: '1000.0', commission: '1.0', commissionAsset: 'TRX' }]
  };
  applyBuy(l, 'tron', rules, buy, '2026-11-11', 'test');
  check('buy: cash falls by the USDT spent', l.cashUsdt === 700);
  check('buy: fee in the coin is taken from the quantity', l.positions.tron?.qty === '999', l.positions.tron?.qty);
  const bnbBuy = { ...buy, orderId: 2, fills: [{ price: '0.3', qty: '1000.0', commission: '0.0004', commissionAsset: 'BNB' }] };
  applyBuy(l, 'tron', rules, bnbBuy, '2026-11-11', 'test');
  check('buy: fee in BNB is tracked outside the sleeve', l.positions.tron?.qty === '1999' && l.feesBnb === 0.0004);

  const sell: OrderResult = {
    symbol: 'TRXUSDT',
    orderId: 3,
    clientOrderId: 'y',
    status: 'FILLED',
    executedQty: '1999.0',
    cummulativeQuoteQty: '620.00',
    fills: [{ price: '0.31', qty: '1999.0', commission: '0.62', commissionAsset: 'USDT' }]
  };
  applySell(l, 'tron', rules, sell, 0.31, 'test');
  check('sell: cash rises by proceeds minus the USDT fee', Math.abs(l.cashUsdt - (400 + 619.38)) < 1e-9, String(l.cashUsdt));
  check('sell: position closed', !l.positions.tron);

  const l2 = newLedger('testnet', 'balanced', 1000);
  applyBuy(l2, 'tron', rules, { ...buy, fills: [] }, '2026-11-11', 'test');
  applySell(l2, 'tron', rules, { ...sell, executedQty: '999.9', cummulativeQuoteQty: '309.97', fills: [] }, 0.31, 'test');
  check('sell: a leftover too small to sell goes to dust', !l2.positions.tron && l2.dust.TRX === '0.1', JSON.stringify(l2.dust));

  const l3 = newLedger('testnet', 'balanced', 1000);
  applyBuy(l3, 'tron', rules, { ...buy, fills: [] }, '2026-11-11', 'test');
  applyBuy(l3, 'ethereum', rulesFor(sym('ETH', '0.0001', '0.0001')), { ...buy, symbol: 'ETHUSDT', executedQty: '0.1', fills: [] }, '2026-11-11', 'test');
  const w = reconcile(l3, new Map([['TRX', '400']]));
  check('reconcile: cuts a position to what the account holds', l3.positions.tron?.qty === '400' && w.length === 2);
  check('reconcile: drops a position the account no longer has', !l3.positions.ethereum);
}

console.log('admin snapshot');
{
  const l = newLedger('live', 'balanced', 100, new Date('2026-11-19T06:00:00Z'));
  l.follow = 'rotation-balanced';
  l.cashUsdt = 0.5;
  l.positions.tron = { coin: 'tron', asset: 'TRX', symbol: 'TRXUSDT', qty: '100', entryDate: '2026-11-19', costUsdt: 33 };
  const prices = new Map([['TRXUSDT', 0.3], ['SOLUSDT', 70]]);
  const balances = new Map([
    ['USDT', { asset: 'USDT', free: '67.5', locked: '0' }],
    ['TRX', { asset: 'TRX', free: '100', locked: '0' }],
    ['SOL', { asset: 'SOL', free: '0.001', locked: '0' }],
    ['LDUSDT', { asset: 'LDUSDT', free: '0.1', locked: '0' }],
    ['XRP', { asset: 'XRP', free: '0', locked: '0' }]
  ]);
  const snap = buildSnapshot({ ledger: l, started: true, prices, balances, status: 'test', index: { id: 'rotation-balanced', date: '2026-11-18' }, nextReview: '2026-11-24', now: new Date('2026-11-19T06:05:00Z') });
  check('snapshot: sleeve value is cash plus coins at Binance prices', snap.equity_usdt === 30.5, String(snap.equity_usdt));
  check('snapshot: return is on the budget', snap.return_pct === -69.5, String(snap.return_pct));
  check('snapshot: a position carries its value and return', snap.positions[0].value_usdt === 30 && snap.positions[0].return_pct === -9.09, JSON.stringify(snap.positions[0]));
  check('snapshot: Spot wallet skips empty coins, biggest first, unpriced last', snap.spot?.assets.map((x) => x.asset).join(',') === 'USDT,TRX,SOL,LDUSDT', snap.spot?.assets.map((x) => x.asset).join(','));
  check('snapshot: Spot total counts priced coins only', snap.spot?.total_usdt === 97.57, String(snap.spot?.total_usdt));
  check('snapshot: date and follow are kept', snap.taken_at.startsWith('2026-11-19') && snap.follow === 'rotation-balanced' && snap.started_on === '2026-11-19');
  const waiting = buildSnapshot({ ledger: newLedger('live', 'balanced', 100), started: false, prices, balances: null, status: 'waiting', index: null, nextReview: null });
  check('snapshot: before the first buy there is no value line yet', waiting.equity_usdt === null && waiting.return_pct === null && waiting.spot === null);
}

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll rotation bot tests passed.');
process.exit(failures ? 1 : 0);
