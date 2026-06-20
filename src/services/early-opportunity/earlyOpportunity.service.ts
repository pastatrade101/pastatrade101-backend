import type { CgTrendingItem } from '../sources/coingeckoRadar.client';
import type { GtPool } from '../sources/geckoTerminal.client';
import { parseGtId } from '../sources/geckoTerminal.client';
import type { TokenSecurity } from '../sources/goplus.client';

// ─────────────────────────────────────────────────────────────────────────────
// Early Opportunity Radar — pure scoring + normalisation. Candidates are RESEARCH
// candidates only: Opportunity Score measures early attention/traction, NOT a buy
// signal, and is always paired with a Risk Score + confidence + risk flags.
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const r2 = (n: number) => Math.round(n);
const numOr = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.eE+-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'FRAX', 'LUSD', 'USDP', 'GUSD']);
const isStable = (sym: string) => STABLES.has(sym.toUpperCase());
const isWrapped = (name: string, sym: string) => /wrapped|staked|^w[a-z]{2,5}$/i.test(name) || /^(WETH|WBTC|WBNB|WSOL|STETH|WSTETH|CBETH)$/i.test(sym);

export interface RadarSettings {
  min_liquidity_usd: number;
  min_volume_24h: number;
  min_transactions_24h: number;
  min_pool_age_hours: number;
  max_vol_liq_ratio: number;
  exclude_stablecoins: boolean;
  exclude_wrapped_tokens: boolean;
  exclude_abnormal_spikes: boolean;
  allowed_networks: string[];
  scoring_weights: Record<string, number>;
  risk_weights: Record<string, number>;
}

export const DEFAULT_SETTINGS: RadarSettings = {
  min_liquidity_usd: 100000,
  min_volume_24h: 50000,
  min_transactions_24h: 50,
  min_pool_age_hours: 24,
  max_vol_liq_ratio: 8,
  exclude_stablecoins: true,
  exclude_wrapped_tokens: true,
  exclude_abnormal_spikes: true,
  allowed_networks: ['eth', 'solana', 'base', 'bsc', 'arbitrum', 'polygon_pos', 'avax', 'optimism', 'sui'],
  scoring_weights: { volume_growth: 0.25, liquidity_quality: 0.2, transactions: 0.15, trend_rank: 0.15, narrative: 0.1, momentum: 0.1, data_quality: 0.05 },
  risk_weights: { low_liquidity: 0.2, new_pool: 0.15, abnormal_spike: 0.15, high_fdv: 0.1, imbalance: 0.1, security: 0.15, single_source: 0.1, unknown_mcap: 0.05 }
};

export interface RadarCandidate {
  external_id: string;
  asset_name: string;
  symbol: string;
  network: string | null;
  contract_address: string | null;
  source_name: string;
  source_type: string;
  category: string | null;
  narrative: string | null;
  price_usd: number | null;
  market_cap: number | null;
  fdv: number | null;
  liquidity_usd: number | null;
  volume_24h: number | null;
  transactions_24h: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
  pool_age_hours: number | null;
  dex_name: string | null;
  price_change_1h: number | null;
  price_change_6h: number | null;
  price_change_24h: number | null;
  volume_change_24h: number | null;
  liquidity_change_24h: number | null;
  trending_rank: number | null;
  opportunity_score: number;
  risk_score: number;
  confidence: 'High' | 'Medium' | 'Low';
  quality_badges: string[];
  risk_flags: string[];
  interpretation: string;
  source_url: string | null;
  is_honeypot: boolean | null;
  security_checked: boolean;
}

