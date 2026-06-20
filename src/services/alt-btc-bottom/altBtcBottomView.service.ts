import { supabase } from '../../config/supabase';
import { readSeriesFull } from '../series/store';
import { statusScoreLabel } from './altBtcBottom.service';

export interface AbbQuery {
  tab?: string; // all | bottoming | early_recovery | confirmed | still_bleeding | failed
  sort?: string; // bottom | confirmation | drawdown | distance_low | ret30 | ret90 | invalidation | rank
  search?: string;
  minScore?: number;
  limit?: number;
}

const STATUS_BY_TAB: Record<string, string[]> = {
  bottoming: ['Bottoming attempt'],
  early_recovery: ['Early recovery'],
  confirmed: ['Confirmed recovery', 'Relative strength leader'],
  still_bleeding: ['Still bleeding'],
  failed: ['Failed recovery']
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sortCmp = (sort?: string) => (a: any, b: any) => {
  switch (sort) {
    case 'confirmation':
      return b.confirmation_score - a.confirmation_score;
    case 'drawdown':
      return (a.drawdown_from_365d_high ?? 0) - (b.drawdown_from_365d_high ?? 0); // most negative first
    case 'distance_low':
      return (a.distance_from_180d_low ?? 0) - (b.distance_from_180d_low ?? 0); // closest to low first
    case 'ret30':
      return (b.alt_btc_return_30d ?? -1) - (a.alt_btc_return_30d ?? -1);
    case 'ret90':
      return (b.alt_btc_return_90d ?? -1) - (a.alt_btc_return_90d ?? -1);
    case 'invalidation':
      return b.invalidation_risk_score - a.invalidation_risk_score;
    case 'rank':
      return (a.market_cap_rank ?? 9999) - (b.market_cap_rank ?? 9999);
    default:
      return b.bottom_score - a.bottom_score;
  }
};

const marketContext = async (breadth: { above_ma50_percent?: number } | null) => {
  let dominance: 'rising' | 'falling' | 'flat' = 'flat';
  try {
    const { data } = await supabase.from('global_market_snapshots').select('btc_dominance').order('captured_at', { ascending: false }).limit(2);
    if (data && data.length >= 2) {
      const diff = Number(data[0].btc_dominance) - Number(data[1].btc_dominance);
      dominance = diff > 0.1 ? 'rising' : diff < -0.1 ? 'falling' : 'flat';
    }
  } catch {
    /* optional */
  }
  let btc_risk: number | null = null;
  try {
    const { data } = await supabase.from('risk_summary_daily').select('summary_risk').order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
    btc_risk = data?.summary_risk == null ? null : Number(data.summary_risk);
  } catch {
    /* optional */
  }
  const ma50 = breadth?.above_ma50_percent ?? null;
  const altcoin_breadth = ma50 == null ? 'unknown' : ma50 < 25 ? 'selective' : ma50 < 55 ? 'broadening' : 'broad';
  return { btc_dominance: dominance, altcoin_breadth, btc_risk };
};

export const getRadar = async (q: AbbQuery) => {
  const { data: latest } = await supabase.from('alt_btc_bottom_daily').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
  if (!latest?.date) return { as_of: null, available: false, market_context: await marketContext(null), summary: null, takeaway: 'Alt/BTC Bottom Radar has not been synced yet. Run a sync to populate it.', breadth: null, candidates: [] };

  const date = latest.date as string;
  const [{ data: rowsRaw }, { data: breadth }] = await Promise.all([
    supabase.from('alt_btc_bottom_daily').select('*').eq('date', date).order('bottom_score', { ascending: false }),
    supabase.from('alt_btc_bottom_breadth_daily').select('*').eq('date', date).maybeSingle()
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = (rowsRaw ?? []) as any[];

  let filtered = all;
  if (q.tab && STATUS_BY_TAB[q.tab]) filtered = filtered.filter((r) => STATUS_BY_TAB[q.tab as string].includes(r.status_label));
  if (q.search) {
    const s = q.search.toLowerCase();
    filtered = filtered.filter((r) => (r.symbol ?? '').toLowerCase().includes(s) || (r.name ?? '').toLowerCase().includes(s));
  }
  if (q.minScore) filtered = filtered.filter((r) => r.bottom_score >= (q.minScore as number));
  filtered = [...filtered].sort(sortCmp(q.sort));
  if (q.limit && q.limit > 0) filtered = filtered.slice(0, q.limit);
  filtered = filtered.map((r) => ({ ...r, score_label: statusScoreLabel(r.bottom_score) }));

  const cnt = (s: string) => all.filter((r) => r.status_label === s).length;
  const recovery = all.filter((r) => r.status_label === 'Confirmed recovery' || r.status_label === 'Relative strength leader' || r.status_label === 'Early recovery');
  const strongest = [...recovery].sort((a, b) => b.bottom_score - a.bottom_score)[0];
  const highestRisk = [...all].sort((a, b) => b.invalidation_risk_score - a.invalidation_risk_score)[0];

  const summary = {
    bottoming_attempts: cnt('Bottoming attempt'),
    early_recoveries: cnt('Early recovery'),
    confirmed_strength: cnt('Confirmed recovery') + cnt('Relative strength leader'),
    still_bleeding: cnt('Still bleeding'),
    strongest_recovery: strongest ? `${strongest.symbol}/BTC` : null,
    highest_invalidation_risk: highestRisk ? `${highestRisk.symbol}/BTC` : null
  };

  // ── Best setups (research candidates, not buy calls) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pick = (arr: any[], statuses: string[], by: (x: any) => number) => arr.filter((r) => statuses.includes(r.status_label)).sort((a, b) => by(b) - by(a))[0] ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tag = (r: any, note: string) => (r ? { symbol: r.symbol, coin_id: r.coin_id, status: r.status_label, score: r.bottom_score, invalidation: r.invalidation_risk_score, note } : null);
  const best_setups = [
    tag(pick(all, ['Confirmed recovery'], (x) => x.bottom_score), 'Highest confirmed recovery'),
    tag(pick(all, ['Early recovery'], (x) => x.bottom_score), 'Strongest early recovery'),
    tag(pick(all, ['Relative strength leader'], (x) => -x.invalidation_risk_score), 'Lowest-risk leader')
  ].filter(Boolean);

  // ── Weakest vs BTC ──
  const weakest = all
    .filter((r) => r.status_label === 'Still bleeding' || r.status_label === 'Failed recovery' || r.invalidation_risk_score >= 66)
    .sort((a, b) => a.bottom_score - b.bottom_score)
    .slice(0, 5)
    .map((r) => ({ symbol: r.symbol, coin_id: r.coin_id, status: r.status_label, score: r.bottom_score }));

  // ── Recovery by sector (only if category data is present; null today) ──
  const sectorMap = new Map<string, typeof all>();
  for (const r of all) {
    if (!r.category) continue;
    sectorMap.set(r.category, [...(sectorMap.get(r.category) ?? []), r]);
  }
  const by_sector = [...sectorMap.entries()]
    .map(([sector, list]) => ({
      sector,
      bottoming: list.filter((r) => r.status_label === 'Bottoming attempt').length,
      early: list.filter((r) => r.status_label === 'Early recovery').length,
      confirmed: list.filter((r) => r.status_label === 'Confirmed recovery' || r.status_label === 'Relative strength leader').length,
      avg_score: Math.round(list.reduce((s, r) => s + r.bottom_score, 0) / list.length),
      top_symbol: [...list].sort((a, b) => b.bottom_score - a.bottom_score)[0]?.symbol ?? null
    }))
    .sort((a, b) => b.avg_score - a.avg_score);

  const takeaway = breadth?.market_takeaway ?? 'Relative-strength rotation read is being built.';

  return { as_of: date, available: true, market_context: await marketContext(breadth), summary, takeaway, breadth, best_setups, weakest, by_sector, candidates: filtered };
};

export const getCoins = async (q: AbbQuery) => (await getRadar(q)).candidates;

export const getBreadth = async () => {
  const { data } = await supabase.from('alt_btc_bottom_breadth_daily').select('*').order('date', { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
};

export const getRotationWave = async () => {
  const b = await getBreadth();
  return b ? { rotation_wave_label: b.rotation_wave_label, breadth_label: b.market_takeaway, above_ma50_percent: b.above_ma50_percent } : null;
};

// ── Coin detail + live ALT/BTC ratio chart ──
const trailingMA = (arr: (number | null)[], n: number): (number | null)[] => {
  const out: (number | null)[] = [];
  for (let i = 0; i < arr.length; i += 1) {
    if (i + 1 < n) {
      out.push(null);
      continue;
    }
    const w = arr.slice(i + 1 - n, i + 1).filter((x): x is number => x != null);
    out.push(w.length === n ? w.reduce((s, x) => s + x, 0) / n : null);
  }
  return out;
};

export const getCoinDetail = async (coinId: string) => {
  const { data: row } = await supabase.from('alt_btc_bottom_daily').select('*').eq('coin_id', coinId).order('date', { ascending: false }).limit(1).maybeSingle();
  if (!row) return null;

  // Live ALT/BTC ratio chart (last ~365 aligned points) + trailing MAs.
  let chart: { dates: string[]; ratio: (number | null)[]; ma20: (number | null)[]; ma50: (number | null)[]; ma100: (number | null)[]; ma200: (number | null)[]; recent_low: number | null; recent_high: number | null } | null = null;
  try {
    const [altRows, btcRows] = await Promise.all([readSeriesFull(`cg:${coinId}`), readSeriesFull('cg:bitcoin')]);
    const btcByDate = new Map<string, number>();
    for (const r of btcRows) if (r.price != null) btcByDate.set(r.date, r.price);
    const dates: string[] = [];
    const ratio: (number | null)[] = [];
    for (const r of altRows) {
      if (r.price == null) continue;
      const btc = btcByDate.get(r.date);
      if (!btc) continue;
      dates.push(r.date);
      ratio.push(r.price / btc);
    }
    const sliceN = Math.min(ratio.length, 365);
    const dts = dates.slice(-sliceN);
    const rt = ratio.slice(-sliceN);
    const realised = rt.filter((x): x is number => x != null);
    chart = {
      dates: dts,
      ratio: rt,
      ma20: trailingMA(ratio, 20).slice(-sliceN),
      ma50: trailingMA(ratio, 50).slice(-sliceN),
      ma100: trailingMA(ratio, 100).slice(-sliceN),
      ma200: trailingMA(ratio, 200).slice(-sliceN),
      recent_low: realised.length ? Math.min(...realised) : null,
      recent_high: realised.length ? Math.max(...realised) : null
    };
  } catch {
    /* chart optional */
  }

  return { ...row, score_label: statusScoreLabel(row.bottom_score), chart };
};
