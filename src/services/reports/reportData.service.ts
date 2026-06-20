import { supabase } from '../../config/supabase';
import { readSeries } from '../series/store';
import { computeCycleRisk } from '../btc-cycle/cycle-risk';
import { roiFromEvent } from '../btc-cycle/roi';
import { CYCLE_LOWS, HALVINGS } from '../btc-cycle/events';
import { getMarketSnapshot } from '../altcoin-btc/market.service';
import { socialLabel } from '../social/social-risk';
import { computeConfidence, type SignalMetrics } from '../altcoin-btc/signal-quality';
import { computeAltcoinSeason } from '../altcoin-btc/altcoin-season.service';
import { computeExitStrategy } from '../exit-strategy/exitStrategy.service';
import { getProfile } from '../exit-strategy/exitStrategySettings.service';
import { buildSimExample, type SimExample } from '../exit-strategy/exitSimulator.service';
import { computeLogRegression } from '../log-regression/logRegression.service';
import { buildAltBtcReportSummary } from '../alt-btc-bottom/altBtcBottom.service';
import { getSupplyProfitLossLatest } from '../sync/supply-profit-loss.service';

// ─────────────────────────────────────────────────────────────────────────────
// reportData.service — builds ONE structured snapshot of the whole platform at
// generation time. Each module is read defensively: a missing module never
// throws, it just records `unavailable` in `availability` so the generator can
// disclose it ("On-chain data unavailable for this report."). The snapshot is
// stored verbatim on the report so it stays historically accurate.
// ─────────────────────────────────────────────────────────────────────────────

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'special' | 'premium' | 'preview';
export type ModuleStatus = 'available' | 'unavailable';

const LOOKBACK: Record<ReportType, number> = { daily: 1, weekly: 7, monthly: 30, special: 1, premium: 7, preview: 1 };

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// 0–1 risk → DCA zone label. Six tiers so "low-risk" is distinct from
// "extreme accumulation" — avoids saying "Aggressive" then "not an extreme bottom".
const dcaZone = (r: number): string =>
  r < 0.15
    ? 'Extreme accumulation zone'
    : r < 0.25
      ? 'Low-risk DCA zone'
      : r < 0.4
        ? 'Good DCA zone'
        : r < 0.6
          ? 'Neutral / normal DCA'
          : r < 0.8
            ? 'Caution zone'
            : 'Distribution / high-risk zone';
const riskBand = (r: number): string => (r < 0.4 ? 'low-to-moderate' : r < 0.6 ? 'moderate' : r < 0.8 ? 'elevated' : 'high');