// ── Sub-scores (0–1) ──────────────────────────────────────────────────────────
const liqQuality = (liq: number | null) => (liq == null ? 0.3 : clamp01((Math.log10(liq + 1) - 4) / 2)); // $10K→0, $1M→1
const txScore = (tx: number | null) => (tx == null ? 0.2 : clamp01(Math.log10(tx + 1) / Math.log10(2000)));
const turnover = (vol: number | null, liq: number | null) => (vol == null || liq == null || liq <= 0 ? 0.3 : clamp01(Math.log10(vol / liq + 1) / Math.log10(10)));
const momentumScore = (pc24: number | null) => (pc24 == null ? 0.3 : clamp01((pc24 + 5) / 35));
const trendScore = (rank: number | null, total: number) => (rank == null || total <= 0 ? 0.4 : clamp01(1 - (rank - 1) / total));

interface ScoreInputs {
  liquidity: number | null;
  volume: number | null;
  transactions: number | null;
  buys: number | null;
  sells: number | null;
  pc24: number | null;
  poolAgeHours: number | null;
  fdv: number | null;
  marketCap: number | null;
  rank: number | null;
  totalRanked: number;
  narrativeStrength: number; // 0–1
  volumeChange: number | null; // % if history available
  security: TokenSecurity;
  isDexOnly: boolean;
}

const dataQuality = (i: ScoreInputs): number => {
  const fields = [i.liquidity, i.volume, i.transactions, i.pc24, i.marketCap];
  return fields.filter((f) => f != null).length / fields.length;
};

export const opportunityScore = (i: ScoreInputs, w: Record<string, number>): number => {
  const volGrowth = i.volumeChange != null ? clamp01((i.volumeChange + 20) / 120) : turnover(i.volume, i.liquidity);
  const parts =
    w.volume_growth * volGrowth +
    w.liquidity_quality * liqQuality(i.liquidity) +
    w.transactions * txScore(i.transactions) +
    w.trend_rank * trendScore(i.rank, i.totalRanked) +
    w.narrative * clamp01(i.narrativeStrength) +
    w.momentum * momentumScore(i.pc24) +
    w.data_quality * dataQuality(i);
  return r2(clamp01(parts) * 100);
};

export const riskScore = (i: ScoreInputs, w: Record<string, number>, maxVolLiq: number): number => {
  const riskLiq = 1 - liqQuality(i.liquidity);
  const riskAge = i.poolAgeHours == null ? 0.2 : clamp01(1 - i.poolAgeHours / (30 * 24));
  const volLiq = i.volume != null && i.liquidity ? i.volume / i.liquidity : 0;
  const riskSpike = clamp01(Math.max(volLiq / (maxVolLiq * 2.5), Math.abs(i.pc24 ?? 0) / 120));
  const riskFdv = i.fdv != null && i.liquidity ? clamp01(Math.log10(i.fdv / i.liquidity + 1) / 3) : 0;
  const total = (i.buys ?? 0) + (i.sells ?? 0);
  const riskImb = total > 0 ? clamp01(Math.abs((i.buys ?? 0) - (i.sells ?? 0)) / total) : 0;
  let riskSec = 0.4; // unchecked → moderate
  if (i.security.checked) {
    if (i.security.is_honeypot) riskSec = 1;
    else {
      riskSec = 0.1;
      if ((i.security.buy_tax ?? 0) > 10 || (i.security.sell_tax ?? 0) > 10) riskSec = Math.max(riskSec, 0.7);
      if (i.security.is_open_source === false) riskSec = Math.max(riskSec, 0.5);
      if (i.security.mintable || i.security.freezable) riskSec = Math.max(riskSec, 0.5);
    }
  }
  const riskSingle = i.isDexOnly ? 1 : 0;
  const riskMcap = i.marketCap == null ? 1 : 0;
  const parts =
    w.low_liquidity * riskLiq +
    w.new_pool * riskAge +
    w.abnormal_spike * riskSpike +
    w.high_fdv * riskFdv +
    w.imbalance * riskImb +
    w.security * riskSec +
    w.single_source * riskSingle +
    w.unknown_mcap * riskMcap;
  return r2(clamp01(parts) * 100);
};

