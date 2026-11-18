import { isGoldToken, isNonCryptoBeta } from '../../utils/asset-class';

// Which Binance USDT pairs the moon backtest may buy. Everything Binance ever traded
// against USDT is downloaded — dead coins included — except pairs that are not a coin
// you could ride a trend in: stablecoins and fiat, gold, wrapped/staked copies of
// another coin, Binance's old leveraged tokens and tokenized stocks.

/** Binance's leveraged tokens were XXXUP / XXXDOWN on these coins, plus BULL / BEAR pairs. */
const LEVERAGED_ON = new Set(['1INCH', 'AAVE', 'ADA', 'BCH', 'BNB', 'BTC', 'DOT', 'EOS', 'ETH', 'FIL', 'LINK', 'LTC', 'SUSHI', 'SXP', 'TRX', 'UNI', 'XLM', 'XRP', 'XTZ', 'YFI']);
const isLeveraged = (base: string) => {
  if (base.endsWith('BULL') || base.endsWith('BEAR')) return true;
  const m = /^(.+?)(UP|DOWN)$/.exec(base);
  return !!m && LEVERAGED_ON.has(m[1]);
};

/** Fiat currencies and dollar tokens Binance listed against USDT (on top of the shared stablecoin list). */
const FIAT_AND_DOLLARS = new Set([
  'EUR', 'GBP', 'AUD', 'BRL', 'TRY', 'RUB', 'NGN', 'UAH', 'ZAR', 'IDRT', 'BIDR', 'BVND', 'BKRW', 'AEUR', 'EURI',
  'PAX', 'USDSB', 'SUSD', 'XUSD', 'UST', 'USDP', 'BUSD', 'TUSD', 'FDUSD', 'USDC', 'DAI', 'USD1'
]);

/** Copies of another coin: wrapped or liquid-staked. */
const WRAPPED = new Set(['WBTC', 'WBETH', 'BETH', 'BNSOL', 'STETH', 'WSTETH', 'CBBTC', 'BTCB']);

/** Tokenized stocks and ETFs Binance lists as <ticker>B. */
const STOCKS = new Set([
  'AAOIB', 'AAPLB', 'ADBEB', 'AGPUB', 'ALABB', 'AMATB', 'AMCB', 'AMDB', 'AMZNB', 'ARMB', 'ASMLB', 'ASTSB', 'AVGOB',
  'COINB', 'GOOGLB', 'METAB', 'MSFTB', 'MSTRB', 'NFLXB', 'NVDAB', 'PLTRB', 'QQQB', 'SPYB', 'SQQQB', 'TQQQB', 'TSLAB'
]);

export const BENCHMARK = 'BTCUSDT';

/** The base coin of a USDT pair, or null for other quotes. */
export const baseOf = (symbol: string): string | null => (symbol.endsWith('USDT') && symbol.length > 4 ? symbol.slice(0, -4) : null);

/** Whether the backtest downloads this pair at all (BTC is kept as the benchmark). */
export const wantPair = (symbol: string): boolean => {
  const base = baseOf(symbol);
  if (!base) return false;
  if (symbol === BENCHMARK) return true;
  return !(
    isLeveraged(base) ||
    FIAT_AND_DOLLARS.has(base) ||
    WRAPPED.has(base) ||
    STOCKS.has(base) ||
    isNonCryptoBeta({ symbol: base }) ||
    isGoldToken({ symbol: base })
  );
};

/** Whether the strategy may buy this pair (everything downloaded except the benchmark). */
export const canBuy = (symbol: string): boolean => symbol !== BENCHMARK && wantPair(symbol);
