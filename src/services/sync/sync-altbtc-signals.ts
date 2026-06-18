import { supabase } from '../../config/supabase';
import { getAltBtc } from '../altcoin-btc/service';

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'USDS', 'GUSD']);

/**
 * Compute breakout/weakness signals for the tracked altcoins from the saved
 * Alt/BTC series and upsert one row per coin per day. Stores rich metrics in
 * `details` so the /signals endpoint can derive confidence, quality and breadth
 * without re-syncing.
 */
export const syncAltBtcSignals = async (): Promise<number> => {
  const { data: coins } = await supabase
    .from('coins')
    .select('id, coingecko_id, symbol, name, market_cap, total_volume, market_cap_rank')
    .lte('market_cap_rank', 100)
    .not('market_cap_rank', 'is', null)
    .order('market_cap_rank', { ascending: true });

  if (!coins?.length) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const rows: Record<string, unknown>[] = [];

  for (const c of coins) {
    if (!c.coingecko_id || c.coingecko_id === 'bitcoin' || STABLES.has((c.symbol ?? '').toUpperCase())) continue;
    try {
      const r = await getAltBtc(c.coingecko_id);
      if (!r.points.length) continue;
      rows.push({
        coin_id: c.id,
        date: today,
        signal_type: r.breakout_type,
        signal_label: r.breakout_label,
        strength_score: r.reaction_score,
        details: {
          strength_7d: r.strength_7d,
          strength_30d: r.strength_30d,
          strength_90d: r.strength_90d,
          above_ma50: r.breakout_details.above_ma50,
          above_ma200: r.breakout_details.above_ma200,
          volume_breakout: r.breakout_details.volume_breakout,
          market_cap: c.market_cap,
          total_volume: c.total_volume,
          market_cap_rank: c.market_cap_rank,
          history_days: r.points.length
        }
      });
    } catch {
      // Skip coins without a usable saved series.
    }
  }

  if (rows.length) {
    const { error } = await supabase.from('altcoin_btc_signals').upsert(rows, { onConflict: 'coin_id,date' });
    if (error) throw new Error(`Failed to store altcoin signals: ${error.message}`);
  }
  return rows.length;
};