export const opportunityLabel = (s: number): string =>
  s <= 25 ? 'Weak signal' : s <= 45 ? 'Low interest' : s <= 60 ? 'Watchlist candidate' : s <= 75 ? 'Strong research candidate' : s <= 90 ? 'High attention candidate' : 'Extreme attention / high-risk spike';
export const riskLabel = (s: number): string =>
  s <= 25 ? 'Lower data risk' : s <= 45 ? 'Moderate risk' : s <= 65 ? 'High risk' : s <= 85 ? 'Very high risk' : 'Extreme speculative risk';

const confidenceOf = (i: ScoreInputs, settings: RadarSettings): 'High' | 'Medium' | 'Low' => {
  const liqOk = (i.liquidity ?? 0) >= settings.min_liquidity_usd;
  const volOk = (i.volume ?? 0) >= settings.min_volume_24h;
  const txOk = (i.transactions ?? 0) >= settings.min_transactions_24h;
  const secOk = i.security.checked && !i.security.is_honeypot;
  const young = i.poolAgeHours != null && i.poolAgeHours < settings.min_pool_age_hours;
  const points = [liqOk, volOk, txOk, secOk || !i.isDexOnly, !young].filter(Boolean).length;
  if (points >= 4 && !young) return 'High';
  if (points >= 2) return 'Medium';
  return 'Low';
};

const buildBadges = (c: { liquidity: number | null; volume: number | null; transactions: number | null; poolAgeHours: number | null; pc24: number | null; security: TokenSecurity; isDexOnly: boolean; source: string }, settings: RadarSettings): string[] => {
  const b: string[] = [];
  if (c.source.includes('trending')) b.push('Trending');
  if (!c.isDexOnly) b.push('CEX-listed');
  else b.push('DEX-only');
  if ((c.liquidity ?? 0) >= settings.min_liquidity_usd) b.push('Liquidity improving');
  if ((c.volume ?? 0) >= settings.min_volume_24h * 4) b.push('Volume expanding');
  if ((c.transactions ?? 0) >= settings.min_transactions_24h * 4) b.push('Strong transactions');
  if (c.poolAgeHours != null && c.poolAgeHours < settings.min_pool_age_hours) b.push('Short history');
  if ((c.liquidity ?? Infinity) < settings.min_liquidity_usd) b.push('Low liquidity');
  if (Math.abs(c.pc24 ?? 0) > 60) b.push('Abnormal spike');
  if (c.security.checked && c.security.is_honeypot) b.push('Possible low-float pump');
  const clean = (c.liquidity ?? 0) >= settings.min_liquidity_usd && (c.volume ?? 0) >= settings.min_volume_24h && (!c.security.checked || !c.security.is_honeypot) && Math.abs(c.pc24 ?? 0) <= 60;
  b.push(clean ? 'Clean signal' : 'Needs validation');
  return [...new Set(b)];
};

const buildFlags = (i: ScoreInputs, settings: RadarSettings): string[] => {
  const f: string[] = [];
  if (i.poolAgeHours != null && i.poolAgeHours < settings.min_pool_age_hours) f.push('Very new pool');
  if ((i.liquidity ?? Infinity) < settings.min_liquidity_usd) f.push('Low liquidity');
  if (i.fdv != null && i.liquidity && i.fdv / i.liquidity > 50) f.push('High FDV / low liquidity');
  if (Math.abs(i.pc24 ?? 0) > 60) f.push('Abnormal price spike');
  if ((i.transactions ?? Infinity) < settings.min_transactions_24h) f.push('Thin transactions');
  if (i.marketCap == null) f.push('Unknown market cap');
  // Contract-risk only matters for on-chain DEX tokens; CoinGecko-listed coins are multi-source confirmed.
  if (i.isDexOnly && !i.security.checked) f.push('Contract risk unknown');
  else if (i.security.is_honeypot) f.push('Honeypot warning');
  if (i.isDexOnly) f.push('DEX-only · single source');
  const volLiq = i.volume != null && i.liquidity ? i.volume / i.liquidity : 0;
  if (volLiq > settings.max_vol_liq_ratio) f.push('Possible wash / hype spike');
  return [...new Set(f)];
};

