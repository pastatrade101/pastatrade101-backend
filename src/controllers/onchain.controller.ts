import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getSupplyProfitLossLatest, getSupplyProfitLossHistory } from '../services/sync/supply-profit-loss.service';

// GET /api/v1/onchain/supply-profit-loss  → latest reading + state + interpretation.
export const supplyProfitLoss = asyncHandler(async (_req, res) => {
  const latest = await getSupplyProfitLossLatest();
  if (!latest) throw new AppError('Supply in Profit/Loss data is not available yet. Run an on-chain sync.', 503);
  return sendSuccess(res, 'Supply in profit/loss fetched successfully.', latest);
});

// GET /api/v1/onchain/supply-profit-loss/history  → full series + crossovers.
export const supplyProfitLossHistory = asyncHandler(async (_req, res) => {
  const data = await getSupplyProfitLossHistory();
  return sendSuccess(res, 'Supply in profit/loss history fetched successfully.', data);
});
