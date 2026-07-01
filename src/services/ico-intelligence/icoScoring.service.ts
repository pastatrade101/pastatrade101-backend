import type { IcoRawProject } from '../sources/icodrops.client';

// ─────────────────────────────────────────────────────────────────────────────
// ICO scoring — turns a raw project into a 0–100 research score across 8 factors,
// then classifies it. Probability-style RESEARCH signal, never a buy signal.
//
// Each factor is 0–100 and defaults to a neutral 50 when the underlying data is
// missing, so sparse projects score around the middle rather than being unfairly
// punished — while genuine gaps surface as red flags.
// ─────────────────────────────────────────────────────────────────────────────

export type Classification = 'strong_watchlist' | 'needs_research' | 'high_risk';

export interface ScoreComponents {
  vc_backers: number;
  narrative: number;
  tokenomics: number;
  vesting: number;
  community: number;
  product_docs: number;
  market_timing: number;
  red_flags: number; // 100 = clean, lower = more/worse flags
}

export interface IcoScoreResult {
  score: number;
  classification: Classification;
  components: ScoreComponents;
  red_flags: string[];
}

const WEIGHTS: Record<keyof ScoreComponents, number> = {
  vc_backers: 0.18,
  narrative: 0.15,
  tokenomics: 0.14,
  vesting: 0.14,
  community: 0.12,
  product_docs: 0.12,
  market_timing: 0.07,
  red_flags: 0.08
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// Curated tier-1 crypto VCs (lowercased substrings). Presence of these is a
// strong positive signal; extend freely.
const TIER1_VCS = [
  'a16z', 'andreessen', 'paradigm', 'sequoia', 'polychain', 'pantera', 'coinbase ventures', 'binance labs', 'yzi labs', 'dragonfly', 'multicoin', 'jump', 'animoca', 'delphi', 'framework', 'spartan', 'hashed', 'electric capital', 'placeholder', 'variant', '1kx', 'galaxy', 'wintermute', 'amber', 'blockchain capital', 'lightspeed', 'tiger global', 'dwf'
];

// Narratives currently carrying market attention (lowercased substrings).
const HOT_NARRATIVES = ['ai', 'artificial intelligence', 'rwa', 'real world', 'depin', 'restaking', 'modular', 'bitcoin l2', 'defi', 'socialfi', 'gaming', 'gamefi', 'meme', 'prediction', 'liquid staking', 'infrastructure', 'privacy'];

const hasAny = (hay: string, needles: string[]) => needles.some((n) => hay.includes(n));

const scoreBackers = (backers: string[]): number => {
  if (!backers.length) return 40; // unknown-ish, mild negative
  const joined = backers.join(' ').toLowerCase();
  const tier1 = TIER1_VCS.filter((v) => joined.includes(v)).length;
  const base = 45 + Math.min(3, backers.length) * 5; // more disclosed backers → higher
  return clamp(base + tier1 * 15);
};

const scoreNarrative = (category: string | null, description: string | null): number => {
  const hay = `${category ?? ''} ${description ?? ''}`.toLowerCase();
  if (!hay.trim()) return 50;
  return hasAny(hay, HOT_NARRATIVES) ? 78 : 52;
};

const scoreTokenomics = (t: Record<string, unknown>): number => {
  const keys = Object.keys(t ?? {});
  if (!keys.length) return 45; // not disclosed
  // More disclosed tokenomics fields → more transparent → higher.
  return clamp(50 + Math.min(5, keys.length) * 8);
};

const scoreVesting = (v: Record<string, unknown>): number => {
  const keys = Object.keys(v ?? {}).map((k) => k.toLowerCase());
  if (!keys.length) return 40; // no vesting disclosed = unlock risk unknown
  const good = keys.some((k) => /cliff|vest|lock|schedule|unlock/.test(k));
  return good ? 75 : 55;
};

const scoreCommunity = (socials: Record<string, string>): number => {
  const n = Object.values(socials ?? {}).filter(Boolean).length;
  if (!n) return 40;
  return clamp(45 + n * 12);
};

const scoreProductDocs = (p: IcoRawProject): number => {
  let s = 40;
  if (p.website) s += 25;
  if (p.whitepaper_url) s += 25;
  if (p.description && p.description.length > 120) s += 10;
  return clamp(s);
};

const scoreMarketTiming = (status: IcoRawProject['sale_status']): number => {
  // "Early" attention favours upcoming/active over ended.
  if (status === 'upcoming') return 70;
  if (status === 'active') return 65;
  if (status === 'ended') return 45;
  return 50;
};

const detectRedFlags = (p: IcoRawProject): string[] => {
  const flags: string[] = [];
  if (!p.website) flags.push('No website disclosed');
  if (!p.whitepaper_url) flags.push('No whitepaper / docs link');
  if (!p.backers.length) flags.push('No backers / investors disclosed');
  if (!Object.keys(p.vesting ?? {}).length) flags.push('No vesting / unlock schedule disclosed');
  if (!Object.keys(p.tokenomics ?? {}).length) flags.push('No tokenomics disclosed');
  if (!Object.values(p.social_links ?? {}).filter(Boolean).length) flags.push('No social links found');
  if (!p.token_symbol) flags.push('No token symbol');
  if ((p.raise_amount_text ?? '').toLowerCase().includes('tba') || !p.raise_amount) flags.push('Raise amount undisclosed / TBA');
  return flags;
};

const classify = (score: number): Classification => (score >= 70 ? 'strong_watchlist' : score >= 45 ? 'needs_research' : 'high_risk');

export const scoreIcoProject = (p: IcoRawProject): IcoScoreResult => {
  const red_flags = detectRedFlags(p);
  // Each flag shaves the "clean" component; capped so it never fully zeroes it.
  const redFlagsScore = clamp(100 - red_flags.length * 12);

  const components: ScoreComponents = {
    vc_backers: scoreBackers(p.backers),
    narrative: scoreNarrative(p.category, p.description),
    tokenomics: scoreTokenomics(p.tokenomics),
    vesting: scoreVesting(p.vesting),
    community: scoreCommunity(p.social_links),
    product_docs: scoreProductDocs(p),
    market_timing: scoreMarketTiming(p.sale_status),
    red_flags: redFlagsScore
  };

  const score = clamp(
    (Object.keys(WEIGHTS) as (keyof ScoreComponents)[]).reduce((sum, k) => sum + components[k] * WEIGHTS[k], 0)
  );

  return { score, classification: classify(score), components, red_flags };
};

// Human labels + traffic-light for the classification.
export const CLASSIFICATION_META: Record<Classification, { label: string; light: string; tone: 'good' | 'warn' | 'danger' }> = {
  strong_watchlist: { label: 'Strong Watchlist', light: '🟢', tone: 'good' },
  needs_research: { label: 'Needs More Research', light: '🟡', tone: 'warn' },
  high_risk: { label: 'High Risk / Avoid', light: '🔴', tone: 'danger' }
};

export const ICO_DISCLAIMER = 'This is research data only, not financial advice.';
