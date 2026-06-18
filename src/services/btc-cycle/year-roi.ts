import type { DailyPoint } from '../sources/blockchaincom.client';
import type { CycleRoiSeries } from './roi';

const DAY = 86_400_000;

/**
 * Per-year ROI indexed to that year's first close, shaped like CycleRoiSeries so
 * the same overlay chart can render it. x (days_since_event) = day-of-year.
 */
export const yearOverlaySeries = (series: DailyPoint[], years?: number[]): CycleRoiSeries[] => {
  const byYear = new Map<number, DailyPoint[]>();
  for (const p of series) {
    const y = Number(p.date.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(p);
  }

  const out: CycleRoiSeries[] = [];
  for (const [year, pts] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    if (years && years.length && !years.includes(year)) continue;
    const base = pts[0].value;
    if (!(base > 0)) continue;
    const yearStart = Date.parse(`${year}-01-01T00:00:00Z`);

    out.push({
      key: String(year),
      label: String(year),
      cycle: `year_${year}`,
      event_date: pts[0].date,
      anchor_price: base,
      points: pts.map((p) => ({
        days_since_event: Math.round((Date.parse(`${p.date}T00:00:00Z`) - yearStart) / DAY) + 1,
        date: p.date,
        btc_price: p.value,
        roi_multiple: Number((p.value / base).toFixed(4)),
        roi_percent: Number((((p.value - base) / base) * 100).toFixed(2))
      }))
    });
  }
  return out;
};
