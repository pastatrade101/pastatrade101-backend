import { supabase } from '../../config/supabase';
import { readSeriesFull } from '../series/store';
import { buildBreadth, computeAltBtc, type AltBtcMetrics, type CoinMeta } from './altBtcBottom.service';

const MIN_VOLUME = 20_000_000; // $20M 24h — below this, flag low liquidity

// Coins that have a stored cg: daily series (the Lab universe).
const loadUniverse = async (): Promise<CoinMeta[]> => {
  const { data: keys } = await supabase.from('daily_prices').select('series_key').like('series_key', 'cg:%').limit(5000);
  const ids = [...new Set((keys ?? []).map((k) => (k.series_key as string).slice(3)))].filter((id) => id && id !== 'bitcoin');
  if (!ids.length) return [];
  const { data: coins } = await supabase.from('coins').select('coingecko_id, symbol, name, market_cap_rank, total_volume').in('coingecko_id', ids);
  return (coins ?? [])
    .map((c) => ({ coin_id: c.coingecko_id as string, symbol: (c.symbol as string)?.toUpperCase() ?? '', name: (c.name as string) ?? '', market_cap_rank: c.market_cap_rank as number | null, volume: c.total_volume as number | null }))
    .sort((a, b) => (a.market_cap_rank ?? 9999) - (b.market_cap_rank ?? 9999));
};

const btcDominanceRising = async (): Promise<boolean> => {
  try {
    const { data } = await supabase.from('global_market_snapshots').select('btc_dominance').order('captured_at', { ascending: false }).limit(2);
    if (!data || data.length < 2) return false;
    return Number(data[0].btc_dominance) > Number(data[1].btc_dominance);
  } catch {
    return false;
  }
};

/** Compute the radar for the whole universe (used by sync + live recompute). */
export const computeUniverse = async (): Promise<AltBtcMetrics[]> => {
  const [universe, domRising, btcRows] = await Promise.all([loadUniverse(), btcDominanceRising(), readSeriesFull('cg:bitcoin')]);
  const btcByDate = new Map<string, number>();
  for (const r of btcRows) if (r.price != null) btcByDate.set(r.date, r.price);
  if (!btcByDate.size) return [];

  const out: AltBtcMetrics[] = [];
  for (const meta of universe) {
    try {
      const rows = await readSeriesFull(`cg:${meta.coin_id}`);
      const m = computeAltBtc(rows, btcByDate, meta, { domRising, minVolume: MIN_VOLUME });
      if (m) out.push(m);
    } catch {
      /* skip a coin that fails to read */
    }
  }
  return out.sort((a, b) => b.bottom_score - a.bottom_score);
};

/** Fetch, compute, and store today's Alt/BTC bottom rows + breadth. */
export const runAltBtcBottomSync = async (): Promise<number> => {
  const rows = await computeUniverse();
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  const date = now.slice(0, 10);

  const payload = rows.map((m) => ({
    date,
    coin_id: m.coin_id,
    symbol: m.symbol,
    name: m.name,
    market_cap_rank: m.market_cap_rank,
    category: m.category ?? null,
    ecosystem: null,
    alt_usd_price: m.alt_usd_price,
    btc_usd_price: m.btc_usd_price,
    alt_btc_ratio: m.alt_btc_ratio,
    alt_btc_ma20: m.alt_btc_ma20,
    alt_btc_ma50: m.alt_btc_ma50,
    alt_btc_ma100: m.alt_btc_ma100,
    alt_btc_ma200: m.alt_btc_ma200,
    alt_btc_return_7d: m.alt_btc_return_7d,
    alt_btc_return_14d: m.alt_btc_return_14d,
    alt_btc_return_30d: m.alt_btc_return_30d,
    alt_btc_return_60d: m.alt_btc_return_60d,
    alt_btc_return_90d: m.alt_btc_return_90d,
    drawdown_from_90d_high: m.drawdown_from_90d_high,
    drawdown_from_180d_high: m.drawdown_from_180d_high,
    drawdown_from_365d_high: m.drawdown_from_365d_high,
    distance_from_30d_low: m.distance_from_30d_low,
    distance_from_90d_low: m.distance_from_90d_low,
    distance_from_180d_low: m.distance_from_180d_low,
    distance_from_365d_low: m.distance_from_365d_low,
    structure_label: m.structure_label,
    above_ma20: m.above_ma20,
    above_ma50: m.above_ma50,
    above_ma200: m.above_ma200,
    volume_confirming: m.volume_confirming,
    bottom_score: m.bottom_score,
    confirmation_score: m.confirmation_score,
    invalidation_risk_score: m.invalidation_risk_score,
    status_label: m.status_label,
    confidence: m.confidence,
    key_reason: m.key_reason,
    what_to_watch_next: m.what_to_watch_next,
    risk_flags: m.risk_flags,
    source_status: 'active',
    updated_at: now
  }));

  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await supabase.from('alt_btc_bottom_daily').upsert(payload.slice(i, i + 500), { onConflict: 'date,coin_id' });
    if (error) throw new Error(`Failed to store alt/btc bottom rows: ${error.message}`);
  }

  const b = buildBreadth(rows);
  const { error: be } = await supabase.from('alt_btc_bottom_breadth_daily').upsert(
    {
      date,
      universe_size: b.universe_size,
      above_ma20_percent: b.above_ma20_percent,
      above_ma50_percent: b.above_ma50_percent,
      above_ma200_percent: b.above_ma200_percent,
      positive_30d_percent: b.positive_30d_percent,
      higher_low_percent: b.higher_low_percent,
      bottoming_attempt_count: b.bottoming_attempt_count,
      early_recovery_count: b.early_recovery_count,
      confirmed_strength_count: b.confirmed_strength_count,
      leadership_count: b.leadership_count,
      still_bleeding_count: b.still_bleeding_count,
      failed_recovery_count: b.failed_recovery_count,
      rotation_wave_label: b.rotation_wave_label,
      market_takeaway: b.market_takeaway,
      updated_at: now
    },
    { onConflict: 'date' }
  );
  if (be) throw new Error(`Failed to store alt/btc breadth: ${be.message}`);

  return payload.length;
};
