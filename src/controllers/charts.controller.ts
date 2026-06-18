import { supabase } from '../config/supabase';
import {
  annualReturns,
  dcaByWeekday,
  monthlyAvgRoi,
  monthlyReturns,
  runningRoi,
  yearlyRoiOverlay
} from '../services/charts/compute';
import { CHART_REGISTRY, findChart } from '../services/charts/registry';
import { computeAltcoinSeason, computeAltcoinSeasonHistory, type Timeframe, type Universe } from '../services/altcoin-btc/altcoin-season.service';
import { readSeries } from '../services/series/store';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryNumber, getQueryString } from '../utils/query';

const FOUR_YEARS_AGO = () => new Date(Date.now() - 4 * 365 * 86_400_000).toISOString().slice(0, 10);

// Common stablecoins to exclude from the altcoin-season breadth count.
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'USDS', 'GUSD']);

// GET /api/v1/charts  → the catalog
export const getCatalog = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Chart catalog fetched successfully.', { items: CHART_REGISTRY });
});

const altcoinSeason = async () => {
  const { data: btc } = await supabase
    .from('coins')
    .select('return_30d')
    .eq('coingecko_id', 'bitcoin')
    .maybeSingle();
  const btc30 = btc?.return_30d;
  if (btc30 == null) throw new AppError('Altcoin Season needs a coins sync first.', 503);

  const { data: top } = await supabase
    .from('coins')
    .select('symbol, name, return_30d, market_cap_rank, image_url')
    .lte('market_cap_rank', 50)
    .not('return_30d', 'is', null)
    .neq('coingecko_id', 'bitcoin')
    .order('market_cap_rank', { ascending: true });

  const alts = (top ?? []).filter((c) => !STABLES.has((c.symbol ?? '').toUpperCase()));
  const outperformers = alts.filter((c) => Number(c.return_30d) > Number(btc30));
  const value = alts.length ? Math.round((outperformers.length / alts.length) * 100) : 0;
  const label = value >= 75 ? 'Altcoin Season' : value <= 25 ? 'Bitcoin Season' : 'Neutral';

  return {
    render: 'index' as const,
    value,
    label,
    window: '30d',
    total: alts.length,
    outperforming: outperformers.length,
    btc_return_30d: Number(btc30),
    leaders: outperformers.slice(0, 8).map((c) => ({ symbol: c.symbol, name: c.name, return_30d: c.return_30d }))
  };
};

// GET /api/v1/charts/altcoin-season-index?timeframe=&universe=&limit=
export const getAltcoinSeasonIndex = asyncHandler(async (req, res) => {
  const tf = getQueryString(req.query, 'timeframe').toLowerCase();
  const timeframe = (['7d', '30d', '60d', '90d', '180d', '1y'].includes(tf) ? tf : '30d') as Timeframe;
  const universe = (getQueryString(req.query, 'universe') === 'all' ? 'all' : 'premium_clean') as Universe;
  const limit = Math.min(Math.max(getQueryNumber(req.query, 'limit') ?? 50, 10), 100);
  const data = await computeAltcoinSeason(timeframe, universe, limit);
  return sendSuccess(res, 'Altcoin season index computed successfully.', data);
});

// GET /api/v1/charts/altcoin-season-index/history?timeframe=&universe=
export const getAltcoinSeasonHistory = asyncHandler(async (req, res) => {
  const tf = getQueryString(req.query, 'timeframe').toLowerCase();
  const timeframe = (['7d', '30d', '60d', '90d', '180d', '1y'].includes(tf) ? tf : '30d') as Timeframe;
  const universe = (getQueryString(req.query, 'universe') === 'all' ? 'all' : 'premium_clean') as Universe;
  const series = await computeAltcoinSeasonHistory(timeframe, universe);
  return sendSuccess(res, 'Altcoin season history computed successfully.', { timeframe, universe, series });
});

// GET /api/v1/charts/:key
export const getChart = asyncHandler(async (req, res) => {
  const def = findChart(req.params.key);
  if (!def) throw new AppError('Chart not found.', 404);

  if (def.key === 'altcoin-season') {
    return sendSuccess(res, 'Chart computed successfully.', { ...def, ...(await altcoinSeason()) });
  }

  // All remaining charts are BTC daily-series based (read from the synced store).
  const series = await readSeries('btc-full');
  if (series.length < 30) throw new AppError('BTC history not synced yet. Run a Lab price-series sync.', 503);

  let payload: Record<string, unknown>;
  switch (def.key) {
    case 'best-day-to-dca': {
      const amount = getQueryNumber(req.query, 'amount') ?? 100;
      const from = getQueryString(req.query, 'from') || FOUR_YEARS_AGO();
      const to = getQueryString(req.query, 'to') || series[series.length - 1].date;
      const rows = dcaByWeekday(series, amount, from, to);
      payload = {
        render: 'dca',
        unit: '%',
        amount,
        from,
        to,
        min_date: series[0].date,
        max_date: series[series.length - 1].date,
        bars: rows.map((r) => ({ label: r.label, value: r.roi })),
        table: rows
      };
      break;
    }
    case 'roi-yearly-overlay':
      payload = { render: 'multiline', unit: '%', x_label: 'Day of year', series: yearlyRoiOverlay(series) };
      break;
    case 'monthly-avg-roi':
      payload = { render: 'bar', unit: '%', bars: monthlyAvgRoi(series) };
      break;
    case 'annual-returns':
      payload = { render: 'bar', unit: '%', bars: annualReturns(series) };
      break;
    case 'monthly-returns':
      payload = { render: 'heatmap', unit: '%', rows: monthlyReturns(series) };
      break;
    case 'running-roi': {
      const from = getQueryString(req.query, 'from') || new Date(Date.now() - 4 * 365 * 86_400_000).toISOString().slice(0, 10);
      payload = { render: 'line', unit: '%', from, ...runningRoi(series, from) };
      break;
    }
    default:
      throw new AppError('Chart not implemented.', 501);
  }

  return sendSuccess(res, 'Chart computed successfully.', { ...def, ...payload });
});