export interface ReportSnapshot {
  period: { type: ReportType; report_date: string; start: string | null; end: string | null; lookback_days: number };
  btc_price: number | null;
  risk: {
    score: number | null;
    band: string | null;
    dca_zone: string | null;
    price_risk: number | null;
    onchain_risk: number | null;
    social_risk: number | null;
    prev_score: number | null;
    change: number | null;
    trend: 'rising' | 'falling' | 'flat' | null;
    as_of: string | null;
  } | null;
  cycle: {
    btc_price: number;
    risk_score: number;
    risk_label: string;
    reason: string;
    drawdown_from_ath: number;
    distance_from_200ma: number | null;
    rsi: number | null;
    ytd_roi: number | null;
    roi_from_low_pct: number | null;
    roi_from_halving_pct: number | null;
  } | null;
  onchain: {
    mvrv_zscore: number | null;
    puell_multiple: number | null;
    nupl: number | null;
    reserve_risk: number | null;
    composite: number | null;
    prev_composite: number | null;
    change: number | null;
    supply: { profit_pct: number; loss_pct: number; spread: number; state: string; signal: string } | null;
    as_of: string | null;
  } | null;
  social: {
    score: number | null;
    label: string | null;
    prev_score: number | null;
    change: number | null;
    fear_greed: number | null;
    google_trends: number | null;
    wikipedia: number | null;
    youtube: number | null;
    as_of: string | null;
  } | null;
  altcoin: {
    regime: string;
    btc_dominance: number | null;
    breadth_pct: number | null;
    positive_pct: number | null;
    index: number | null;
    strongest: { symbol: string; name: string; label: string; score: number | null; confidence: string; image: string | null }[];
    weakest: { symbol: string; name: string; label: string; score: number | null; confidence: string; image: string | null }[];
    as_of: string | null;
  } | null;
  ecosystem: {
    regime: string;
    strongest: { name: string; signal: string; score: number | null; tvl_change_7d: number | null; image: string | null }[];
    weakest: { name: string; signal: string; score: number | null; image: string | null }[];
  } | null;
  exit: {
    score: number;
    percent: number;
    label: string;
    action: string;
    current_action: string;
    current_reason: string;
    next_threshold: { score: number; label: string } | null;
    confidence: string;
    social_status: 'active' | 'partial' | 'unavailable';
    social_label: string;
    signal_upgrade: string[];
    sim_example: SimExample | null;
  } | null;
  logreg: {
    btc: { price: number; fit_price: number; zone_label: string; distance_from_fit_percent: number; risk_score: number; bubble_lower_band: number; lower_band: number } | null;
    eth: { price: number; fit_price: number; zone_label: string; distance_from_fit_percent: number; risk_score: number; bubble_lower_band: number; lower_band: number } | null;
  } | null;
  derivatives: {
    leverage_risk: number;
    leverage_percent: number;
    label: string;
    funding_high: boolean;
    funding_negative: boolean;
    oi_rising: boolean;
  } | null;
  alt_btc_bottom: {
    text_en: string;
    text_sw: string;
    above_ma50_percent: number;
    confirmed: number;
    early: number;
    leaders: string[];
  } | null;
  watchlist: null; // per-user; not part of the global market snapshot
  sectors: null; // sector-rankings module not yet implemented
  availability: Record<string, ModuleStatus>;
}

// ── BTC risk + categories (+ trend vs the lookback window) ──
const buildRisk = async (lookback: number): Promise<ReportSnapshot['risk']> => {
  const { data: latest } = await supabase
    .from('risk_summary_daily')
    .select('snapshot_date, summary_risk')
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest?.snapshot_date || latest.summary_risk == null) return null;

  const asOf = latest.snapshot_date as string;
  const score = Number(latest.summary_risk);

  const { data: cats } = await supabase.from('risk_category_daily').select('category, risk').eq('snapshot_date', asOf);
  const byCat = Object.fromEntries((cats ?? []).map((c) => [c.category, c.risk]));

  const { data: prev } = await supabase
    .from('risk_summary_daily')
    .select('summary_risk')
    .lte('snapshot_date', addDays(asOf, -lookback))
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const prevScore = prev?.summary_risk == null ? null : Number(prev.summary_risk);
  const change = prevScore == null ? null : Number((score - prevScore).toFixed(3));
  const trend = change == null ? null : change > 0.02 ? 'rising' : change < -0.02 ? 'falling' : 'flat';

  return {
    score: Number(score.toFixed(3)),
    band: riskBand(score),
    dca_zone: dcaZone(score),
    price_risk: byCat.price ?? null,
    onchain_risk: byCat.onchain ?? null,
    social_risk: byCat.social ?? null,
    prev_score: prevScore,
    change,
    trend,
    as_of: asOf
  };
};

const buildCycle = async (): Promise<ReportSnapshot['cycle']> => {
  const series = await readSeries('btc-full');
  if (series.length < 250) return null;
  const c = computeCycleRisk(series);
  const lastLow = roiFromEvent(series, CYCLE_LOWS[CYCLE_LOWS.length - 1]);
  const lastHalving = roiFromEvent(series, HALVINGS[HALVINGS.length - 1]);
  const lastRoi = (s: ReturnType<typeof roiFromEvent>) => (s && s.points.length ? Number(s.points[s.points.length - 1].roi_percent.toFixed(1)) : null);
  return {
    btc_price: c.btc_price,
    risk_score: c.risk_score,
    risk_label: c.risk_label,
    reason: c.reason,
    drawdown_from_ath: c.drawdown_from_ath,
    distance_from_200ma: c.distance_from_200ma,
    rsi: c.rsi,
    ytd_roi: c.ytd_roi,
    roi_from_low_pct: lastRoi(lastLow),
    roi_from_halving_pct: lastRoi(lastHalving)
  };
};

