import type { Request, Response } from 'express';
import { getRotationIndexView, isIndexId, stepRotationIndex, type IndexId } from '../services/rotation-index/rotationIndex.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';

const indexId = (req: Request): IndexId => {
  const id = (req.params.id as string | undefined) ?? 'rotation-balanced';
  if (!isIndexId(id)) throw new AppError(`Unknown index: ${id}`, 404);
  return id;
};

// GET /api/v1/admin/rotation-index/:id? — the tracked index, its holdings and reviews.
export const adminRotationIndex = asyncHandler(async (req: Request, res: Response) => {
  return sendSuccess(res, 'Rotation index fetched.', await getRotationIndexView(indexId(req)));
});

// POST /api/v1/admin/rotation-index/:id?/update — add any final days not saved yet.
export const adminStepRotationIndex = asyncHandler(async (req: Request, res: Response) => {
  const r = await stepRotationIndex(indexId(req));
  return sendSuccess(res, r.added ? `Added ${r.added} day(s).` : 'Already up to date.', r);
});
