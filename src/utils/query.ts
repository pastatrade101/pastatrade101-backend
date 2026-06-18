import type { Request } from 'express';

const toStringValue = (value: unknown) => {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return typeof value === 'string' ? value : '';
};

export const getPagination = (query: Request['query']) => {
  const page = Math.max(Number(toStringValue(query.page)) || 1, 1);
  const limit = Math.min(Math.max(Number(toStringValue(query.limit)) || 50, 1), 250);
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  return { page, limit, from, to };
};

export const getQueryString = (query: Request['query'], key: string) => toStringValue(query[key]).trim();

export const getQueryNumber = (query: Request['query'], key: string): number | undefined => {
  const raw = toStringValue(query[key]).trim();
  if (raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const paginationMeta = (page: number, limit: number, total = 0) => ({
  page,
  limit,
  total,
  totalPages: Math.max(Math.ceil(total / limit), 1)
});

export const cleanSearch = (value: string) => value.replace(/[,%]/g, ' ').trim();