const interpret = (c: RadarCandidate): string => {
  const liq = c.liquidity_usd != null ? `$${Math.round(c.liquidity_usd).toLocaleString()}` : 'unknown';
  const young = c.pool_age_hours != null && c.pool_age_hours < 168;
  if (c.opportunity_score >= 61 && c.risk_score <= 55) {
    return `${c.symbol} is gaining early market attention — volume and transactions are rising and liquidity (${liq}) is acceptable. ${young ? 'The pool is still young, so risk remains elevated. ' : ''}Treat it as a research candidate, not a confirmed opportunity.`;
  }
  if (c.opportunity_score >= 61 && c.risk_score > 55) {
    return `${c.symbol} is trending, but risk is high${young ? ' because the pool is very new' : ''} and liquidity is ${liq}. The signal may be noisy or driven by short-term speculation — validate before researching further.`;
  }
  if (c.risk_score > 65) {
    return `${c.symbol} shows speculative activity with high risk (liquidity ${liq}). Price or volume may have moved sharply. Treat with caution — this is a high-risk discovery candidate only.`;
  }
  return `${c.symbol} shows early or moderate market activity. Attention is not yet strong and the signal needs validation through liquidity, volume and broader narrative strength.`;
};

// ── Normalisers ───────────────────────────────────────────────────────────────
const NO_SEC: TokenSecurity = { checked: false, is_honeypot: null, buy_tax: null, sell_tax: null, is_open_source: null, mintable: null, freezable: null };

export const fromTrendingCoin = (item: CgTrendingItem, rank: number, total: number, settings: RadarSettings, narrativeStrength = 0.5): RadarCandidate | null => {
  if (settings.exclude_stablecoins && isStable(item.symbol)) return null;
  if (settings.exclude_wrapped_tokens && isWrapped(item.name, item.symbol)) return null;
  const price = item.data?.price ?? null;
  const marketCap = numOr(item.data?.market_cap);
  const volume = numOr(item.data?.total_volume);
  const pc24 = item.data?.price_change_percentage_24h?.usd ?? null;
  const inputs: ScoreInputs = {
    liquidity: null,
    volume,
    transactions: null,
    buys: null,
    sells: null,
    pc24,
    poolAgeHours: null,
    fdv: null,
    marketCap,
    rank,
    totalRanked: total,
    narrativeStrength,
    volumeChange: null,
    security: NO_SEC,
    isDexOnly: false // CoinGecko-listed = multi-source confirmed
  };
  const opportunity_score = opportunityScore(inputs, settings.scoring_weights);
  const risk_score = riskScore(inputs, settings.risk_weights, settings.max_vol_liq_ratio);
  const cand: RadarCandidate = {
    external_id: item.id,
    asset_name: item.name,
    symbol: item.symbol?.toUpperCase() ?? item.id,
    network: null,
    contract_address: null,
    source_name: 'coingecko_trending',
    source_type: 'trending',
    category: null,
    narrative: null,
    price_usd: price,
    market_cap: marketCap,
    fdv: null,
    liquidity_usd: null,
    volume_24h: volume,
    transactions_24h: null,
    buys_24h: null,
    sells_24h: null,
    pool_age_hours: null,
    dex_name: null,
    price_change_1h: null,
    price_change_6h: null,
    price_change_24h: pc24,
    volume_change_24h: null,
    liquidity_change_24h: null,
    trending_rank: rank,
    opportunity_score,
    risk_score,
    confidence: confidenceOf(inputs, settings),
    quality_badges: buildBadges({ liquidity: null, volume, transactions: null, poolAgeHours: null, pc24, security: NO_SEC, isDexOnly: false, source: 'coingecko_trending' }, settings),
    risk_flags: buildFlags(inputs, settings),
    interpretation: '',
    source_url: `https://www.coingecko.com/en/coins/${item.id}`,
    is_honeypot: null,
    security_checked: false
  };
  cand.interpretation = interpret(cand);
  return cand;
};

