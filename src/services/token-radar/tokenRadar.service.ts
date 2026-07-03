import { supabase } from '../../config/supabase';
import { AppError } from '../../utils/api-response';
import { tokenSecurityDetail, type TokenSecurityDetail } from '../sources/goplus.client';
import { getLatestMacroRegime } from '../macro-regime/macroRegime.service';
import { computeAltcoinSeason } from '../altcoin-btc/altcoin-season.service';
import { chainOf, type ChainConfig } from './chainConfig';
import { resolveToken, type ResolveResult } from './tokenResolver';
import { computeScores, actionFor, type MarketContext, type ScoringInput, type Rating, type Scores } from './scoringEngine';
import type { DsPair } from '../sources/dexscreener.client';

// ─────────────────────────────────────────────────────────────────────────────
// Token Position Radar orchestrator: resolve → fetch (DEX, security, market
// regime) → score → build a beginner-readable report → store. Synchronous by
// design (a handful of provider calls, seconds) — the stored report doubles as
// the 30-minute cache and the daily scan counter. Research only, never advice.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_MINUTES = 30;
export const DISCLAIMER = 'This analysis is educational only and not financial advice. New and low-liquidity tokens are highly risky.';

export interface TokenReport {
  id?: string;
  cached?: boolean;
  token: {
    name: string | null;
    symbol: string | null;
    chain: string;
    chain_name: string;
    address: string;
    explorer_url: string;
    pair_url: string | null;
    dex: string | null;
    price: number | null;
    market_cap: number | null;
    fdv: number | null;
    liquidity: number | null;
    volume_24h: number | null;
    holders: number | null;
    age_days: number | null;
  };
  scores: Scores;
  rating: Rating;
  action_label: string;
  summary: string;
  positives: string[];
  warnings: string[];
  timing_view: string;
  confidence_note: string;
  disclaimer: string;
  created_at?: string;
}

// ── Market context from the platform's own indicators (all best-effort). ──
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

// ── Report text (beginner-readable, watch/avoid language only). ──
const fmtUsd = (n: number | null) => (n == null ? 'unknown' : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);

