// Binance order sizing — pure functions, no I/O.
//
// Binance rejects any order that breaks a symbol's filters (quantity step, minimum
// quantity, minimum order value). Quantities are handled as 8-decimal fixed point
// (BigInt) so rounding a balance down to the step never produces float noise like
// 0.30000000000000004, and never rounds UP past what the account actually holds.

const DECIMALS = 8;
const SCALE = 10n ** BigInt(DECIMALS);

/** Decimal string or number → 8-decimal fixed-point units. */
export const toUnits = (v: string | number): bigint => {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(DECIMALS) : '0') : v.trim();
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int = '0', frac = ''] = body.split('.');
  const u = BigInt(int || '0') * SCALE + BigInt((frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS) || '0');
  return neg ? -u : u;
};

/** Fixed-point units → plain decimal string without trailing zeros ("1.5", "300"). */
export const fromUnits = (u: bigint): string => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const frac = (a % SCALE).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / SCALE}${frac ? `.${frac}` : ''}`;
};

/** Round a quantity DOWN to a multiple of the step ("0.1", "0.001", "1"). */
export const floorToStep = (qty: string | number, step: string): string => {
  const q = toUnits(qty);
  const s = toUnits(step);
  if (q <= 0n) return '0';
  if (s <= 0n) return fromUnits(q);
  return fromUnits(q - (q % s));
};

export interface BinanceFilter {
  filterType: string;
  [key: string]: unknown;
}

export interface BinanceSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  orderTypes: string[];
  quoteOrderQtyMarketAllowed?: boolean;
  isSpotTradingAllowed?: boolean;
  filters: BinanceFilter[];
}

export interface SymbolRules {
  symbol: string;
  base: string;
  quote: string;
  /** Quantity step for market orders. */
  stepSize: string;
  minQty: string;
  /** Largest market-order quantity, when Binance sets one. */
  maxMarketQty: string | null;
  /** Smallest order value in the quote asset (USDT) that applies to market orders. */
  minNotional: number;
}

const positive = (v: unknown): string | null => (typeof v === 'string' && toUnits(v) > 0n ? v : null);

export const rulesFor = (s: BinanceSymbol): SymbolRules => {
  const f = (type: string) => s.filters.find((x) => x.filterType === type);
  const lot = f('LOT_SIZE');
  const marketLot = f('MARKET_LOT_SIZE');
  const notional = f('NOTIONAL');
  const legacyNotional = f('MIN_NOTIONAL');
  // LOT_SIZE applies to every order; MARKET_LOT_SIZE adds market-only limits ("0" = unset).
  const minNotional =
    notional && notional.applyMinToMarket !== false
      ? Number(notional.minNotional)
      : legacyNotional && legacyNotional.applyToMarket !== false
        ? Number(legacyNotional.minNotional)
        : 0;
  return {
    symbol: s.symbol,
    base: s.baseAsset,
    quote: s.quoteAsset,
    stepSize: positive(lot?.stepSize) ?? positive(marketLot?.stepSize) ?? '0.00000001',
    minQty: positive(lot?.minQty) ?? positive(marketLot?.minQty) ?? '0',
    maxMarketQty: positive(marketLot?.maxQty) ?? positive(lot?.maxQty),
    minNotional: Number.isFinite(minNotional) ? minNotional : 0
  };
};

/** A spot pair the bot can trade with market orders sized in USDT. */
export const isTradablePair = (s: BinanceSymbol, quote = 'USDT'): boolean =>
  s.quoteAsset === quote &&
  s.status === 'TRADING' &&
  s.orderTypes.includes('MARKET') &&
  s.isSpotTradingAllowed !== false &&
  s.quoteOrderQtyMarketAllowed !== false;

export type Sized = { ok: true; value: string } | { ok: false; reason: string };

const usdt = (n: number) => `${n.toFixed(2)} USDT`;

/** Market SELL quantity for `qty` held: rounded down to the step, checked against the minimums. */
export const sizeSell = (r: SymbolRules, qty: string, price: number): Sized => {
  const q = floorToStep(qty, r.stepSize);
  const units = toUnits(q);
  if (units <= 0n || units < toUnits(r.minQty)) {
    return { ok: false, reason: `${qty} ${r.base} is below Binance's minimum quantity (${r.minQty})` };
  }
  const value = Number(q) * price;
  if (value < r.minNotional) return { ok: false, reason: `worth ${usdt(value)}, below Binance's ${usdt(r.minNotional)} minimum` };
  if (r.maxMarketQty && units > toUnits(r.maxMarketQty)) {
    return { ok: false, reason: `${q} ${r.base} is above Binance's market-order limit (${r.maxMarketQty})` };
  }
  return { ok: true, value: q };
};

/** Market BUY amount in USDT (quoteOrderQty), rounded down to cents and checked against the minimums. */
export const sizeBuy = (r: SymbolRules, amount: number, price: number): Sized => {
  const cents = Math.floor(amount * 100) / 100;
  if (!(cents > 0) || cents < r.minNotional) return { ok: false, reason: `${usdt(Math.max(0, cents))} is below Binance's ${usdt(r.minNotional)} minimum` };
  const estQty = cents / price;
  if (toUnits(estQty) < toUnits(r.minQty)) return { ok: false, reason: `${usdt(cents)} buys less than Binance's minimum quantity (${r.minQty} ${r.base})` };
  if (r.maxMarketQty && toUnits(estQty) > toUnits(r.maxMarketQty)) {
    return { ok: false, reason: `${usdt(cents)} is above Binance's market-order limit for ${r.symbol}` };
  }
  return { ok: true, value: cents.toFixed(2) };
};
