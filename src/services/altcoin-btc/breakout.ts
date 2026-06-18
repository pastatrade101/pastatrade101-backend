import type { AltBtcPoint } from './ratio';

// Breakout / weakness detection on the Alt/BTC ratio (SRS §9). Pure function.
export interface BreakoutResult {
  signal_type: 'breakout' | 'weakness' | 'neutral';
  signal_label: string;
  details: {
    above_ma50: boolean;
    above_ma200: boolean;
    high_30d: boolean;
    high_90d: boolean;
    volume_breakout: number | null;
  };
}

const maxOfLast = (vals: number[], n: number) => Math.max(...vals.slice(-n));

export const detectBreakout = (points: AltBtcPoint[], volumeBreakout: number | null): BreakoutResult => {
  const last = points[points.length - 1];
  const base: BreakoutResult['details'] = {
    above_ma50: false,
    above_ma200: false,
    high_30d: false,
    high_90d: false,
    volume_breakout: volumeBreakout
  };
  if (!last) return { signal_type: 'neutral', signal_label: 'Still weak', details: base };

  const ratios = points.map((p) => p.ratio);
  const aboveMa50 = last.ma50 != null && last.ratio > last.ma50;
  const aboveMa200 = last.ma200 != null && last.ratio > last.ma200;
  // "Breaks the N-day high" = at/within 0.1% of the trailing high.
  const high30 = points.length >= 5 && last.ratio >= maxOfLast(ratios, 30) * 0.999;
  const high90 = points.length >= 5 && last.ratio >= maxOfLast(ratios, 90) * 0.999;

  // Failed breakout: ratio was above the 50D MA within the last 10 days but has
  // since dropped back below it.
  const recentAbove50 = points.slice(-10).some((p) => p.ma50 != null && p.ratio > p.ma50);
  const failed = !aboveMa50 && recentAbove50;

  const details = { above_ma50: aboveMa50, above_ma200: aboveMa200, high_30d: high30, high_90d: high90, volume_breakout: volumeBreakout };

  if (aboveMa200 && high90) return { signal_type: 'breakout', signal_label: 'Major BTC pair breakout', details };
  if (aboveMa200 && aboveMa50) return { signal_type: 'breakout', signal_label: 'Confirmed strength', details };
  if (aboveMa50 && !aboveMa200) return { signal_type: 'breakout', signal_label: 'Early strength', details };
  if (failed) return { signal_type: 'weakness', signal_label: 'Failed breakout', details };
  return { signal_type: 'weakness', signal_label: 'Still weak', details };
};