const ONCHAIN_KEYS = ['mvrv_zscore', 'puell_multiple', 'nupl', 'reserve_risk'] as const;
const buildOnchain = async (lookback: number): Promise<ReportSnapshot['onchain']> => {
  const { data: latestDate } = await supabase
    .from('risk_metric_daily')
    .select('snapshot_date')
    .in('metric_key', ONCHAIN_KEYS as unknown as string[])
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const asOf = latestDate?.snapshot_date ?? null;

  const raw: Record<string, number | null> = { mvrv_zscore: null, puell_multiple: null, nupl: null, reserve_risk: null };
  if (asOf) {
    const { data: rows } = await supabase.from('risk_metric_daily').select('metric_key, raw_value').eq('snapshot_date', asOf).in('metric_key', ONCHAIN_KEYS as unknown as string[]);
    for (const r of rows ?? []) raw[r.metric_key] = r.raw_value == null ? null : Number(r.raw_value);
  }

  const { data: comp } = await supabase
    .from('risk_category_daily')
    .select('risk')
    .eq('category', 'onchain')
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const composite = comp?.risk == null ? null : Number(comp.risk);

  let prevComposite: number | null = null;
  if (asOf) {
    const { data: prev } = await supabase
      .from('risk_category_daily')
      .select('risk')
      .eq('category', 'onchain')
      .lte('snapshot_date', addDays(asOf, -lookback))
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    prevComposite = prev?.risk == null ? null : Number(prev.risk);
  }
  const change = composite != null && prevComposite != null ? Number((composite - prevComposite).toFixed(3)) : null;

  let supply: { profit_pct: number; loss_pct: number; spread: number; state: string; signal: string } | null = null;
  try {
    const s = await getSupplyProfitLossLatest();
    if (s) supply = { profit_pct: s.supply_in_profit_percent, loss_pct: s.supply_in_loss_percent, spread: s.profit_loss_spread, state: s.current_state, signal: s.signal };
  } catch {
    /* supply optional */
  }

  if (!asOf && composite == null && !supply) return null;
  return {
    mvrv_zscore: raw.mvrv_zscore,
    puell_multiple: raw.puell_multiple,
    nupl: raw.nupl,
    reserve_risk: raw.reserve_risk,
    composite,
    prev_composite: prevComposite,
    change,
    supply,
    as_of: asOf
  };
};

const buildSocial = async (lookback: number): Promise<ReportSnapshot['social']> => {
  const { data } = await supabase
    .from('btc_social_metrics')
    .select('date, social_risk_score, fear_greed_index, google_trends_bitcoin, wikipedia_bitcoin_views, youtube_bitcoin_attention')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const score = data.social_risk_score == null ? null : Number(data.social_risk_score);

  let prevScore: number | null = null;
  if (data.date) {
    const { data: prev } = await supabase
      .from('btc_social_metrics')
      .select('social_risk_score')
      .lte('date', addDays(data.date, -lookback))
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    prevScore = prev?.social_risk_score == null ? null : Number(prev.social_risk_score);
  }
  const change = score != null && prevScore != null ? Number((score - prevScore).toFixed(3)) : null;

  return {
    score,
    label: score == null ? null : socialLabel(score),
    prev_score: prevScore,
    change,
    fear_greed: data.fear_greed_index ?? null,
    google_trends: data.google_trends_bitcoin ?? null,
    wikipedia: data.wikipedia_bitcoin_views ?? null,
    youtube: data.youtube_bitcoin_attention ?? null,
    as_of: data.date ?? null
  };
};