const buildNarrative = (i: ScoringInput, scores: Scores, rating: Rating, severe: string[]) => {
  const positives: string[] = [];
  const warnings: string[] = [...severe];
  const sec = i.security;

  if (scores.liquidity >= 60) positives.push(`Liquidity is solid (${fmtUsd(i.liquidity_usd)}).`);
  else if (scores.liquidity >= 40) positives.push(`Liquidity is acceptable (${fmtUsd(i.liquidity_usd)}).`);
  else warnings.push(`Liquidity is thin (${fmtUsd(i.liquidity_usd)}) — exits can be expensive.`);

  if (scores.momentum >= 60) positives.push('Volume and short-term momentum are improving.');
  else if (scores.momentum < 45) warnings.push('Momentum is weak — volume needs continuation.');

  if (scores.holder_health != null) {
    if (scores.holder_health >= 60) positives.push(`Holder base looks healthy${sec.holder_count ? ` (${sec.holder_count.toLocaleString()} holders)` : ''}.`);
    else if (sec.top10_percent != null && sec.top10_percent > 50) warnings.push(`Top-10 wallets hold ~${Math.round(sec.top10_percent)}% of supply — concentration risk.`);
    else if (sec.top10_percent != null && sec.top10_percent > 30) warnings.push('Top wallet concentration is medium.');
  } else warnings.push('Holder data is unavailable on this chain — concentration is unknown.');

  if (scores.contract_safety != null) {
    if (scores.contract_safety >= 70) positives.push('Contract safety checks are above average.');
    else if (scores.contract_safety < 50) warnings.push('Contract has risky properties — review the security flags before going further.');
    if (sec.lp_locked_percent != null && sec.lp_locked_percent >= 80) positives.push('Most liquidity is locked or burned.');
    if ((sec.buy_tax ?? 0) + (sec.sell_tax ?? 0) > 0.05) warnings.push(`Trading taxes total ~${Math.round(((sec.buy_tax ?? 0) + (sec.sell_tax ?? 0)) * 100)}%.`);
  } else warnings.push('Contract risk data is unavailable — safety is unknown.');

  if (i.age_days != null && i.age_days < 30) warnings.push(`Token is young (${i.age_days} day${i.age_days === 1 ? '' : 's'} old) — history is too short to trust patterns.`);

  const t = scores.timing;
  const timing_view =
    t == null
      ? 'Platform market-regime data is unavailable right now, so the timing read is neutral by default.'
      : t >= 65
        ? 'The broader market backdrop is supportive — BTC regime, leverage and macro conditions lean risk-on, which historically helps setups like this.'
        : t >= 45
          ? 'The broader market backdrop is mixed — no strong tailwind or headwind. Stronger confirmation is needed before this becomes a strong setup.'
          : 'The broader market backdrop is a headwind — BTC regime or macro conditions are risk-off. Even good tokens struggle in this environment.';
  if (t != null && t < 45) warnings.push('Market timing is unfavourable — the token still depends on broader market stability.');

  const summary = severe.length
    ? `Token Position Radar rates this token High Risk / Avoid for Now: ${severe[0]} ${positives.length ? `Some metrics look fine (${positives[0]?.toLowerCase()}), but severe risk overrides everything else.` : 'Severe risk overrides the other metrics.'}`
    : `Token Position Radar found that this token is currently a ${rating}. ${positives.slice(0, 2).join(' ')} ${warnings.length ? `However: ${warnings[0].toLowerCase()}` : ''} ${scores.opportunity >= 65 ? 'The setup is better than average, but it still needs monitoring.' : scores.opportunity >= 50 ? 'The setup is not confirmed yet — patience is reasonable here.' : 'The setup is weak right now.'}`;

  return { positives, warnings, timing_view, summary: summary.replace(/\s+/g, ' ').trim() };
};

// ── Quota: scans today (stored reports, fresh ones only) vs the plan limit. ──
export const scansToday = async (userId: string): Promise<number> => {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from('token_analysis_reports')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', start.toISOString());
  return count ?? 0;
};

