import { fetchJson } from './http';

// GoPlus Security public API — no key required (free tier). Token security
// screening so the Radar's Risk Score is grounded, not guessed. Graceful.
const BASE = 'https://api.gopluslabs.io/api/v1';

// GeckoTerminal network slug → GoPlus EVM chain id.
const EVM_CHAIN: Record<string, string> = {
  eth: '1',
  ethereum: '1',
  bsc: '56',
  'binance-smart-chain': '56',
  polygon_pos: '137',
  polygon: '137',
  arbitrum: '42161',
  arbitrum_one: '42161',
  optimism: '10',
  avax: '43114',
  avalanche: '43114',
  base: '8453'
};

export interface TokenSecurity {
  checked: boolean;
  is_honeypot: boolean | null;
  buy_tax: number | null;
  sell_tax: number | null;
  is_open_source: boolean | null;
  mintable: boolean | null;
  freezable: boolean | null;
}

const UNKNOWN: TokenSecurity = { checked: false, is_honeypot: null, buy_tax: null, sell_tax: null, is_open_source: null, mintable: null, freezable: null };

const get = async <T>(u: string): Promise<T | null> => {
  try {
    return await fetchJson<T>(u, { headers: { accept: 'application/json' }, label: 'goplus', retries: 1 });
  } catch {
    return null;
  }
};

const bool = (v: unknown): boolean | null => (v === '1' || v === 1 ? true : v === '0' || v === 0 ? false : null);
const taxNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const networkToChainId = (network: string | null | undefined): string | null => (network ? EVM_CHAIN[network] ?? null : null);

/** Batch token security for one EVM chain (many contracts per call). */
const evmSecurity = async (chainId: string, contracts: string[]): Promise<Record<string, TokenSecurity>> => {
  if (!contracts.length) return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await get<{ result: Record<string, any> }>(`${BASE}/token_security/${chainId}?contract_addresses=${contracts.join(',')}`);
  const out: Record<string, TokenSecurity> = {};
  for (const [addr, v] of Object.entries(d?.result ?? {})) {
    out[addr.toLowerCase()] = {
      checked: true,
      is_honeypot: bool(v?.is_honeypot),
      buy_tax: taxNum(v?.buy_tax),
      sell_tax: taxNum(v?.sell_tax),
      is_open_source: bool(v?.is_open_source),
      mintable: bool(v?.is_mintable ?? v?.mintable),
      freezable: bool(v?.transfer_pausable)
    };
  }
  return out;
};

/** Solana token security (different schema — no honeypot field; map authorities). */
const solanaSecurity = async (contracts: string[]): Promise<Record<string, TokenSecurity>> => {
  if (!contracts.length) return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await get<{ result: Record<string, any> }>(`${BASE}/solana/token_security?contract_addresses=${contracts.join(',')}`);
  const out: Record<string, TokenSecurity> = {};
  for (const [addr, v] of Object.entries(d?.result ?? {})) {
    out[addr] = {
      checked: true,
      is_honeypot: null,
      buy_tax: null,
      sell_tax: null,
      is_open_source: null,
      mintable: bool(v?.mintable?.status),
      freezable: bool(v?.freezable?.status)
    };
  }
  return out;
};

/**
 * Screen a batch of tokens grouped by network. Returns a map keyed by
 * `${network}:${contractLower}`. Unsupported networks return `checked:false`.
 */
export const screenTokens = async (tokens: { network: string; contract: string }[]): Promise<Record<string, TokenSecurity>> => {
  const out: Record<string, TokenSecurity> = {};
  const byChain = new Map<string, string[]>(); // chainId -> contracts
  const solana: string[] = [];
  for (const t of tokens) {
    if (!t.contract) continue;
    if (t.network === 'solana') solana.push(t.contract);
    else {
      const chainId = networkToChainId(t.network);
      if (chainId) byChain.set(chainId, [...(byChain.get(chainId) ?? []), t.contract.toLowerCase()]);
    }
  }
  const results = await Promise.all([
    ...[...byChain.entries()].map(async ([chainId, contracts]) => ({ chainId, sec: await evmSecurity(chainId, [...new Set(contracts)]) })),
    solana.length ? solanaSecurity([...new Set(solana)]).then((sec) => ({ chainId: 'solana', sec })) : Promise.resolve({ chainId: 'solana', sec: {} as Record<string, TokenSecurity> })
  ]);
  // Map back per token (best-effort; missing → UNKNOWN).
  for (const t of tokens) {
    if (!t.contract) continue;
    const key = `${t.network}:${t.contract.toLowerCase()}`;
    if (t.network === 'solana') {
      const found = results.find((r) => r.chainId === 'solana')?.sec[t.contract];
      out[key] = found ?? UNKNOWN;
    } else {
      const chainId = networkToChainId(t.network);
      const found = chainId ? results.find((r) => r.chainId === chainId)?.sec[t.contract.toLowerCase()] : undefined;
      out[key] = found ?? UNKNOWN;
    }
  }
  return out;
};
