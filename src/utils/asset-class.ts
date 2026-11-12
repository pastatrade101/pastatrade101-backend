// Coins that are not crypto beta: dollar/euro stablecoins, gold tokens and
// tokenized funds (T-bills, money market, credit, HELOCs). Measured against BTC
// they "outperform" every time BTC falls, so they must stay out of breadth,
// altcoin-season, leader/bleeder and mover lists. One definition for the whole
// backend — the per-file lists had drifted and missed the newer dollar tokens.
const NON_BETA_SYMBOLS = new Set([
  // Dollar / euro stablecoins
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'USDS', 'GUSD', 'USDP', 'FRAX', 'LUSD',
  'USD0', 'USDG', 'USD1', 'RLUSD', 'USDB', 'USDF', 'U', 'BFUSD', 'USDGO', 'OUSD', 'GHO', 'USDTB', 'USDX', 'CRVUSD',
  'DOLA', 'USR', 'AUSD', 'USDO', 'USDAI', 'SUSDE', 'SUSDS', 'REUSD', 'EURT', 'EURC', 'EURS',
  // Gold tokens
  'XAUT', 'PAXG',
  // Tokenized funds / yield-bearing dollars
  'USDY', 'USYC', 'BUIDL', 'USTB', 'JAAA', 'EURSAFO', 'FIGR_HELOC', 'OUSG', 'BENJI'
]);

const NON_BETA_NAME = /\busd\b|\bdollar\b|\beuro?\b|stablecoin|\bgold\b|treasury|treasuries|t-?bill|money market|\bfund\b|heloc|\bclo\b/i;

export interface AssetLike {
  symbol?: string | null;
  name?: string | null;
  current_price?: number | null;
  price_change_pct_30d?: number | null;
}

export const isNonCryptoBeta = (c: AssetLike): boolean => {
  if (NON_BETA_SYMBOLS.has((c.symbol ?? '').toUpperCase())) return true;
  if (c.name && NON_BETA_NAME.test(c.name)) return true;
  // A dollar stablecoin we have not listed yet: priced at $1 and flat for a month.
  const p = c.current_price;
  const d30 = c.price_change_pct_30d;
  return p != null && d30 != null && p > 0.97 && p < 1.03 && Math.abs(d30) < 1.5;
};
