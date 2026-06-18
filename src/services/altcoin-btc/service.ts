import type { DailyPoint } from '../sources/blockchaincom.client';
import { volumeBreakoutRatio } from '../scoring/technicals';
import { readSeries, readSeriesFull } from '../series/store';
import { computeAltBtc, type AltBtcResult } from './ratio';

/**
 * Compute the Alt/BTC relative-strength result from SAVED daily series
 * (cg:<coin> and cg:bitcoin). No upstream call — the sync populates these.
 */
export const getAltBtc = async (coingeckoId: string): Promise<AltBtcResult> => {
  const [altRows, btc] = await Promise.all([readSeriesFull(`cg:${coingeckoId}`), readSeries('cg:bitcoin')]);

  const alt: DailyPoint[] = altRows
    .filter((r): r is typeof r & { price: number } => r.price != null)
    .map((r) => ({ date: r.date, value: r.price }));
  const altVolumes = altRows.map((r) => r.volume ?? 0);
  const volBreakout = volumeBreakoutRatio(altVolumes, 30);

  return computeAltBtc(alt, btc, volBreakout);
};
