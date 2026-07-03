// ─────────────────────────────────────────────────────────────────────────────
// Token Position Radar — supported chains. Adding a chain = adding one entry
// here (plus a GoPlus chain-id mapping in goplus.client if it's EVM).
// ─────────────────────────────────────────────────────────────────────────────

export type ChainSlug = 'ethereum' | 'bsc' | 'solana' | 'base' | 'arbitrum' | 'polygon' | 'avalanche';

export interface ChainConfig {
  slug: ChainSlug;
  name: string;
  chainId: number | null; // EVM chain id (null for non-EVM)
  nativeCurrency: string;
  addressKind: 'evm' | 'solana';
  explorerUrl: string; // token page prefix
  dexscreenerId: string; // DexScreener chainId value
  goplusNetwork: string | null; // network key understood by goplus.client (null = no risk data)
}

export const CHAINS: Record<ChainSlug, ChainConfig> = {
  ethereum: { slug: 'ethereum', name: 'Ethereum', chainId: 1, nativeCurrency: 'ETH', addressKind: 'evm', explorerUrl: 'https://etherscan.io/token/', dexscreenerId: 'ethereum', goplusNetwork: 'ethereum' },
  bsc: { slug: 'bsc', name: 'BNB Chain', chainId: 56, nativeCurrency: 'BNB', addressKind: 'evm', explorerUrl: 'https://bscscan.com/token/', dexscreenerId: 'bsc', goplusNetwork: 'bsc' },
  solana: { slug: 'solana', name: 'Solana', chainId: null, nativeCurrency: 'SOL', addressKind: 'solana', explorerUrl: 'https://solscan.io/token/', dexscreenerId: 'solana', goplusNetwork: 'solana' },
  base: { slug: 'base', name: 'Base', chainId: 8453, nativeCurrency: 'ETH', addressKind: 'evm', explorerUrl: 'https://basescan.org/token/', dexscreenerId: 'base', goplusNetwork: 'base' },
  arbitrum: { slug: 'arbitrum', name: 'Arbitrum', chainId: 42161, nativeCurrency: 'ETH', addressKind: 'evm', explorerUrl: 'https://arbiscan.io/token/', dexscreenerId: 'arbitrum', goplusNetwork: 'arbitrum' },
  polygon: { slug: 'polygon', name: 'Polygon', chainId: 137, nativeCurrency: 'POL', addressKind: 'evm', explorerUrl: 'https://polygonscan.com/token/', dexscreenerId: 'polygon', goplusNetwork: 'polygon' },
  avalanche: { slug: 'avalanche', name: 'Avalanche', chainId: 43114, nativeCurrency: 'AVAX', addressKind: 'evm', explorerUrl: 'https://snowtrace.io/token/', dexscreenerId: 'avalanche', goplusNetwork: 'avalanche' }
};

export const chainOf = (slug: string): ChainConfig | null => (CHAINS as Record<string, ChainConfig>)[slug?.toLowerCase()] ?? null;

const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, no 0/O/I/l

/** Does `input` look like a valid token address for this chain? */
export const isValidAddress = (chain: ChainConfig, input: string): boolean =>
  chain.addressKind === 'evm' ? EVM_ADDR.test(input.trim()) : SOLANA_ADDR.test(input.trim());

/** Does `input` look like ANY address (used to reject an address pasted on the wrong chain)? */
export const looksLikeAddress = (input: string): boolean => EVM_ADDR.test(input.trim()) || SOLANA_ADDR.test(input.trim());