const cachedReport = async (chain: string, address: string) => {
  const since = new Date(Date.now() - CACHE_MINUTES * 60_000).toISOString();
  const { data } = await supabase
    .from('token_analysis_reports')
    .select('*')
    .eq('chain', chain)
    .ilike('token_address', address)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowToReport = (row: any, chain: ChainConfig, cached: boolean): TokenReport => ({
  id: row.id,
  cached,
  token: {
    name: row.token_name,
    symbol: row.token_symbol,
    chain: row.chain,
    chain_name: chain.name,
    address: row.token_address,
    explorer_url: `${chain.explorerUrl}${row.token_address}`,
    pair_url: row.raw_data?.pair_url ?? null,
    dex: row.raw_data?.dex ?? null,
    price: row.price != null ? Number(row.price) : null,
    market_cap: row.market_cap != null ? Number(row.market_cap) : null,
    fdv: row.fdv != null ? Number(row.fdv) : null,
    liquidity: row.liquidity != null ? Number(row.liquidity) : null,
    volume_24h: row.volume_24h != null ? Number(row.volume_24h) : null,
    holders: row.holders,
    age_days: row.age_days
  },
  scores: {
    opportunity: row.opportunity_score,
    risk: row.risk_score,
    momentum: row.momentum_score,
    liquidity: row.liquidity_score,
    holder_health: row.holder_health_score,
    contract_safety: row.contract_safety_score,
    timing: row.timing_score,
    confidence: row.confidence_score
  },
  rating: row.final_rating,
  action_label: row.action_label,
  summary: row.summary,
  positives: row.positives ?? [],
  warnings: row.warnings ?? [],
  timing_view: row.timing_view ?? '',
  confidence_note: row.raw_data?.confidence_note ?? '',
  disclaimer: DISCLAIMER,
  created_at: row.created_at
});

export type AnalyzeOutcome =
  | { status: 'completed'; report: TokenReport }
  | { status: 'matches'; matches: Extract<ResolveResult, { kind: 'matches' }>['matches'] }
  | { status: 'error'; message: string };

/**
 * Full analysis for one input. `fresh` skips the cache (a fresh scan always
 * consumes quota, so it's self-limiting on every plan). `ensureQuota` runs only
 * when a real (non-cached) analysis is about to happen — cache hits are free.
 */
export const analyzeToken = async (chainSlug: string, input: string, userId: string, fresh = false, ensureQuota?: () => Promise<void>): Promise<AnalyzeOutcome> => {
  const chain = chainOf(chainSlug);
  if (!chain) throw new AppError('Unsupported network. Pick one of the supported chains.', 400);

  const resolved = await resolveToken(chain, input);
  if (resolved.kind === 'error') return { status: 'error', message: resolved.message };
  if (resolved.kind === 'matches') return { status: 'matches', matches: resolved.matches };

  const pair = resolved.pair;
  const address = pair.baseToken.address;

  // Cache: same chain+token within the window → reuse (no quota, no provider calls).
  if (!fresh) {
    const hit = await cachedReport(chain.slug, address);
    if (hit) return { status: 'completed', report: rowToReport(hit, chain, true) };
  }

  // A real scan is about to run — enforce the daily allowance now (cache hits
  // and ticker-match lookups never reach this point, so they stay free).
  if (ensureQuota) await ensureQuota();

  // Fetch security + market context in parallel (each graceful).
  const [security, market] = await Promise.all([tokenSecurityDetail(chain.goplusNetwork ?? chain.slug, address), marketContext()]);

  const age_days = pair.pairCreatedAt ? Math.max(0, Math.floor((Date.now() - pair.pairCreatedAt) / 86_400_000)) : null;
  const si: ScoringInput = {
    liquidity_usd: pair.liquidity?.usd ?? null,
    volume_24h: pair.volume?.h24 ?? null,
    market_cap: pair.marketCap ?? null,
    fdv: pair.fdv ?? null,
    price_change_h1: pair.priceChange?.h1 ?? null,
    price_change_h6: pair.priceChange?.h6 ?? null,
    price_change_h24: pair.priceChange?.h24 ?? null,
    buys_24h: pair.txns?.h24?.buys ?? null,
    sells_24h: pair.txns?.h24?.sells ?? null,
    age_days,
    security,
    market,
    input_type: resolved.input_type
  };

  const { scores, rating, severe, confidence_note } = computeScores(si, true);
  const { positives, warnings, timing_view, summary } = buildNarrative(si, scores, rating, severe);
  const action_label = actionFor(rating);

  const row = {
    user_id: userId,
    chain: chain.slug,
    token_address: address,
    token_name: pair.baseToken.name ?? null,
    token_symbol: pair.baseToken.symbol ?? null,
    input_type: resolved.input_type,
    raw_input: input.trim().slice(0, 120),
    price: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    market_cap: si.market_cap,
    fdv: si.fdv,
    liquidity: si.liquidity_usd,
    volume_24h: si.volume_24h,
    holders: security.holder_count,
    age_days,
    opportunity_score: scores.opportunity,
    risk_score: scores.risk,
    momentum_score: scores.momentum,
    liquidity_score: scores.liquidity,
    holder_health_score: scores.holder_health,
    contract_safety_score: scores.contract_safety,
    timing_score: scores.timing,
    confidence_score: scores.confidence,
    final_rating: rating,
    action_label,
    summary,
    positives,
    warnings,
    timing_view,
    raw_data: { pair_url: pair.url, dex: pair.dexId, confidence_note, security: security as TokenSecurityDetail, market, price_change: pair.priceChange ?? {}, txns: pair.txns ?? {} }
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
