import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import { importCsv } from '../services/log-regression/csvImport.service';
import { storeLogRegression } from '../services/log-regression/logRegression.service';
import { listSettings, saveSettings, type AssetSymbol } from '../services/log-regression/logRegressionSettings.service';
import { withJob } from '../services/sync/sync-jobs';

const parseAsset = (raw: string | undefined): AssetSymbol => {
  const a = (raw ?? '').toUpperCase();
  if (a !== 'BTC' && a !== 'ETH') throw new AppError('Unknown asset. Use BTC or ETH.', 400);
  return a;
};

// POST /api/v1/admin/data-import/log-regression?asset=BTC&source=coingecko
// Body: raw CSV text (Content-Type: text/csv).
export const adminImportLogRegressionCsv = asyncHandler(async (req: Request, res: Response) => {
  const asset = parseAsset(getQueryString(req.query, 'asset'));
  const source = getQueryString(req.query, 'source') || 'csv';
  const csv = typeof req.body === 'string' ? req.body : (req.body?.csv as string | undefined);
  if (!csv || csv.trim().length < 10) throw new AppError('No CSV content received. Upload a CSV file.', 400);
  const summary = await importCsv(asset, csv, source);
  // Recompute bands from the freshly imported data.
  if (summary.rows_imported > 0) await storeLogRegression(asset).catch(() => 0);
  return sendSuccess(res, 'CSV imported successfully.', summary);
});

// POST /api/v1/admin/charts/log-regression/:asset/recalculate
export const adminRecalcLogRegression = asyncHandler(async (req: Request, res: Response) => {
  const asset = parseAsset(req.params.asset);
  const rows = await withJob('log-regression', `log-regression-${asset}`, req.user!.sub, () => storeLogRegression(asset));
  return sendSuccess(res, 'Regression bands recalculated.', { asset, rows });
});

// GET /api/v1/admin/charts/log-regression/settings
export const adminGetLogRegressionSettings = asyncHandler(async (_req: Request, res: Response) => {
  const items = await listSettings();
  return sendSuccess(res, 'Settings fetched successfully.', { items });
});

// PUT /api/v1/admin/charts/log-regression/settings/:asset
export const adminUpdateLogRegressionSettings = asyncHandler(async (req: Request, res: Response) => {
  const asset = parseAsset(req.params.asset);
  const updated = await saveSettings(asset, req.body ?? {});
  return sendSuccess(res, 'Settings updated successfully.', updated);
});
