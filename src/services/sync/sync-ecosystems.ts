import { supabase } from '../../config/supabase';
import {
  getChainDexOverview,
  getChainFeesOverview,
  getChainTvlHistory,
  getStablecoinChains,
  type LlamaTvlPoint
} from '../sources/defillama.client';
import { computeEcosystemScore } from '../scoring/ecosystem-score';

interface EcosystemRow {
  id: string;
  name: string;
  defillama_slug: string | null;
  native_coin_gecko_id: string | null;
}

const pctChange = (series: LlamaTvlPoint[], daysAgo: number): number | null => {
  if (series.length < daysAgo + 1) return null;
  const current = series[series.length - 1]?.tvl;
  const past = series[series.length - 1 - daysAgo]?.tvl;
  if (!current || !past) return null;
  return ((current - past) / past) * 100;
};

const storeTvlHistory = async (ecosystemId: string, series: LlamaTvlPoint[]): Promise<void> => {
  // Keep the trailing ~120 days; that's enough for 30d deltas without bloating the table.
  const recent = series.slice(-120);
  const rows = recent.map((p) => ({
    ecosystem_id: ecosystemId,
    snapshot_date: new Date(p.date * 1000).toISOString().slice(0, 10),
    tvl: p.tvl
  }));
  if (!rows.length) return;
  await supabase.from('ecosystem_tvl_history').upsert(rows, { onConflict: 'ecosystem_id,snapshot_date' });
};

const nativeToken30d = async (geckoId: string | null): Promise<number | null> => {
  if (!geckoId) return null;
  const { data } = await supabase
    .from('coins')
    .select('price_change_pct_30d')
    .eq('coingecko_id', geckoId)
    .maybeSingle();
  return data?.price_change_pct_30d ?? null;
};

const topTokens30d = async (ecosystemId: string): Promise<number | null> => {
  const { data } = await supabase
    .from('coins')
    .select('return_30d')
    .eq('ecosystem_id', ecosystemId)
    .not('return_30d', 'is', null)
    .order('market_cap', { ascending: false })
    .limit(10);
  if (!data?.length) return null;
  const vals = data.map((r) => Number(r.return_30d)).filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
};

/** Refresh DefiLlama-derived metrics + strength score for every active ecosystem. */
export const syncEcosystems = async (): Promise<number> => {
  const { data: ecosystems } = await supabase
    .from('ecosystems')
    .select('id, name, defillama_slug, native_coin_gecko_id')
    .eq('is_active', true);

  if (!ecosystems?.length) return 0;

  const stablecoinChains = await getStablecoinChains().catch(() => []);
  const stablecoinByName = new Map(
    stablecoinChains.map((c) => {
      const raw = c.totalCirculatingUSD;
      const value = typeof raw === 'number' ? raw : (raw?.peggedUSD ?? 0);
      return [c.name?.toLowerCase(), value] as const;
    })
  );

  let processed = 0;

  for (const eco of ecosystems as EcosystemRow[]) {
    if (!eco.defillama_slug) continue;

    try {
      const [tvlSeries, dex, fees] = await Promise.all([
        getChainTvlHistory(eco.defillama_slug),
        getChainDexOverview(eco.defillama_slug),
        getChainFeesOverview(eco.defillama_slug)
      ]);

      await storeTvlHistory(eco.id, tvlSeries);

      const tvl = tvlSeries[tvlSeries.length - 1]?.tvl ?? null;
      const tvlChange7d = pctChange(tvlSeries, 7);
      const tvlChange30d = pctChange(tvlSeries, 30);
      const stablecoinMcap = stablecoinByName.get(eco.name.toLowerCase()) ?? null;
      const [native30d, top30d] = await Promise.all([
        nativeToken30d(eco.native_coin_gecko_id),
        topTokens30d(eco.id)
      ]);

      const { score, signal } = computeEcosystemScore({
        tvlChange30d,
        stablecoinInflowPct: null, // delta requires history we don't keep yet → neutral
        dexVolumeChange7d: dex.change_7dover7d ?? null,
        feesChange: null,
        nativeToken30d: native30d,
        topTokens30d: top30d
      });

      await supabase.from('ecosystem_metrics').upsert(
        {
          ecosystem_id: eco.id,
          tvl,
          tvl_change_7d: tvlChange7d,
          tvl_change_30d: tvlChange30d,
          stablecoin_mcap: stablecoinMcap,
          dex_volume_24h: dex.total24h ?? null,
          dex_volume_change_7d: dex.change_7dover7d ?? null,
          fees_24h: fees.total24h ?? null,
          revenue_24h: fees.totalRevenue24h ?? null,
          native_token_30d: native30d,
          strength_score: score,
          signal,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'ecosystem_id' }
      );

      processed += 1;
    } catch (error) {
      // One bad chain shouldn't abort the whole sync — log and continue.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Ecosystem sync failed for ${eco.name}: ${message}`);
    }
  }

  return processed;
};