const altRegime = (breadth: number | null): string => {
  if (breadth == null) return 'Undetermined';
  if (breadth >= 60) return 'Broad altcoin strength';
  if (breadth >= 40) return 'Neutral-to-improving';
  if (breadth >= 20) return 'Selective strength';
  return 'BTC-dominant / weak alts';
};

const buildAltcoin = async (): Promise<ReportSnapshot['altcoin']> => {
  let breadth: number | null = null;
  let dominance: number | null = null;
  try {
    const snap = await getMarketSnapshot();
    breadth = snap.percent_outperforming_30d == null ? null : Number(snap.percent_outperforming_30d.toFixed(1));
    dominance = snap.current_btc_dominance;
  } catch {
    /* market snapshot optional */
  }

  const { data: latest } = await supabase.from('altcoin_btc_signals').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
  type AltEntry = { symbol: string; name: string; label: string; score: number | null; confidence: string; image: string | null };
  let strongest: AltEntry[] = [];
  let weakest: AltEntry[] = [];
  let asOf: string | null = null;
  if (latest?.date) {
    asOf = latest.date as string;
    const { data: rows } = await supabase
      .from('altcoin_btc_signals')
      .select('signal_label, strength_score, details, coin:coins(symbol, name, image_url)')
      .eq('date', asOf);
    const mapped = (rows ?? []).map((r) => {
      const coin = Array.isArray(r.coin) ? r.coin[0] : r.coin;
      const d = (r.details ?? {}) as Record<string, number | boolean | null>;
      const metrics: SignalMetrics = {
        strength_7d: (d.strength_7d as number) ?? null,
        strength_30d: (d.strength_30d as number) ?? null,
        strength_90d: (d.strength_90d as number) ?? null,
        above_ma50: Boolean(d.above_ma50),
        above_ma200: Boolean(d.above_ma200),
        volume_breakout: (d.volume_breakout as number) ?? null,
        market_cap: (d.market_cap as number) ?? null,
        total_volume: (d.total_volume as number) ?? null,
        market_cap_rank: (d.market_cap_rank as number) ?? null,
        history_days: (d.history_days as number) ?? 0
      };
      return { symbol: (coin?.symbol ?? '').toUpperCase(), name: coin?.name ?? '', label: r.signal_label ?? '', score: r.strength_score == null ? null : Number(r.strength_score), confidence: computeConfidence(metrics), image: (coin as { image_url?: string } | null)?.image_url ?? null };
    });
    const ranked = mapped.filter((m) => m.score != null).sort((a, b) => (b.score as number) - (a.score as number));
    strongest = ranked.slice(0, 5);
    weakest = ranked.slice(-5).reverse();
  }

  if (breadth == null && !asOf) return null;

  // Richer regime + absolute-breadth from the robust Altcoin Season service.
  let regime = altRegime(breadth);
  let positivePct: number | null = null;
  let index: number | null = null;
  try {
    const season = await computeAltcoinSeason('30d', 'premium_clean');
    regime = season.regime_label;
    breadth = season.outperforming_btc_percent;
    positivePct = season.positive_return_percent;
    index = season.altcoin_season_index;
  } catch {
    /* fall back to the market-snapshot breadth */
  }

  return { regime, btc_dominance: dominance, breadth_pct: breadth, positive_pct: positivePct, index, strongest, weakest, as_of: asOf };
};

