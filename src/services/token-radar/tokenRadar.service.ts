import { supabase } from '../../config/supabase';
import { AppError } from '../../utils/api-response';
import { tokenSecurityDetail } from '../sources/goplus.client';
import { getLatestMacroRegime } from '../macro-regime/macroRegime.service';
import { computeAltcoinSeason } from '../altcoin-btc/altcoin-season.service';
import { chainOf, type ChainConfig } from './chainConfig';
import { resolveToken, type ResolveResult } from './tokenResolver';
import { getHolderData } from './holderData.service';
import { getExchangeListings, type ExchangeListingSummary } from './exchangeListing.service';
import { computeAnalysis, type MarketContext, type MarketData, type RiskWarning, type Rating, type Scores } from './scoringEngine';

// ─────────────────────────────────────────────────────────────────────────────
// Token Position Radar orchestrator. Layered sources, per the module design:
//   DEXScreener → market/pair data · explorer/indexer → holder truth ·
//   GoPlus → contract risk · platform indicators → timing/regime.
// Synchronous (seconds); the stored report doubles as the 30-min cache + the
// daily scan counter. Research only, never financial advice.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_MINUTES = 30;
export const DISCLAIMER = 'This analysis is educational only and not financial advice. New and low-liquidity tokens are highly risky.';

export interface TokenReport {
  id?: string;
  cached?: boolean;
  token: {
    name: string | null; symbol: string | null; chain: string; chain_name: string; address: string;
    explorer_url: string; pair_url: string | null; dex: string | null;
    price: number | null; market_cap: number | null; fdv: number | null; liquidity: number | null;
    volume_24h: number | null; holders: number | null; age_days: number | null;
  };
  holder: { count: number | null; source: string; confidence: string; verified: boolean; weight_used: number; used_in_final_score: boolean; warning?: string };
  scores: Scores & { confidence: number };
  confidence: { data_availability: number; analysis_quality: number; combined: number; note: string };
  rating: Rating;
  rating_explanation: string;
  action_label: string;
  summary: string;
  positives: string[];
  warnings: RiskWarning[];
  data_quality_warnings: string[];
  timing_view: string;
  exchanges: ExchangeListingSummary | null;
  disclaimer: string;
  created_at?: string;
}