export const fromTrendingPool = (pool: GtPool, rank: number, total: number, settings: RadarSettings, security: TokenSecurity = NO_SEC): RadarCandidate | null => {
  const a = pool.attributes;
  const { network, address: poolAddr } = parseGtId(pool.id);
  if (network && settings.allowed_networks.length && !settings.allowed_networks.includes(network)) return null;
  const baseId = pool.relationships?.base_token?.data?.id;
  const contract = parseGtId(baseId).address;
  const symbol = (a.name?.split('/')[0] ?? '').trim().toUpperCase() || (contract ?? 'TOKEN');
  if (settings.exclude_stablecoins && isStable(symbol)) return null;
  if (settings.exclude_wrapped_tokens && isWrapped(a.name ?? '', symbol)) return null;

  const liquidity = numOr(a.reserve_in_usd);
  const volume = numOr(a.volume_usd?.h24);
  const buys = a.transactions?.h24?.buys ?? null;
  const sells = a.transactions?.h24?.sells ?? null;
  const transactions = buys != null || sells != null ? (buys ?? 0) + (sells ?? 0) : null;
  const pc24 = numOr(a.price_change_percentage?.h24);
  const poolAgeHours = a.pool_created_at ? Math.max(0, (Date.now() - Date.parse(a.pool_created_at)) / 3_600_000) : null;
  const fdv = numOr(a.fdv_usd);
  const marketCap = numOr(a.market_cap_usd);

  const inputs: ScoreInputs = {
    liquidity,
    volume,
    transactions,
    buys,
    sells,
    pc24,
    poolAgeHours,
    fdv,
    marketCap,
    rank,
    totalRanked: total,
    narrativeStrength: 0.5,
    volumeChange: null,
    security,
    isDexOnly: true
  };
  const opportunity_score = opportunityScore(inputs, settings.scoring_weights);
  const risk_score = riskScore(inputs, settings.risk_weights, settings.max_vol_liq_ratio);
  const dex = parseGtId(pool.relationships?.dex?.data?.id).address;
  const cand: RadarCandidate = {
    external_id: pool.id,
    asset_name: symbol,
    symbol,
    network,
    contract_address: contract,
    source_name: 'geckoterminal_trending',
    source_type: 'dex_pool',
    category: null,
    narrative: null,
    price_usd: numOr(a.base_token_price_usd),
    market_cap: marketCap,
    fdv,
    liquidity_usd: liquidity,
    volume_24h: volume,
    transactions_24h: transactions,
    buys_24h: buys,
    sells_24h: sells,
    pool_age_hours: poolAgeHours == null ? null : Math.round(poolAgeHours),
    dex_name: dex,
    price_change_1h: numOr(a.price_change_percentage?.h1),
    price_change_6h: numOr(a.price_change_percentage?.h6),
    price_change_24h: pc24,
    volume_change_24h: null,
    liquidity_change_24h: null,
    trending_rank: rank,
    opportunity_score,
    risk_score,
    confidence: confidenceOf(inputs, settings),
    quality_badges: buildBadges({ liquidity, volume, transactions, poolAgeHours, pc24, security, isDexOnly: true, source: 'geckoterminal_trending' }, settings),
    risk_flags: buildFlags(inputs, settings),
    interpretation: '',
    source_url: network && poolAddr ? `https://www.geckoterminal.com/${network}/pools/${poolAddr}` : null,
    is_honeypot: security.is_honeypot,
    security_checked: security.checked
  };
  cand.interpretation = interpret(cand);
  return cand;
};

// ── Aggregates for the radar view (operate on stored candidate rows) ──────────
export interface NetworkLeader {
  network: string;
  count: number;
  avg_opportunity: number;
  avg_risk: number;
  total_volume: number;
  top_symbol: string | null;
}
export interface NarrativeLeader {
  narrative: string;
  market_cap_change_24h: number | null;
  market_cap: number | null;
  top_coins: string[];
}

