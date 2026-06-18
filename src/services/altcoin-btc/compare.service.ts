import { getAltBtc } from './service';
import { computeConfidence } from './signal-quality';
import { buildAnalysis } from './verdict';

export type CompareMeta = { symbol: string; name: string; market_cap_rank: number | null; total_volume: number | null };

export interface CompareCoin {
  coingecko_id: string;
  symbol: string;
  name: string;
  points: { date: string; ratio: number }[];
  strength_7d: number | null;
  strength_30d: number | null;
  strength_90d: number | null;
  signal: string;
  reaction_score: number;
  reaction_label: string;
  above_ma200: boolean;
  premium_signal: string;
  trend_state: string;
  confidence: string;
}

/**
 * Compute Alt/BTC ratio series + headline strength + premium read for several
 * coins from the SAVED series. Sequential to respect rate limits; BTC's series
 * is cached so it's read once across the batch.
 */
export const getCompare = async (ids: string[], meta: Map<string, CompareMeta>): Promise<CompareCoin[]> => {
  const out: CompareCoin[] = [];
  for (const id of ids) {
    try {
      const r = await getAltBtc(id);
      if (!r.points.length) continue;
      const last = r.points[r.points.length - 1];
      const m = meta.get(id);
      const symbol = m?.symbol ?? id.toUpperCase();
      const analysis = buildAnalysis({
        symbol,
        ratio: r.latest_ratio,
        ma50: last.ma50,
        ma200: last.ma200,
        strength7: r.strength_7d,
        strength30: r.strength_30d,
        strength90: r.strength_90d,
        reactionScore: r.reaction_score,
        volumeBreakout: r.breakout_details.volume_breakout
      });
      const confidence = computeConfidence({
        strength_7d: r.strength_7d,
        strength_30d: r.strength_30d,
        strength_90d: r.strength_90d,
        above_ma50: r.breakout_details.above_ma50,
        above_ma200: r.breakout_details.above_ma200,
        volume_breakout: r.breakout_details.volume_breakout,
        market_cap: null,
        total_volume: m?.total_volume ?? null,
        market_cap_rank: m?.market_cap_rank ?? null,
        history_days: r.points.length
      });
      out.push({
        coingecko_id: id,
        symbol,
        name: m?.name ?? id,
        points: r.points.map((p) => ({ date: p.date, ratio: p.ratio })),
        strength_7d: r.strength_7d,
        strength_30d: r.strength_30d,
        strength_90d: r.strength_90d,
        signal: r.signal,
        reaction_score: r.reaction_score,
        reaction_label: r.reaction_label,
        above_ma200: last.ma200 != null && last.ratio > last.ma200,
        premium_signal: analysis.premium_signal,
        trend_state: analysis.trend_state,
        confidence
      });
    } catch {
      // Skip a coin we can't read rather than failing the whole comparison.
    }
  }
  return out;
};

const list = (names: string[]): string =>
  names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Ready-made plain-language summary of the basket (SRS §10). */
export const buildComparisonVerdict = (coins: CompareCoin[]): string => {
  if (!coins.length) return '';
  const ranked = [...coins].sort((a, b) => (b.strength_90d ?? -1e9) - (a.strength_90d ?? -1e9));

  const strong = ranked.filter((c) => c.premium_signal === 'Strong leader' || c.premium_signal === 'Confirmed strength');
  const early = ranked.filter((c) => c.premium_signal === 'Early recovery');
  const neutral = ranked.filter((c) => c.premium_signal === 'Watch only');
  const weak = ranked.filter((c) => ['Weakening', 'Bleeding against BTC', 'Avoid'].includes(c.premium_signal));

  const parts: string[] = [];
  if (strong.length) parts.push(`${list(strong.map((c) => c.symbol))} ${strong.length > 1 ? 'are' : 'is'} currently the strongest against BTC.`);
  else parts.push(`No coin in the basket is confirmed strong against BTC yet.`);
  if (early.length) parts.push(`${list(early.map((c) => c.symbol))} ${early.length > 1 ? 'are' : 'is'} showing early recovery, but ${early.length > 1 ? 'remain' : 'remains'} below long-term confirmation.`);
  if (neutral.length) parts.push(`${list(neutral.map((c) => c.symbol))} ${neutral.length > 1 ? 'are' : 'is'} neutral.`);
  if (weak.length) parts.push(`${list(weak.map((c) => c.symbol))} ${weak.length > 1 ? 'remain' : 'remains'} weak and ${weak.length > 1 ? 'continue' : 'continues'} to bleed against BTC.`);
  return parts.join(' ');
};