interface EcoMetrics {
  strength_score?: number | null;
  signal?: string | null;
  tvl_change_7d?: number | null;
}
const buildEcosystem = async (): Promise<ReportSnapshot['ecosystem']> => {
  const { data } = await supabase
    .from('ecosystems')
    .select('name, native_coin_gecko_id, metrics:ecosystem_metrics (strength_score, signal, tvl_change_7d)')
    .eq('is_active', true);
  if (!data?.length) return null;

  // Native-coin logos + symbols (ecosystems.native_coin_gecko_id ↔ coins.coingecko_id).
  const geckoIds = data.map((r) => r.native_coin_gecko_id).filter((g): g is string => !!g);
  const coinByGecko = new Map<string, { symbol: string; image: string | null }>();
  if (geckoIds.length) {
    const { data: coins } = await supabase.from('coins').select('coingecko_id, symbol, image_url').in('coingecko_id', geckoIds);
    for (const c of coins ?? []) coinByGecko.set(c.coingecko_id, { symbol: (c.symbol ?? '').toUpperCase(), image: c.image_url ?? null });
  }
  // Use the ticker as the display name only when the brand IS the ticker
  // (e.g. "Near" → "NEAR", "Sui" → "SUI"), never for real names ("Cosmos" stays).
  const displayName = (name: string, symbol: string | undefined): string => (symbol && name.toUpperCase() === symbol ? symbol : name);

  const rows = data
    .map((r) => {
      const m = (Array.isArray(r.metrics) ? r.metrics[0] : r.metrics) as EcoMetrics | null;
      const coin = r.native_coin_gecko_id ? coinByGecko.get(r.native_coin_gecko_id) : undefined;
      return {
        name: displayName(r.name as string, coin?.symbol),
        image: coin?.image ?? null,
        signal: m?.signal ?? 'Neutral',
        score: m?.strength_score == null ? null : Number(m.strength_score),
        tvl_change_7d: m?.tvl_change_7d == null ? null : Number(m.tvl_change_7d)
      };
    })
    .filter((r) => r.score != null)
    .sort((a, b) => (b.score as number) - (a.score as number));
  if (!rows.length) return null;
  const improving = rows.filter((r) => /improv|strength|breakout/i.test(r.signal)).length;
  const regime = improving >= Math.ceil(rows.length / 2) ? 'Broad ecosystem rotation' : improving >= 2 ? 'Selective ecosystem rotation' : 'No broad ecosystem rotation yet';
  return {
    regime,
    strongest: rows.slice(0, 4).map((r) => ({ name: r.name, signal: r.signal, score: r.score, tvl_change_7d: r.tvl_change_7d, image: r.image })),
    weakest: rows.slice(-3).reverse().map((r) => ({ name: r.name, signal: r.signal, score: r.score, image: r.image }))
  };
};