export interface RadarSummary {
  total_candidates: number;
  trending_count: number;
  high_attention: number;
  clean_candidates: number;
  low_liquidity_warnings: number;
  top_network: string | null;
  top_narrative: string | null;
}

export const buildNetworkLeaderboard = (cands: RadarCandidate[]): NetworkLeader[] => {
  const byNet = new Map<string, RadarCandidate[]>();
  for (const c of cands) {
    if (!c.network) continue;
    byNet.set(c.network, [...(byNet.get(c.network) ?? []), c]);
  }
  return [...byNet.entries()]
    .map(([network, list]) => {
      const top = [...list].sort((a, b) => b.opportunity_score - a.opportunity_score)[0];
      return {
        network,
        count: list.length,
        avg_opportunity: Math.round(list.reduce((s, c) => s + c.opportunity_score, 0) / list.length),
        avg_risk: Math.round(list.reduce((s, c) => s + c.risk_score, 0) / list.length),
        total_volume: Math.round(list.reduce((s, c) => s + (c.volume_24h ?? 0), 0)),
        top_symbol: top?.symbol ?? null
      };
    })
    .sort((a, b) => b.count - a.count || b.avg_opportunity - a.avg_opportunity);
};

// Pretty coin id → display name ("erc-404" → "Erc 404", "pandora" → "Pandora").
const prettyId = (id: string) => id.split(/[-_]/).map((w) => cap(w)).join(' ');

export const buildNarrativeLeaderboard = (categories: { name: string; market_cap: number | null; market_cap_change_24h: number | null; top_3_coins_id?: string[] }[]): NarrativeLeader[] =>
  [...categories]
    .filter((c) => c.market_cap_change_24h != null)
    .sort((a, b) => (b.market_cap_change_24h ?? 0) - (a.market_cap_change_24h ?? 0))
    .slice(0, 8)
    // top_3_coins_id are readable coin slugs; top_3_coins (image URLs) are NOT used.
    .map((c) => ({ narrative: c.name, market_cap_change_24h: c.market_cap_change_24h, market_cap: c.market_cap, top_coins: (c.top_3_coins_id ?? []).slice(0, 3).map(prettyId) }));