const marketContext = async (): Promise<MarketContext> => {
  const [macro, riskRow, derivRow, alt] = await Promise.all([
    getLatestMacroRegime().catch(() => null),
    supabase.from('risk_summary_daily').select('summary_risk').order('snapshot_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('derivatives_daily').select('leverage_risk').order('date', { ascending: false }).limit(1).maybeSingle(),
    computeAltcoinSeason('30d', 'premium_clean').catch(() => null)
  ]);
  return {
    macro_score: macro?.regime_score ?? null,
    btc_risk: riskRow.data?.summary_risk != null ? Number(riskRow.data.summary_risk) : null,
    leverage_risk: derivRow.data?.leverage_risk != null ? Number(derivRow.data.leverage_risk) : null,
    alt_season: alt ? Number(alt.altcoin_season_index) : null
  };
};

const timingView = (t: number | null): string =>
  t == null
    ? 'Platform market-regime data is unavailable right now, so the timing read is neutral by default.'
    : t >= 65
      ? 'The broader market backdrop is supportive — BTC regime, leverage and macro conditions lean risk-on, which historically helps setups like this.'
      : t >= 45
        ? 'The broader market backdrop is mixed — no strong tailwind or headwind. Stronger confirmation is needed before this becomes a strong setup.'
        : 'The broader market backdrop is a headwind — BTC regime or macro conditions are risk-off. Even good tokens struggle in this environment.';

// Red-flags-first summary.
const buildSummary = (rating: Rating, warnings: RiskWarning[], holderVerified: boolean, holderCount: number | null, liqOk: boolean): string => {
  const worst = warnings[0];
  if (rating === 'Unknown / Insufficient Data') return 'There is not enough reliable data to score this token confidently.';
  if (holderVerified && (rating === 'High Risk / Avoid for Now') && holderCount != null && holderCount < 50)
    return `Token Position Radar found serious holder-distribution risk. Verified holder data shows only ${holderCount} holder${holderCount === 1 ? '' : 's'} and poor holder health. Combined with the market picture, treat this as high risk until wider holder distribution and stronger activity appear.`;
  if (worst && (worst.severity === 'critical' || worst.severity === 'high')) {
    const holderNote = holderCount != null && !holderVerified ? ' Holder data from the current source is unverified, so it was not treated as final truth.' : '';
    return `Token Position Radar found that this token${liqOk ? ' has strong reported liquidity, but the setup is not fully confirmed' : ' is not a confirmed setup'}. The main concern: ${worst.message.replace(/\.$/, '').toLowerCase()}.${holderNote} Wait for stronger, verified activity before considering this healthy.`;
  }
  return `Token Position Radar rates this token ${rating}. ${liqOk ? 'Reported liquidity is reasonable' : 'Liquidity is limited'}, and no severe red flags were detected, but ${rating === 'Good Watchlist Candidate' || rating === 'Strong Opportunity' ? 'keep monitoring for continuation.' : 'the setup is not confirmed yet — patience is reasonable.'}`;
};

export const scansToday = async (userId: string): Promise<number> => {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase.from('token_analysis_reports').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', start.toISOString());
  return count ?? 0;
};

const cachedReport = async (chain: string, address: string) => {
  const since = new Date(Date.now() - CACHE_MINUTES * 60_000).toISOString();
  const { data } = await supabase.from('token_analysis_reports').select('*').eq('chain', chain).ilike('token_address', address).gte('created_at', since).order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowToReport = (row: any, chain: ChainConfig, cached: boolean): TokenReport => {
  const raw = row.raw_data ?? {};
  return {
    id: row.id,
    cached,
    token: {
      name: row.token_name, symbol: row.token_symbol, chain: row.chain, chain_name: chain.name, address: row.token_address,
      explorer_url: `${chain.explorerUrl}${row.token_address}`, pair_url: raw.pair_url ?? null, dex: raw.dex ?? null,
      price: row.price != null ? Number(row.price) : null, market_cap: row.market_cap != null ? Number(row.market_cap) : null,
      fdv: row.fdv != null ? Number(row.fdv) : null, liquidity: row.liquidity != null ? Number(row.liquidity) : null,
      volume_24h: row.volume_24h != null ? Number(row.volume_24h) : null, holders: row.holders, age_days: row.age_days
    },
    holder: { count: row.holders, source: row.holder_source ?? 'unknown', confidence: row.holder_confidence ?? 'low', verified: !!row.holder_verified, weight_used: raw.holder_weight ?? 0, used_in_final_score: !!raw.holder_used_in_final, warning: raw.holder_warning },
    scores: {
      opportunity: row.opportunity_score, risk: row.risk_score, momentum: row.momentum_score, liquidity: row.liquidity_score,
      holder_health: row.holder_health_score, contract_safety: row.contract_safety_score, timing: row.timing_score, confidence: row.confidence_score
    },
    confidence: { data_availability: row.data_availability_confidence ?? row.confidence_score ?? 0, analysis_quality: row.analysis_quality_confidence ?? row.confidence_score ?? 0, combined: row.confidence_score ?? 0, note: raw.confidence_note ?? '' },
    rating: row.final_rating, rating_explanation: row.rating_explanation ?? '', action_label: row.action_label,
    summary: row.summary, positives: row.positives ?? [], warnings: row.warnings ?? [], data_quality_warnings: row.data_quality_warnings ?? [],
    timing_view: row.timing_view ?? '', exchanges: raw.exchanges ?? null, disclaimer: DISCLAIMER, created_at: row.created_at
  };
};

export type AnalyzeOutcome =
  | { status: 'completed'; report: TokenReport }
  | { status: 'matches'; matches: Extract<ResolveResult, { kind: 'matches' }>['matches'] }
  | { status: 'error'; message: string };

export const analyzeToken = async (chainSlug: string, input: string, userId: string, fresh = false, ensureQuota?: () => Promise<void>): Promise<AnalyzeOutcome> => {
  const chain = chainOf(chainSlug);
  if (!chain) throw new AppError('Unsupported network. Pick one of the supported chains.', 400);

  const resolved = await resolveToken(chain, input);
  if (resolved.kind === 'error') return { status: 'error', message: resolved.message };
  if (resolved.kind === 'matches') return { status: 'matches', matches: resolved.matches };

  const pair = resolved.pair;
  const address = pair.baseToken.address;

  if (!fresh) {
    const hit = await cachedReport(chain.slug, address);
    if (hit) return { status: 'completed', report: rowToReport(hit, chain, true) };
  }

  if (ensureQuota) await ensureQuota();

  const dex: MarketData = {
    liquidity_usd: pair.liquidity?.usd ?? null, volume_24h: pair.volume?.h24 ?? null, market_cap: pair.marketCap ?? null, fdv: pair.fdv ?? null,
    price_change_h1: pair.priceChange?.h1 ?? null, price_change_h6: pair.priceChange?.h6 ?? null, price_change_h24: pair.priceChange?.h24 ?? null,
    buys_24h: pair.txns?.h24?.buys ?? null, sells_24h: pair.txns?.h24?.sells ?? null
  };

  // Contract risk first (GoPlus) — reused as the free holder baseline so we don't
  // call GoPlus twice, and holder escalation (Moralis) only fires when needed.
  const security = await tokenSecurityDetail(chain.goplusNetwork ?? chain.slug, address).catch(() => null);
  const [holder, market, exchanges] = await Promise.all([
    getHolderData(chain, address, { liquidityUsd: dex.liquidity_usd, marketCap: dex.market_cap }, security),
    marketContext(),
    getExchangeListings(chain, address).catch(() => null)
  ]);

  const age_days = pair.pairCreatedAt ? Math.max(0, Math.floor((Date.now() - pair.pairCreatedAt) / 86_400_000)) : null;
  const a = computeAnalysis({ dex, holder, security, age_days, market, input_type: resolved.input_type, listing_strength: exchanges?.listingStrengthScore ?? null });

  // Listing warnings fold into the data-quality list (deduped).
  const data_quality_warnings = [...new Set([...a.data_quality_warnings, ...(exchanges?.warnings ?? [])])];
  const liqOk = (dex.liquidity_usd ?? 0) >= 50_000;
  const summary = buildSummary(a.rating, a.warnings, a.holder_meta.verified, holder.holders, liqOk);
  const timing_view = timingView(a.scores.timing);

  const row = {
    user_id: userId, chain: chain.slug, token_address: address, token_name: pair.baseToken.name ?? null, token_symbol: pair.baseToken.symbol ?? null,
    input_type: resolved.input_type, raw_input: input.trim().slice(0, 120),
    price: pair.priceUsd != null ? Number(pair.priceUsd) : null, market_cap: dex.market_cap, fdv: dex.fdv, liquidity: dex.liquidity_usd, volume_24h: dex.volume_24h,
    holders: holder.holders, age_days,
    opportunity_score: a.scores.opportunity, risk_score: a.scores.risk, momentum_score: a.scores.momentum, liquidity_score: a.scores.liquidity,
    holder_health_score: a.scores.holder_health, contract_safety_score: a.scores.contract_safety, timing_score: a.scores.timing,
    confidence_score: a.confidence.combined, data_availability_confidence: a.confidence.data_availability, analysis_quality_confidence: a.confidence.analysis_quality,
    holder_source: a.holder_meta.source, holder_confidence: a.holder_meta.confidence, holder_verified: a.holder_meta.verified,
    final_rating: a.rating, rating_explanation: a.rating_explanation, action_label: a.action_label, summary,
    positives: a.positives, warnings: a.warnings, data_quality_warnings, timing_view,
    raw_data: {
      pair_url: pair.url, dex: pair.dexId, confidence_note: a.confidence.note,
      holder_weight: a.holder_meta.weight_used, holder_used_in_final: a.holder_meta.used_in_final_score, holder_warning: a.holder_meta.warning,
      exchanges, security, market, price_change: pair.priceChange ?? {}, txns: pair.txns ?? {}
    }
  };
  const { data: saved, error } = await supabase.from('token_analysis_reports').insert(row).select('*').maybeSingle();
  if (error) throw new AppError(`Failed to save analysis: ${error.message}`, 500, [error]);

  return { status: 'completed', report: rowToReport(saved ?? { ...row, id: undefined, created_at: new Date().toISOString() }, chain, false) };
};

export const getReport = async (id: string) => {
  const { data } = await supabase.from('token_analysis_reports').select('*').eq('id', id).maybeSingle();
  if (!data) return null;
  const chain = chainOf(data.chain);
  return chain ? rowToReport(data, chain, true) : null;
};

export const listMyReports = async (userId: string, limit = 20) => {
  const { data } = await supabase
    .from('token_analysis_reports')
    .select('id, chain, token_address, token_name, token_symbol, opportunity_score, risk_score, confidence_score, final_rating, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
};
