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

// ─────────────────────────────────────────────────────────────────────────────
// Rich per-token security detail — used by the Token Position Radar. Separate
// from screenTokens (EOR batch path) so both evolve independently. Graceful:
// unavailable data comes back null and the caller lowers confidence.
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenSecurityDetail {
  checked: boolean;
  // trading safety
  is_honeypot: boolean | null;
  cannot_sell_all: boolean | null;
  buy_tax: number | null; // 0–1 fraction
  sell_tax: number | null;
  // contract properties
  is_open_source: boolean | null;
  is_proxy: boolean | null;
  mintable: boolean | null;
  freezable: boolean | null; // transfer pausable / freeze authority
  has_blacklist: boolean | null;
  hidden_owner: boolean | null;
  can_take_back_ownership: boolean | null;
  owner_change_balance: boolean | null;
  selfdestruct: boolean | null;
  // holders / liquidity
  holder_count: number | null;
  top10_percent: number | null; // 0–100
  creator_percent: number | null; // 0–100
  lp_locked_percent: number | null; // 0–100 (share of LP locked/burned)
}

const DETAIL_UNKNOWN: TokenSecurityDetail = {
  checked: false,
  is_honeypot: null, cannot_sell_all: null, buy_tax: null, sell_tax: null,
  is_open_source: null, is_proxy: null, mintable: null, freezable: null,
  has_blacklist: null, hidden_owner: null, can_take_back_ownership: null,
  owner_change_balance: null, selfdestruct: null,
  holder_count: null, top10_percent: null, creator_percent: null, lp_locked_percent: null
};

const pct = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n * 100)) : null;
};

// Real-wallet concentration: exclude contracts (staking/LP/MasterChef/router) and
// locked/burn addresses — otherwise legit large-caps look "whale-heavy" when the
// top holders are just protocol contracts. Falls back to raw if flags are absent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const topHoldersPercent = (holders: any, top = 10): number | null => {
  if (!Array.isArray(holders) || !holders.length) return null;
  const isEoa = (h: any) => h?.is_contract !== 1 && h?.is_contract !== '1' && h?.is_locked !== 1 && h?.is_locked !== '1' && !/lock|burn|stake|masterchef|dead/i.test(String(h?.tag ?? ''));
  const eoas = holders.filter(isEoa);
  const list = eoas.length ? eoas : holders; // fall back if the API didn't tag anything
  const sum = list.slice(0, top).reduce((s: number, h: any) => s + (Number(h?.percent) || 0), 0);
  return Math.min(100, Math.max(0, sum * 100));
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lpLockedPercent = (lp: any): number | null => {
  if (!Array.isArray(lp) || !lp.length) return null;
  const locked = lp.reduce((s: number, h: any) => s + (h?.is_locked === 1 || h?.is_locked === '1' ? Number(h?.percent) || 0 : 0), 0);
  return Math.min(100, Math.max(0, locked * 100));
};

/** Full security detail for one token. `network` uses the radar chain slugs. */
export const tokenSecurityDetail = async (network: string, contract: string): Promise<TokenSecurityDetail> => {
  if (!contract) return DETAIL_UNKNOWN;
  if (network === 'solana') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await get<{ result: Record<string, any> }>(`${BASE}/solana/token_security?contract_addresses=${contract}`);
    const v = d?.result?.[contract];
    if (!v) return DETAIL_UNKNOWN;
    return {
      ...DETAIL_UNKNOWN,
      checked: true,
      mintable: bool(v?.mintable?.status),
      freezable: bool(v?.freezable?.status),
      has_blacklist: null,
      holder_count: v?.holder_count != null ? Number(v.holder_count) || null : null,
      top10_percent: topHoldersPercent(v?.holders),
      creator_percent: pct(v?.creator_percent),
      lp_locked_percent: null
    };
  }
  const chainId = networkToChainId(network);
  if (!chainId) return DETAIL_UNKNOWN;
  const addr = contract.toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await get<{ result: Record<string, any> }>(`${BASE}/token_security/${chainId}?contract_addresses=${addr}`);
  const v = d?.result?.[addr];
  if (!v) return DETAIL_UNKNOWN;
  return {
    checked: true,
    is_honeypot: bool(v?.is_honeypot),
    cannot_sell_all: bool(v?.cannot_sell_all),
    buy_tax: taxNum(v?.buy_tax),
    sell_tax: taxNum(v?.sell_tax),
    is_open_source: bool(v?.is_open_source),
    is_proxy: bool(v?.is_proxy),
    mintable: bool(v?.is_mintable ?? v?.mintable),
    freezable: bool(v?.transfer_pausable),
    has_blacklist: bool(v?.is_blacklisted),
    hidden_owner: bool(v?.hidden_owner),
    can_take_back_ownership: bool(v?.can_take_back_ownership),
    owner_change_balance: bool(v?.owner_change_balance),
    selfdestruct: bool(v?.selfdestruct),
    holder_count: v?.holder_count != null ? Number(v.holder_count) || null : null,
    top10_percent: topHoldersPercent(v?.holders),
    creator_percent: pct(v?.creator_percent),
    lp_locked_percent: lpLockedPercent(v?.lp_holders)
  };
};