export const buildSummary = (cands: RadarCandidate[], settings: RadarSettings, narratives: NarrativeLeader[]): RadarSummary => {
  const nets = buildNetworkLeaderboard(cands);
  return {
    total_candidates: cands.length,
    trending_count: cands.filter((c) => c.source_type === 'trending' || c.quality_badges.includes('Trending')).length,
    high_attention: cands.filter((c) => c.opportunity_score >= 76).length,
    clean_candidates: cands.filter((c) => passesCleanFilter(c, settings)).length,
    low_liquidity_warnings: cands.filter((c) => c.risk_flags.includes('Low liquidity')).length,
    top_network: nets[0]?.network ?? null,
    top_narrative: narratives[0]?.narrative ?? null
  };
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Accurate, non-contradictory takeaway: top networks, high-attention count, clean
// trend, the dominant risk theme, and a validation reminder. Never a buy call.
export const buildTakeaway = (all: RadarCandidate[], nets: NetworkLeader[], narratives: NarrativeLeader[], settings: RadarSettings): string => {
  if (!all.length) return 'No early-opportunity candidates passed the radar filters in this scan. Activity is quiet or data sources are unavailable.';
  const topNets = nets.slice(0, 3).map((n) => cap(n.network)).join(', ');
  const highAttention = all.filter((c) => c.opportunity_score >= 76).length;
  const clean = all.filter((c) => passesCleanFilter(c, settings)).length;
  const cleanShare = Math.round((clean / all.length) * 100);

  // Dominant risk theme = most common risk flag across candidates.
  const flagCounts = new Map<string, number>();
  for (const c of all) for (const f of c.risk_flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  const topFlag = [...flagCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const riskTheme = topFlag ? topFlag.toLowerCase() : 'short history';

  const narr = narratives[0]?.narrative;
  const attentionLine = highAttention > 0 ? `${highAttention} candidate${highAttention === 1 ? '' : 's'} show high early attention` : 'No candidate is showing extreme attention yet';
  const validationLine = cleanShare >= 40 ? `clean candidates are a healthy share (${cleanShare}%)` : `most candidates still need validation (${cleanShare}% pass the clean filter)`;
  return `Early activity is concentrated on ${topNets || 'multiple networks'} today${narr ? `, with the ${narr} narrative leading` : ''}. ${attentionLine}, but ${validationLine} — the main caveat right now is ${riskTheme}. These are research candidates, not buy signals.`;
};

// ── Report summary (prepared for the Report Generator; not wired into reports yet) ──
export interface RadarReportSummary {
  top_networks: string[];
  top_narratives: string[];
  high_attention: number;
  clean_candidates: number;
  main_risk: string | null;
  text_en: string;
  text_sw: string;
}

export const buildRadarReportSummary = (all: RadarCandidate[], nets: NetworkLeader[], narratives: NarrativeLeader[], settings: RadarSettings): RadarReportSummary => {
  const top_networks = nets.slice(0, 2).map((n) => cap(n.network));
  const top_narratives = narratives.slice(0, 2).map((n) => n.narrative);
  const high_attention = all.filter((c) => c.opportunity_score >= 76).length;
  const clean_candidates = all.filter((c) => passesCleanFilter(c, settings)).length;
  const flagCounts = new Map<string, number>();
  for (const c of all) for (const f of c.risk_flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  const main_risk = [...flagCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const nets2 = top_networks.join(' and ') || 'multiple networks';
  const text_en = !all.length
    ? 'Early Opportunity Radar found no candidates passing the clean filters this period.'
    : `Early Opportunity Radar shows activity concentrated on ${nets2}. ${clean_candidates} candidate${clean_candidates === 1 ? '' : 's'} pass the clean filter${high_attention ? ` and ${high_attention} show high early attention` : ''}, but many still require validation${main_risk ? ` due to ${main_risk.toLowerCase()}` : ''}. These are research candidates only — not buy signals.`;
  const text_sw = !all.length
    ? 'Early Opportunity Radar haijapata candidates zilizopita vichujio safi kipindi hiki.'
    : `Early Opportunity Radar inaonyesha shughuli zimejikita kwenye ${nets2}. Candidates ${clean_candidates} zimepita kichujio safi${high_attention ? ` na ${high_attention} zinaonyesha umakini wa mapema` : ''}, lakini nyingi bado zinahitaji uthibitisho${main_risk ? ` kutokana na ${main_risk.toLowerCase()}` : ''}. Hizi ni candidates za utafiti tu — si ishara za kununua.`;
  return { top_networks, top_narratives, high_attention, clean_candidates, main_risk, text_en, text_sw };
};

/** Premium-clean filter — drops illiquid / wash / honeypot candidates from the default view. */
export const passesCleanFilter = (c: RadarCandidate, settings: RadarSettings): boolean => {
  if (c.source_type === 'dex_pool') {
    if ((c.liquidity_usd ?? 0) < settings.min_liquidity_usd) return false;
    if ((c.volume_24h ?? 0) < settings.min_volume_24h) return false;
    if (c.transactions_24h != null && c.transactions_24h < settings.min_transactions_24h) return false;
    if (c.pool_age_hours != null && c.pool_age_hours < settings.min_pool_age_hours) return false;
    if (settings.exclude_abnormal_spikes && c.volume_24h != null && c.liquidity_usd && c.volume_24h / c.liquidity_usd > settings.max_vol_liq_ratio) return false;
    if (c.is_honeypot) return false;
  }
  return true;
};
