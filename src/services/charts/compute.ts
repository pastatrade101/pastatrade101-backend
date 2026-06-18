import type { DailyPoint } from '../sources/blockchaincom.client';

// Pure chart computations over a daily series (oldest → newest). No I/O.
// Used by the chart catalog; BTC series comes from blockchain.com (free, daily).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const utcDay = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export interface Bar {
  label: string;
  value: number;
}

/**
 * Best day of week to DCA: average % extension of price above/below its trailing
 * 7-day SMA, grouped by weekday. Lower (more negative) = historically cheaper day.
 */
export const bestDayToDca = (series: DailyPoint[]): Bar[] => {
  const closes = series.map((p) => p.value);
  const sums = Array(7).fill(0);
  const counts = Array(7).fill(0);

  for (let i = 6; i < series.length; i += 1) {
    const window = closes.slice(i - 6, i + 1);
    const sma7 = window.reduce((s, v) => s + v, 0) / 7;
    if (sma7 <= 0) continue;
    const ext = ((closes[i] - sma7) / sma7) * 100;
    const d = utcDay(series[i].date);
    sums[d] += ext;
    counts[d] += 1;
  }

  // Mon-first ordering (Mon..Sun) like the reference chart.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((d) => ({ label: WEEKDAYS[d], value: counts[d] ? sums[d] / counts[d] : 0 }));
};

/** Last close of each YYYY-MM, in order. */
const monthEndCloses = (series: DailyPoint[]): { ym: string; close: number }[] => {
  const map = new Map<string, number>();
  for (const p of series) map.set(p.date.slice(0, 7), p.value);
  return [...map.entries()].map(([ym, close]) => ({ ym, close })).sort((a, b) => a.ym.localeCompare(b.ym));
};

/** Monthly % returns as rows by year (12 columns). Null where no data. */
export const monthlyReturns = (series: DailyPoint[]): { year: number; months: (number | null)[] }[] => {
  const ends = monthEndCloses(series);
  const ret = new Map<string, number>(); // ym -> %
  for (let i = 1; i < ends.length; i += 1) {
    const prev = ends[i - 1];
    const cur = ends[i];
    if (prev.close > 0) ret.set(cur.ym, ((cur.close - prev.close) / prev.close) * 100);
  }

  const years = [...new Set(ends.map((e) => Number(e.ym.slice(0, 4))))].sort();
  return years.map((year) => ({
    year,
    months: MONTHS.map((_, m) => {
      const ym = `${year}-${String(m + 1).padStart(2, '0')}`;
      return ret.has(ym) ? Number(ret.get(ym)!.toFixed(2)) : null;
    })
  }));
};

/** Average return per month-of-year across all history (seasonality). */
export const monthlyAvgRoi = (series: DailyPoint[]): Bar[] => {
  const rows = monthlyReturns(series);
  return MONTHS.map((label, m) => {
    const vals = rows.map((r) => r.months[m]).filter((v): v is number => v !== null);
    return { label, value: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0 };
  });
};

/** Annual % returns (year-end vs prior year-end). */
export const annualReturns = (series: DailyPoint[]): Bar[] => {
  const map = new Map<string, number>();
  for (const p of series) map.set(p.date.slice(0, 4), p.value);
  const years = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: Bar[] = [];
  for (let i = 1; i < years.length; i += 1) {
    const [, prev] = years[i - 1];
    const [year, cur] = years[i];
    if (prev > 0) out.push({ label: year, value: Number((((cur - prev) / prev) * 100).toFixed(1)) });
  }
  return out;
};

/** Cumulative ROI (%) from the first point on/after `fromDate`. */
export const runningRoi = (series: DailyPoint[], fromDate?: string): { dates: string[]; roi: number[] } => {
  const sliced = fromDate ? series.filter((p) => p.date >= fromDate) : series;
  if (!sliced.length) return { dates: [], roi: [] };
  const base = sliced[0].value;
  return {
    dates: sliced.map((p) => p.date),
    roi: sliced.map((p) => (base > 0 ? Number((((p.value - base) / base) * 100).toFixed(2)) : 0))
  };
};

export interface DcaRow {
  label: string;
  weekday: number;
  buys: number;
  invested: number;
  btc: number;
  avg_cost: number;
  value: number;
  roi: number;
}

/**
 * DCA simulator: buy `amount` USD of BTC on each occurrence of every weekday
 * within [from, to]. Each weekday recurs ~weekly, so this is effectively a weekly
 * DCA on that day. Holdings are valued at the last price in range.
 */
export const dcaByWeekday = (series: DailyPoint[], amount: number, from?: string, to?: string): DcaRow[] => {
  const sliced = series.filter((p) => (!from || p.date >= from) && (!to || p.date <= to) && p.value > 0);
  if (!sliced.length || amount <= 0) return [];
  const last = sliced[sliced.length - 1].value;

  const acc = Array.from({ length: 7 }, () => ({ btc: 0, buys: 0 }));
  for (const p of sliced) {
    const d = utcDay(p.date);
    acc[d].btc += amount / p.value;
    acc[d].buys += 1;
  }

  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon-first
  return order.map((d) => {
    const { btc, buys } = acc[d];
    const invested = amount * buys;
    const value = btc * last;
    return {
      label: WEEKDAYS[d],
      weekday: d,
      buys,
      invested: Number(invested.toFixed(2)),
      btc: Number(btc.toFixed(8)),
      avg_cost: btc > 0 ? Number((invested / btc).toFixed(2)) : 0,
      value: Number(value.toFixed(2)),
      roi: invested > 0 ? Number((((value - invested) / invested) * 100).toFixed(2)) : 0
    };
  });
};

export interface OverlaySeries {
  year: number;
  points: { x: number; y: number }[]; // x = day-of-year (1..366), y = ROI % from Jan 1
}

/** Per-year cumulative ROI indexed to that year's first close — for overlay comparison. */
export const yearlyRoiOverlay = (series: DailyPoint[]): OverlaySeries[] => {
  const byYear = new Map<number, DailyPoint[]>();
  for (const p of series) {
    const y = Number(p.date.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(p);
  }

  const out: OverlaySeries[] = [];
  for (const [year, pts] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const base = pts[0].value;
    if (base <= 0) continue;
    const yearStart = Date.parse(`${year}-01-01T00:00:00Z`);
    out.push({
      year,
      points: pts.map((p) => ({
        x: Math.round((Date.parse(`${p.date}T00:00:00Z`) - yearStart) / 86_400_000) + 1,
        y: Number((((p.value - base) / base) * 100).toFixed(2))
      }))
    });
  }
  return out;
};
