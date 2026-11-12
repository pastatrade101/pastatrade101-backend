import { computeCycleRisk } from '../services/btc-cycle/cycle-risk';
import { eventsFor } from '../services/btc-cycle/events';
import { buildCycleRoi } from '../services/btc-cycle/roi';
import { yearOverlaySeries } from '../services/btc-cycle/year-roi';
import { btcRiskZone, readSmoothedBtcRisk } from '../services/risk/btcRisk.service';
import { readSeries } from '../services/series/store';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';

// ?cycles=2011,2015,current → filter the event set; empty/absent = all.
const parseKeys = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const roiForType = async (type: 'cycle_low' | 'halving', rawCycles: string) => {
  const series = await readSeries('btc-full');
  if (series.length < 30) throw new AppError('BTC history unavailable.', 503);

  const wanted = parseKeys(rawCycles);
  const all = eventsFor(type);
  const events = wanted.length ? all.filter((e) => wanted.includes(e.key)) : all;

  return buildCycleRoi(series, events);
};

// GET /api/v1/btc-cycle/roi-from-cycle-low?cycles=2011,2015,2018,current
export const getRoiFromCycleLow = asyncHandler(async (req, res) => {
  const series = await roiForType('cycle_low', getQueryString(req.query, 'cycles'));
  return sendSuccess(res, 'ROI from cycle low computed.', { anchor: 'cycle_low', x_label: 'Days since cycle low', series });
});

// GET /api/v1/btc-cycle/roi-from-halving?cycles=2012,2016,2020,2024
export const getRoiFromHalving = asyncHandler(async (req, res) => {
  const series = await roiForType('halving', getQueryString(req.query, 'cycles'));
  return sendSuccess(res, 'ROI from halving computed.', { anchor: 'halving', x_label: 'Days since halving', series });
});

// GET /api/v1/btc-cycle/year-overlay?years=2017,2021,2024,2026  (also serves YTD ROI)
export const getYearOverlay = asyncHandler(async (req, res) => {
  const series = await readSeries('btc-full');
  if (series.length < 30) throw new AppError('BTC history unavailable.', 503);

  const years = parseKeys(getQueryString(req.query, 'years'))
    .map((y) => Number(y))
    .filter((y) => Number.isFinite(y));

  return sendSuccess(res, 'Yearly ROI overlay computed.', {
    anchor: 'year',
    x_label: 'Day of year',
    series: yearOverlaySeries(series, years)
  });
});

// GET /api/v1/btc-cycle/risk-score
// Cycle Lab's risk card shows the platform's one BTC risk number (7-day smoothed,
// Risk Dashboard zones) next to the cycle context (RSI, 200D MA, ATH, YTD), so it
// never shows a second, different "risk" score.
export const getRiskScore = asyncHandler(async (_req, res) => {
  const [series, btcRisk] = await Promise.all([readSeries('btc-full'), readSmoothedBtcRisk().catch(() => null)]);
  if (series.length < 250) throw new AppError('BTC history unavailable.', 503);
  const cycle = computeCycleRisk(series);
  const zone = btcRisk == null ? null : btcRiskZone(btcRisk);
  return sendSuccess(res, 'BTC risk and cycle context computed.', {
    btc_price: cycle.btc_price,
    risk_score: btcRisk == null ? null : Math.round(btcRisk * 100),
    risk_label: zone?.label ?? 'Unavailable',
    reason: zone?.meaning ?? 'Run a risk sync to populate BTC risk.',
    dca_window: zone?.dca ?? '—',
    distance_from_200ma: cycle.distance_from_200ma,
    drawdown_from_ath: cycle.drawdown_from_ath,
    rsi: cycle.rsi,
    ytd_roi: cycle.ytd_roi
  });
});
