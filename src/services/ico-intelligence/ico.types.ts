// Shared shapes for the Early Project Radar. Every source adapter (ICO Drops,
// CryptoRank, …) normalizes into IcoRawProject; scoring, dedup, review, API and
// CSV all work off this one shape.

export type SaleStatus = 'active' | 'upcoming' | 'ended' | 'unknown';

export interface IcoRawProject {
  project_name: string;
  token_symbol: string | null;
  category: string | null;
  sale_status: SaleStatus;
  sale_type: string | null;
  sale_date: string | null;
  raise_amount_text: string | null;
  raise_amount: number | null;
  backers: string[];
  website: string | null;
  whitepaper_url: string | null;
  social_links: Record<string, string>;
  description: string | null;
  tokenomics: Record<string, unknown>;
  vesting: Record<string, unknown>;
  source_url: string | null;
}

export interface IcoCollectResult {
  projects: IcoRawProject[];
  status: 'disabled' | 'blocked-by-robots' | 'no-source' | 'ok' | 'error';
  detail: string;
}
