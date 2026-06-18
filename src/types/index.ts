// Pastatrade roles. `guest` is the absence of a token (never stored on a user row);
// authenticated users are subscriber → analyst → admin in ascending privilege.
export type UserRole = 'subscriber' | 'analyst' | 'admin';

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  name: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

// Market-cycle labels surfaced on the overview + BTC dashboards.
export type MarketCondition =
  | 'Accumulation'
  | 'Cool-off'
  | 'Risk-on'
  | 'Overheated'
  | 'Distribution'
  | 'Capitulation';

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
      rawBody?: Buffer; // raw request bytes, captured for webhook signature verification
    }
  }
}
