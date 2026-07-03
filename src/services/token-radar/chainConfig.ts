// ─────────────────────────────────────────────────────────────────────────────
// Token Position Radar — chain configuration system. Every supported network is
// ONE entry here (nothing is hardcoded in the UI): key, type, ids, explorer,
// provider mappings, validation and support status. Adding a chain = adding an
// entry (+ a GoPlus chain-id mapping in goplus.client if it's EVM).
//
// status semantics:
//   active      → full support: metadata, DEX pairs, price/liquidity, holder +
//                 contract/security data (where providers respond), listings.
//   limited     → metadata + DEX/pair data work; holder/security data may be
//                 missing → the report reduces confidence instead of failing.
//   coming_soon → visible in the selector but not yet analyzable.
// ─────────────────────────────────────────────────────────────────────────────

export type ChainType = 'evm' | 'solana' | 'ton' | 'sui' | 'aptos' | 'tron' | 'near';
export type ChainStatus = 'active' | 'limited' | 'coming_soon';

export interface ChainConfig {
  slug: string; // chain key
  name: string; // display name
  type: ChainType;
  chainId: number | null; // EVM chain id (null for non-EVM)
  nativeCurrency: string;
  explorerUrl: string; // token page prefix
  dexscreenerId: string | null; // DexScreener chain slug (null = no DEX data yet)
  coingeckoPlatform: string | null; // CoinGecko asset-platform id
  goplusNetwork: string | null; // key understood by goplus.client (null = no security data)
  providers: string[]; // which data providers cover this chain
  status: ChainStatus;
  popular?: boolean;
}

const evm = (slug: string, name: string, chainId: number, native: string, explorer: string, o: Partial<ChainConfig> = {}): ChainConfig => ({
  slug, name, type: 'evm', chainId, nativeCurrency: native, explorerUrl: explorer,
  dexscreenerId: slug, coingeckoPlatform: slug, goplusNetwork: slug,
  providers: ['dexscreener', 'goplus', 'coingecko', 'moralis'], status: 'active', ...o
});

