// Cycle anchors as reference constants. Dates are fixed history; anchor PRICES
// are looked up from our own BTC series so ROI stays consistent with everything
// else (no external data). These can later move into the btc_cycle_events table
// if you want admin-managed events — the compute layer doesn't care where they
// come from.

export interface CycleEvent {
  key: string;
  label: string;
  type: 'cycle_low' | 'halving';
  date: string; // YYYY-MM-DD anchor
  cycle: string;
}

// "Current cycle" is anchored at the most recent macro low (Nov 2022).
export const CYCLE_LOWS: CycleEvent[] = [
  { key: '2011', label: '2011 cycle', type: 'cycle_low', date: '2011-11-18', cycle: '2011_cycle' },
  { key: '2015', label: '2015 cycle', type: 'cycle_low', date: '2015-01-14', cycle: '2015_cycle' },
  { key: '2018', label: '2018 cycle', type: 'cycle_low', date: '2018-12-15', cycle: '2018_cycle' },
  { key: 'current', label: 'Current cycle', type: 'cycle_low', date: '2022-11-21', cycle: 'current_cycle' }
];

export const HALVINGS: CycleEvent[] = [
  { key: '2012', label: '2012 halving', type: 'halving', date: '2012-11-28', cycle: '2012_halving' },
  { key: '2016', label: '2016 halving', type: 'halving', date: '2016-07-09', cycle: '2016_halving' },
  { key: '2020', label: '2020 halving', type: 'halving', date: '2020-05-11', cycle: '2020_halving' },
  { key: '2024', label: '2024 halving', type: 'halving', date: '2024-04-20', cycle: '2024_halving' }
];

export const eventsFor = (type: 'cycle_low' | 'halving'): CycleEvent[] =>
  type === 'cycle_low' ? CYCLE_LOWS : HALVINGS;