/** Assemble the full snapshot for a report period. Never throws on a missing module. */
export const buildSnapshot = async (type: ReportType, reportDate: string): Promise<ReportSnapshot> => {
  const lookback = LOOKBACK[type] ?? 1;
  const availability: Record<string, ModuleStatus> = {};
  const guard = async <T>(key: string, fn: () => Promise<T | null>): Promise<T | null> => {
    try {
      const v = await fn();
      availability[key] = v == null ? 'unavailable' : 'available';
      return v;
    } catch {
      availability[key] = 'unavailable';
      return null;
    }
  };

  const buildExit = async () => {
    const r = await computeExitStrategy();
    const profile = await getProfile();
    return {
      score: r.exit_risk_score,
      percent: r.exit_risk_percent,
      label: r.strategy_label,
      action: r.suggested_action,
      current_action: r.current_action.action,
      current_reason: r.current_action.reason,
      next_threshold: r.next_threshold ? { score: r.next_threshold.score, label: r.next_threshold.label } : null,
      confidence: r.confidence,
      social_status: r.social.status,
      social_label: r.social.label,
      signal_upgrade: r.signal_changes.upgrade.slice(0, 3),
      // Generic $10k example only — never a user's private portfolio.
      sim_example: buildSimExample(profile, r.exit_risk_score, r.strategy_label)
    };
  };

  const oneReg = async (asset: 'BTC' | 'ETH') => {
    try {
      const r = await computeLogRegression(asset);
      if (!r.fit_valid || !r.latest) return null; // only include a trustworthy long-term fit
      const l = r.latest;
      return { price: l.price_usd, fit_price: l.fit_price, zone_label: l.zone_label, distance_from_fit_percent: l.distance_from_fit_percent, risk_score: l.risk_score, bubble_lower_band: l.bubble_lower_band, lower_band: l.lower_band };
    } catch {
      return null;
    }
  };
  const buildLogReg = async () => {
    const [btc, eth] = await Promise.all([oneReg('BTC'), oneReg('ETH')]);
    if (!btc && !eth) return null;
    return { btc, eth };
  };

  const buildDerivatives = async (): Promise<ReportSnapshot['derivatives']> => {
    const { data } = await supabase
      .from('derivatives_daily')
      .select('leverage_risk, leverage_percent, label, btc_funding_rate, btc_open_interest')
      .order('date', { ascending: false })
      .limit(2);
    if (!data || !data.length || data[0].leverage_risk == null) return null;
    const cur = data[0];
    const prev = data[1];
    return {
      leverage_risk: Number(cur.leverage_risk),
      leverage_percent: cur.leverage_percent == null ? Math.round(Number(cur.leverage_risk) * 100) : Number(cur.leverage_percent),
      label: (cur.label as string) ?? 'Normal',
      funding_high: cur.btc_funding_rate != null && Number(cur.btc_funding_rate) > 0.0003,
      funding_negative: cur.btc_funding_rate != null && Number(cur.btc_funding_rate) < 0,
      oi_rising: cur.btc_open_interest != null && prev?.btc_open_interest != null && Number(cur.btc_open_interest) > Number(prev.btc_open_interest) * 1.03
    };
  };

  const buildAltBtcBottom = async (): Promise<ReportSnapshot['alt_btc_bottom']> => {
    const { data: b } = await supabase.from('alt_btc_bottom_breadth_daily').select('*').order('date', { ascending: false }).limit(1).maybeSingle();
    if (!b) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = buildAltBtcReportSummary(b as any);
    const { data: leaders } = await supabase
      .from('alt_btc_bottom_daily')
      .select('symbol, status_label, bottom_score')
      .eq('date', b.date)
      .in('status_label', ['Confirmed recovery', 'Relative strength leader'])
      .order('bottom_score', { ascending: false })
      .limit(3);
    return {
      text_en: summary.text_en,
      text_sw: summary.text_sw,
      above_ma50_percent: Number(b.above_ma50_percent ?? 0),
      confirmed: Number(b.confirmed_strength_count ?? 0) + Number(b.leadership_count ?? 0),
      early: Number(b.early_recovery_count ?? 0),
      leaders: (leaders ?? []).map((l) => `${(l.symbol as string) ?? ''}/BTC`)
    };
  };

  const [risk, cycle, onchain, social, altcoin, ecosystem, exit, logreg, derivatives, alt_btc_bottom] = await Promise.all([
    guard('btc_risk', () => buildRisk(lookback)),
    guard('btc_cycle', () => buildCycle()),
    guard('onchain', () => buildOnchain(lookback)),
    guard('social', () => buildSocial(lookback)),
    guard('altcoin_btc', () => buildAltcoin()),
    guard('ecosystem', () => buildEcosystem()),
    guard('exit_strategy', () => buildExit()),
    guard('log_regression', () => buildLogReg()),
    guard('derivatives', () => buildDerivatives()),
    guard('alt_btc_bottom', () => buildAltBtcBottom())
  ]);
  availability.watchlist = 'unavailable'; // per-user, not part of the global snapshot
  availability.sectors = 'unavailable'; // module not implemented yet

  return {
    period: { type, report_date: reportDate, start: addDays(reportDate, -lookback), end: reportDate, lookback_days: lookback },
    btc_price: cycle?.btc_price ?? null,
    risk,
    cycle,
    onchain,
    social,
    altcoin,
    ecosystem,
    exit,
    logreg,
    derivatives,
    alt_btc_bottom,
    watchlist: null,
    sectors: null,
    availability
  };
};
