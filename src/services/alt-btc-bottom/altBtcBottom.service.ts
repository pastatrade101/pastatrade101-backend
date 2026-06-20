import type { SeriesRow } from '../series/store';

// ─────────────────────────────────────────────────────────────────────────────
// Alt/BTC Bottom Radar — pure relative-strength engine. Works on the ALT/BTC
// ratio (alt USD / BTC USD), NOT USD performance. Detects bottoming / recovery /
// invalidation conditions. NEVER a buy signal — research labels only.
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const r2 = (n: number) => Math.round(n);
const round = (n: number | null, d = 4) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const ma = (a: number[], n: number): number | null => (a.length >= n ? mean(a.slice(-n)) : null);
const ret = (a: number[], k: number): number | null => (a.length > k && a[a.length - 1 - k] > 0 ? a[a.length - 1] / a[a.length - 1 - k] - 1 : null);
const ddFromHigh = (a: number[], n: number): number | null => {
  if (a.length < 2) return null;
  const w = a.slice(-Math.min(n, a.length));
  const hi = Math.max(...w);
  return hi > 0 ? a[a.length - 1] / hi - 1 : null;
};
const distFromLow = (a: number[], n: number): number | null => {
  if (a.length < 2) return null;
  const w = a.slice(-Math.min(n, a.length));
  const lo = Math.min(...w);
  return lo > 0 ? a[a.length - 1] / lo - 1 : null;
};

export type AltBtcStatus = 'Still bleeding' | 'Bottoming attempt' | 'Early recovery' | 'Confirmed recovery' | 'Relative strength leader' | 'Failed recovery';

export interface CoinMeta {
  coin_id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
  category?: string | null;
  volume?: number | null;
}

export interface AltBtcMetrics extends CoinMeta {
  alt_usd_price: number | null;
  btc_usd_price: number | null;
  alt_btc_ratio: number | null;
  alt_btc_ma20: number | null;
  alt_btc_ma50: number | null;
  alt_btc_ma100: number | null;
  alt_btc_ma200: number | null;
  alt_btc_return_7d: number | null;
  alt_btc_return_14d: number | null;
  alt_btc_return_30d: number | null;
  alt_btc_return_60d: number | null;
  alt_btc_return_90d: number | null;
  drawdown_from_90d_high: number | null;
  drawdown_from_180d_high: number | null;
  drawdown_from_365d_high: number | null;
  distance_from_30d_low: number | null;
  distance_from_90d_low: number | null;
  distance_from_180d_low: number | null;
  distance_from_365d_low: number | null;
  structure_label: 'higher_low' | 'lower_low' | 'equal_low';
  above_ma20: boolean;
  above_ma50: boolean;
  above_ma200: boolean;
  volume_confirming: boolean;
  bottom_score: number;
  confirmation_score: number;
  invalidation_risk_score: number;
  status_label: AltBtcStatus;
  confidence: 'High' | 'Medium' | 'Low';
  key_reason: string;
  what_to_watch_next: string[];
  risk_flags: string[];
}