export const CHAINS: Record<string, ChainConfig> = {
  // ── Popular ──
  ethereum: evm('ethereum', 'Ethereum', 1, 'ETH', 'https://etherscan.io/token/', { popular: true }),
  bsc: evm('bsc', 'BNB Chain', 56, 'BNB', 'https://bscscan.com/token/', { popular: true, coingeckoPlatform: 'binance-smart-chain' }),
  solana: {
    slug: 'solana', name: 'Solana', type: 'solana', chainId: null, nativeCurrency: 'SOL', explorerUrl: 'https://solscan.io/token/',
    dexscreenerId: 'solana', coingeckoPlatform: 'solana', goplusNetwork: 'solana', providers: ['dexscreener', 'goplus', 'coingecko'], status: 'active', popular: true
  },
  base: evm('base', 'Base', 8453, 'ETH', 'https://basescan.org/token/', { popular: true }),
  arbitrum: evm('arbitrum', 'Arbitrum', 42161, 'ETH', 'https://arbiscan.io/token/', { popular: true, coingeckoPlatform: 'arbitrum-one' }),
  polygon: evm('polygon', 'Polygon', 137, 'POL', 'https://polygonscan.com/token/', { popular: true, coingeckoPlatform: 'polygon-pos' }),
  avalanche: evm('avalanche', 'Avalanche', 43114, 'AVAX', 'https://snowtrace.io/token/', { popular: true }),

  // ── More EVM ──
  optimism: evm('optimism', 'Optimism', 10, 'ETH', 'https://optimistic.etherscan.io/token/', { coingeckoPlatform: 'optimistic-ethereum' }),
  fantom: evm('fantom', 'Fantom', 250, 'FTM', 'https://ftmscan.com/token/', {}),
  sonic: evm('sonic', 'Sonic', 146, 'S', 'https://sonicscan.org/token/', {}),
  cronos: evm('cronos', 'Cronos', 25, 'CRO', 'https://cronoscan.com/token/', {}),
  linea: evm('linea', 'Linea', 59144, 'ETH', 'https://lineascan.build/token/', {}),
  mantle: evm('mantle', 'Mantle', 5000, 'MNT', 'https://mantlescan.xyz/token/', {}),
  blast: evm('blast', 'Blast', 81457, 'ETH', 'https://blastscan.io/token/', {}),
  scroll: evm('scroll', 'Scroll', 534352, 'ETH', 'https://scrollscan.com/token/', {}),
  zksync: evm('zksync', 'zkSync Era', 324, 'ETH', 'https://era.zksync.network/token/', {}),
  celo: evm('celo', 'Celo', 42220, 'CELO', 'https://celoscan.io/token/', {}),
  gnosis: evm('gnosis', 'Gnosis', 100, 'xDAI', 'https://gnosisscan.io/token/', { dexscreenerId: 'gnosischain', coingeckoPlatform: 'xdai' }),
  moonbeam: evm('moonbeam', 'Moonbeam', 1284, 'GLMR', 'https://moonscan.io/token/', {}),
  pulsechain: evm('pulsechain', 'PulseChain', 369, 'PLS', 'https://scan.pulsechain.com/token/', { status: 'limited', providers: ['dexscreener', 'goplus', 'coingecko'] }),

  // ── Non-EVM ──
  ton: {
    slug: 'ton', name: 'TON', type: 'ton', chainId: null, nativeCurrency: 'TON', explorerUrl: 'https://tonviewer.com/',
    dexscreenerId: 'ton', coingeckoPlatform: 'the-open-network', goplusNetwork: null, providers: ['dexscreener', 'coingecko'], status: 'limited'
  },
  sui: {
    slug: 'sui', name: 'Sui', type: 'sui', chainId: null, nativeCurrency: 'SUI', explorerUrl: 'https://suiscan.xyz/mainnet/coin/',
    dexscreenerId: 'sui', coingeckoPlatform: 'sui', goplusNetwork: null, providers: ['dexscreener', 'coingecko'], status: 'limited'
  },
  aptos: {
    slug: 'aptos', name: 'Aptos', type: 'aptos', chainId: null, nativeCurrency: 'APT', explorerUrl: 'https://explorer.aptoslabs.com/coin/',
    dexscreenerId: 'aptos', coingeckoPlatform: 'aptos', goplusNetwork: null, providers: ['dexscreener', 'coingecko'], status: 'limited'
  },
  tron: {
    slug: 'tron', name: 'Tron', type: 'tron', chainId: null, nativeCurrency: 'TRX', explorerUrl: 'https://tronscan.org/#/token20/',
    dexscreenerId: 'tron', coingeckoPlatform: 'tron', goplusNetwork: null, providers: ['dexscreener', 'coingecko'], status: 'limited'
  },
  near: {
    slug: 'near', name: 'NEAR', type: 'near', chainId: null, nativeCurrency: 'NEAR', explorerUrl: 'https://nearblocks.io/token/',
    dexscreenerId: null, coingeckoPlatform: 'near-protocol', goplusNetwork: null, providers: ['coingecko'], status: 'coming_soon'
  }
};

export const chainOf = (slug: string): ChainConfig | null => CHAINS[slug?.toLowerCase()] ?? null;

// ── Address validation per chain type ──
const PATTERNS: Record<ChainType, RegExp> = {
  evm: /^0x[a-fA-F0-9]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, // base58
  ton: /^(?:[EU]Q[A-Za-z0-9_-]{46}|0:[a-fA-F0-9]{64})$/,
  sui: /^0x[a-fA-F0-9]{1,64}(::\w+::\w+)?$/, // coin type or object id
  aptos: /^0x[a-fA-F0-9]{1,64}(::\w+::\w+)?$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  near: /^(?:[a-z0-9_-]+\.)+near$|^[a-f0-9]{64}$/
};

/** Does `input` look like a valid token address for this chain? */
export const isValidAddress = (chain: ChainConfig, input: string): boolean => PATTERNS[chain.type].test(input.trim());

/**
 * Does `input` look like ANY supported address format (vs a ticker)?
 * Short alphanumeric strings (≤12 chars) are treated as tickers — every real
 * address format below is either prefixed (0x/T/EQ/.near) or ≥32 chars base58.
 */
export const looksLikeAddress = (input: string): boolean => {
  const v = input.trim();
  if (PATTERNS.evm.test(v) || PATTERNS.ton.test(v) || PATTERNS.tron.test(v)) return true;
  if (PATTERNS.sui.test(v) && v.length > 12) return true; // sui/aptos coin types & object ids
  if (PATTERNS.near.test(v)) return true; // *.near or 64-hex
  return PATTERNS.solana.test(v) && v.length >= 32; // long base58
};

/** Chain types whose pattern matches `input` — used by auto-detect. */
export const matchingChainTypes = (input: string): ChainType[] =>
  (Object.entries(PATTERNS) as [ChainType, RegExp][]).filter(([, re]) => re.test(input.trim())).map(([t]) => t);
