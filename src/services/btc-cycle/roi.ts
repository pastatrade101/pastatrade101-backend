import type { DailyPoint } from '../sources/blockchaincom.client';
import type { CycleEvent } from './events';

const DAY = 86_400_000;

export interface RoiPoint {
  days_since_event: number;
  date: string;
  btc_price: number;
  roi_multiple: number;
  roi_percent: number;
}

export interface CycleRoiSeries {
  key: string;
  label: string;
  cycle: string;
  event_date: string;
  anchor_price: number;
  points: RoiPoint[];
}

/**
 * ROI of BTC measured from an event's anchor price, capped at `maxDays` so cycles
 * stay length-comparable. Anchor = first close on/after the event date.
 */
export const roiFromEvent = (series: DailyPoint[], event: CycleEvent, maxDays = 1460): CycleRoiSeries | null => {
  const startIdx = series.findIndex((p) => p.date >= event.date);
  if (startIdx === -1) return null;

  const anchor = series[startIdx].value;
  if (!(anchor > 0)) return null;

  const anchorMs = Date.parse(`${series[startIdx].date}T00:00:00Z`);
  const points: RoiPoint[] = [];

  for (let i = startIdx; i < series.length; i += 1) {
    const days = Math.round((Date.parse(`${series[i].date}T00:00:00Z`) - anchorMs) / DAY);
    if (days > maxDays) break;
    const price = series[i].value;
    points.push({
      days_since_event: days,
      date: series[i].date,
      btc_price: price,
      roi_multiple: Number((price / anchor).toFixed(4)),
      roi_percent: Number((((price - anchor) / anchor) * 100).toFixed(2))
    });
  }

  return {
    key: event.key,
    label: event.label,
    cycle: event.cycle,
    event_date: series[startIdx].date,
    anchor_price: anchor,
    points
  };
};

/** Build ROI series for a set of events (skips events with no data in range). */
export const buildCycleRoi = (series: DailyPoint[], events: CycleEvent[], maxDays = 1460): CycleRoiSeries[] =>
  events.map((e) => roiFromEvent(series, e, maxDays)).filter((s): s is CycleRoiSeries => s !== null && s.points.length > 0);