const pctTxt = (n: number | null) => (n == null ? 'n/a' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}%`);

/**
 * Compute Alt/BTC bottom metrics for one coin.
 * @param altRows alt USD daily series (oldest→newest)
 * @param btcByDate map of date→BTC USD price
 * @param meta coin metadata
 * @param ctx market context (BTC dominance change, liquidity threshold)
 */
export const computeAltBtc = (altRows: SeriesRow[], btcByDate: Map<string, number>, meta: CoinMeta, ctx: { domRising: boolean; minVolume: number }): AltBtcMetrics | null => {
  // Build the date-aligned ALT/BTC ratio series.
  const ratio: number[] = [];
  const vol: number[] = [];
  for (const r of altRows) {
    if (r.price == null || !Number.isFinite(r.price)) continue;
    const btc = btcByDate.get(r.date);
    if (!btc || btc <= 0) continue;
    ratio.push(r.price / btc);
    vol.push(r.volume ?? 0);
  }
  if (ratio.length < 60) return null; // not enough history to judge

  const cur = ratio[ratio.length - 1];
  const m20 = ma(ratio, 20);
  const m50 = ma(ratio, 50);
  const m100 = ma(ratio, 100);
  const m200 = ma(ratio, 200);
  const aboveMA20 = m20 != null && cur > m20;
  const aboveMA50 = m50 != null && cur > m50;
  const aboveMA100 = m100 != null && cur > m100;
  const aboveMA200 = m200 != null && cur > m200;

  const ret7 = ret(ratio, 7);
  const ret14 = ret(ratio, 14);
  const ret30 = ret(ratio, 30);
  const ret60 = ret(ratio, 60);
  const ret90 = ret(ratio, 90);

  const dd90 = ddFromHigh(ratio, 90);
  const dd180 = ddFromHigh(ratio, 180);
  const dd365 = ddFromHigh(ratio, 365);
  const dl30 = distFromLow(ratio, 30);
  const dl90 = distFromLow(ratio, 90);
  const dl180 = distFromLow(ratio, 180);
  const dl365 = distFromLow(ratio, 365);

  // Structure: recent low (last 30) vs prior low (30–90).
  const recentLow = Math.min(...ratio.slice(-30));
  const priorWindow = ratio.slice(-90, -30);
  const priorLow = priorWindow.length ? Math.min(...priorWindow) : recentLow;
  const structure: AltBtcMetrics['structure_label'] = recentLow > priorLow * 1.005 ? 'higher_low' : recentLow < priorLow * 0.995 ? 'lower_low' : 'equal_low';
  const nearNewLow = (dl90 ?? 1) < 0.03;
  const poppedThenFell = !aboveMA50 && m50 != null && Math.max(...ratio.slice(-30)) > m50;

  // Volume confirmation: last 14d avg vs prior 14d avg.
  const v14 = mean(vol.slice(-14));
  const v28 = mean(vol.slice(-28, -14));
  const volRising = v14 > 0 && v28 > 0 && v14 > v28 * 1.05;
  const lowLiq = (meta.volume ?? 0) < ctx.minVolume;

  // ── Sub-scores ──
  const exhaustion = clamp01(Math.abs(dd365 ?? dd180 ?? 0) / 0.8);
  const d = dl180 ?? dl90 ?? 0; // distance off the low
  const distLowScore = clamp01(d <= 0.15 ? 0.1 + (d / 0.15) * 0.9 : 1 - (d - 0.15) / 0.6);
  const maRecovery = (aboveMA20 ? 0.4 : 0) + (aboveMA50 ? 0.4 : 0) + (aboveMA100 ? 0.2 : 0);
  const momentum = clamp01((((ret30 ?? -0.08) + 0.08) / 0.28) * 0.6 + ((ret14 ?? 0) > 0 ? 0.4 : 0));
  const structureScore = structure === 'higher_low' ? 1 : structure === 'equal_low' ? 0.5 : 0;
  const volScore = volRising ? 1 : 0.4;
  const dataQuality = (ratio.length >= 300 ? 1 : ratio.length >= 200 ? 0.7 : 0.5) * (v14 > 0 ? 1 : 0.8);

  const bottom_score = r2(100 * clamp01(0.25 * exhaustion + 0.2 * distLowScore + 0.2 * maRecovery + 0.15 * momentum + 0.1 * structureScore + 0.05 * volScore + 0.05 * dataQuality));
  const confirmation_score = r2(100 * clamp01((aboveMA50 ? 0.35 : 0) + (aboveMA100 ? 0.2 : 0) + (structure === 'higher_low' ? 0.2 : 0) + ((ret30 ?? 0) > 0 ? 0.15 : 0) + (volRising ? 0.1 : 0)));

  const weakBounce = (dl180 ?? 1) < 0.05 && (ret30 ?? 0) < 0.05;
  const invalidation_risk_score = r2(
    100 *
      clamp01(
        (!aboveMA50 ? 0.18 : 0) + (!aboveMA200 ? 0.12 : 0) + (weakBounce ? 0.15 : 0) + (!volRising ? 0.1 : 0) + (ctx.domRising ? 0.1 : 0) + (lowLiq ? 0.1 : 0) + (nearNewLow ? 0.12 : 0) + ((ret7 ?? 0) < 0 ? 0.13 : 0)
      )
  );

  // ── Status (priority order) ──
  let status: AltBtcStatus;
  if (aboveMA50 && aboveMA200 && (ret30 ?? 0) > 0 && (ret90 ?? 0) > 0) status = 'Relative strength leader';
  else if (aboveMA50 && (ret30 ?? 0) > 0 && structure === 'higher_low') status = 'Confirmed recovery';
  else if ((dl30 ?? 0) >= 0.1 && ((ret14 ?? 0) > 0 || (ret30 ?? 0) > 0) && (aboveMA20 || aboveMA50) && !nearNewLow) status = 'Early recovery';
  else if (poppedThenFell && (ret7 ?? 0) < 0 && nearNewLow) status = 'Failed recovery';
  // Genuinely bleeding: below short MAs, negative 30D, no higher low.
  else if (!aboveMA20 && !aboveMA50 && (ret30 ?? -1) < 0 && structure !== 'higher_low') status = 'Still bleeding';
  // Otherwise it's off/near the low and stabilising, but not yet confirmed.
  else status = 'Bottoming attempt';

  // ── Key reason + what to watch ──
  const reasons: Record<AltBtcStatus, string> = {
    'Relative strength leader': `ALT/BTC is above MA50 and MA200 and outperforming BTC (30D ${pctTxt(ret30)}, 90D ${pctTxt(ret90)}).`,
    'Confirmed recovery': `Higher low confirmed and ALT/BTC above MA50${aboveMA100 ? ' and MA100' : ''}; 30D ${pctTxt(ret30)} vs BTC.`,
    'Early recovery': `Bounced ${pctTxt(dl30)} off its recent low and reclaimed ${aboveMA50 ? 'MA50' : 'MA20'}, but ${aboveMA200 ? 'momentum still building' : 'still below MA200'}.`,
    'Failed recovery': `Reclaimed a moving average then lost it and slid back toward the lows — recovery has not held.`,
    'Bottoming attempt': `Near its BTC-pair low (${pctTxt(dl180)} off the 180D low) and downside is slowing, but recovery is not confirmed yet.`,
    'Still bleeding': `ALT/BTC keeps making lower lows below its moving averages; 30D ${pctTxt(ret30)} vs BTC.`
  };
  const watch: Record<AltBtcStatus, string[]> = {
    'Relative strength leader': ['Holds above MA50 to keep leadership intact', 'Keeps making higher highs vs BTC', '30D & 90D ALT/BTC stay positive'],
    'Confirmed recovery': ['Holds above MA50', 'Reclaims MA200 for full leadership', 'Makes another higher low', '30D ALT/BTC stays positive'],
    'Early recovery': ['ALT/BTC holds above MA50', 'Breaks above the previous lower high', 'Makes another higher low', 'Volume expands during the recovery'],
    'Failed recovery': ['Watch for a break below the recent low (invalidation)', 'Needs to reclaim MA20/MA50 again', 'Wait for downside momentum to slow'],
    'Bottoming attempt': ['Needs to reclaim MA20/MA50', 'Make a higher low', 'Turn 30D ALT/BTC positive', 'Volume picking up'],
    'Still bleeding': ['Wait for downside momentum to slow', 'A higher low to form', 'Reclaim of MA20 as a first sign of life']
  };

  // ── Confidence: data completeness + liquidity + rank + sustained (not a spike) ──
  const spikeOnly = (ret7 ?? 0) > 0.15 && (ret30 ?? 0) <= 0; // big 7d pop but flat/negative 30d
  const confPts = (ratio.length >= 300 ? 1 : 0) + (!lowLiq ? 1 : 0) + ((meta.market_cap_rank ?? 999) <= 50 ? 1 : 0) + (!spikeOnly ? 1 : 0);
  const confidence: AltBtcMetrics['confidence'] = confPts >= 3 ? 'High' : confPts >= 2 ? 'Medium' : 'Low';

  const risk_flags: string[] = [];
  if (!aboveMA50 && !aboveMA200) risk_flags.push('Below MA50 & MA200');
  if (!volRising) risk_flags.push('Volume fading');
  if (nearNewLow) risk_flags.push('Near recent low');
  if (ctx.domRising) risk_flags.push('BTC dominance rising');
  if (lowLiq) risk_flags.push('Low liquidity');
  if (weakBounce) risk_flags.push('Weak / short-term bounce');

  return {
    ...meta,
    alt_usd_price: round(altRows[altRows.length - 1]?.price ?? null, 8),
    btc_usd_price: round(btcByDate.get(altRows[altRows.length - 1]?.date) ?? null, 2),
    alt_btc_ratio: round(cur, 8),
    alt_btc_ma20: round(m20, 8),
    alt_btc_ma50: round(m50, 8),
    alt_btc_ma100: round(m100, 8),
    alt_btc_ma200: round(m200, 8),
    alt_btc_return_7d: round(ret7),
    alt_btc_return_14d: round(ret14),
    alt_btc_return_30d: round(ret30),
    alt_btc_return_60d: round(ret60),
    alt_btc_return_90d: round(ret90),
    drawdown_from_90d_high: round(dd90),
    drawdown_from_180d_high: round(dd180),
    drawdown_from_365d_high: round(dd365),
    distance_from_30d_low: round(dl30),
    distance_from_90d_low: round(dl90),
    distance_from_180d_low: round(dl180),
    distance_from_365d_low: round(dl365),
    structure_label: structure,
    above_ma20: aboveMA20,
    above_ma50: aboveMA50,
    above_ma200: aboveMA200,
    volume_confirming: volRising,
    bottom_score,
    confirmation_score,
    invalidation_risk_score,
    status_label: status,
    confidence,
    key_reason: reasons[status],
    what_to_watch_next: watch[status],
    risk_flags
  };
};

export const statusScoreLabel = (s: number): string =>
  s <= 20 ? 'Still bleeding against BTC' : s <= 40 ? 'Weak / no bottom evidence' : s <= 55 ? 'Possible bottoming attempt' : s <= 70 ? 'Early recovery' : s <= 85 ? 'Confirmed relative-strength recovery' : 'Strong BTC-pair leadership';

// ── Breadth + rotation wave across the universe ──
export interface AltBtcBreadth {
  universe_size: number;
  above_ma20_percent: number;
  above_ma50_percent: number;
  above_ma200_percent: number;
  positive_30d_percent: number;
  higher_low_percent: number;
  bottoming_attempt_count: number;
  early_recovery_count: number;
  confirmed_strength_count: number;
  leadership_count: number;
  still_bleeding_count: number;
  failed_recovery_count: number;
  rotation_wave_label: string;
  breadth_label: string;
  market_takeaway: string;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

export const buildBreadth = (rows: AltBtcMetrics[]): AltBtcBreadth => {
  const n = rows.length;
  const aboveMA50 = pct(rows.filter((r) => r.above_ma50).length, n);
  const count = (s: AltBtcStatus) => rows.filter((r) => r.status_label === s).length;
  const rotation_wave_label =
    aboveMA50 < 15 ? 'Wave 0 · BTC dominance / alt weakness' : aboveMA50 < 30 ? 'Wave 1 · First leaders bottom vs BTC' : aboveMA50 < 50 ? 'Wave 2 · Mid-caps start outperforming BTC' : aboveMA50 < 70 ? 'Wave 3 · Broad altcoin participation' : 'Wave 4 · Late-stage speculative rotation';
  const breadth_label = aboveMA50 < 15 ? 'Broad weakness' : aboveMA50 < 35 ? 'Selective bottoming' : aboveMA50 < 55 ? 'Early rotation' : aboveMA50 < 75 ? 'Broad recovery' : 'Altcoin leadership';
  const confirmed = count('Confirmed recovery') + count('Relative strength leader');
  const early = count('Early recovery');
  const bottoming = count('Bottoming attempt');
  const bleeding = count('Still bleeding');
  const market_takeaway =
    aboveMA50 < 25
      ? `Most of the universe (${100 - aboveMA50}%) remains below its ALT/BTC MA50 — altcoin recovery is still selective, not broad alt season. ${bottoming} bottoming attempts exist and ${early} show early recovery, but confirmation is limited.`
      : `${aboveMA50}% of the universe is above its ALT/BTC MA50 and relative strength is broadening — ${confirmed} in confirmed recovery and ${early} in early recovery, with only ${bleeding} in clear BTC-pair weakness. Rotation is expanding beyond the first leaders, but monitor invalidation risk as late-stage rotation can become noisy.`;

  return {
    universe_size: n,
    above_ma20_percent: pct(rows.filter((r) => r.above_ma20).length, n),
    above_ma50_percent: aboveMA50,
    above_ma200_percent: pct(rows.filter((r) => r.above_ma200).length, n),
    positive_30d_percent: pct(rows.filter((r) => (r.alt_btc_return_30d ?? 0) > 0).length, n),
    higher_low_percent: pct(rows.filter((r) => r.structure_label === 'higher_low').length, n),
    bottoming_attempt_count: bottoming,
    early_recovery_count: early,
    confirmed_strength_count: count('Confirmed recovery'),
    leadership_count: count('Relative strength leader'),
    still_bleeding_count: bleeding,
    failed_recovery_count: count('Failed recovery'),
    rotation_wave_label,
    breadth_label,
    market_takeaway
  };
};

// ── Report summary (prepared for the Report Generator; not wired into reports yet) ──
export const buildAltBtcReportSummary = (b: AltBtcBreadth): { text_en: string; text_sw: string } => {
  const confirmed = b.confirmed_strength_count + b.leadership_count;
  const weak = b.above_ma50_percent < 35;
  const text_en = weak
    ? `Alt/BTC Bottom Radar remains selective. Most assets are still below key BTC-pair moving averages (${b.above_ma50_percent}% above MA50), so altcoin season is not broad yet. ${b.bottoming_attempt_count} bottoming attempts and ${b.early_recovery_count} early recoveries are forming.`
    : `Alt/BTC Bottom Radar shows rotation broadening. ${confirmed} assets have confirmed relative strength and ${b.early_recovery_count} are in early recovery, while ${b.still_bleeding_count} remain in clear BTC-pair weakness. Altcoin participation is expanding beyond the first leaders.`;
  const text_sw = weak
    ? `Alt/BTC Bottom Radar bado ni ya kuchagua. Assets nyingi bado ziko chini ya mistari muhimu ya BTC (${b.above_ma50_percent}% juu ya MA50), hivyo msimu wa altcoin bado si mpana. ${b.bottoming_attempt_count} zinajaribu kufikia sakafu na ${b.early_recovery_count} zinaanza kupona.`
    : `Alt/BTC Bottom Radar inaonyesha mzunguko unapanuka. Assets ${confirmed} zina nguvu iliyothibitishwa dhidi ya BTC na ${b.early_recovery_count} zinaanza kupona, huku ${b.still_bleeding_count} pekee zikiwa dhaifu wazi dhidi ya BTC. Ushiriki wa altcoin unapanuka.`;
  return { text_en, text_sw };
};
