import { createHmac } from 'node:crypto';
import type { BinanceSymbol } from './sizing';

// Minimal Binance SPOT REST client for the rotation bot.
//
// By design it has NO withdrawal, transfer, margin or futures calls: the only
// account-changing request is a spot MARKET order. Keys are read by the caller
// from the environment and never logged. Testnet (testnet.binance.vision) uses
// demo funds and its own keys; live uses api.binance.com.

export type BinanceMode = 'testnet' | 'live';

export const BASE_URL: Record<BinanceMode, string> = {
  testnet: 'https://testnet.binance.vision',
  live: 'https://api.binance.com'
};

export class BinanceError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer. */
    readonly status: number,
    /** Binance error code (e.g. -2010 insufficient balance), when it sent one. */
    readonly code: number | null
  ) {
    super(message);
  }

  /**
   * True when Binance answered and rejected the request, so nothing happened.
   * False for timeouts, network errors and 5xx — an order may or may not exist.
   */
  get rejected(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export interface OrderFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
}

export interface OrderResult {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  fills: OrderFill[];
}

export interface Balance {
  asset: string;
  free: string;
  locked: string;
}

export interface ApiRestrictions {
  ipRestrict: boolean;
  enableWithdrawals: boolean;
  enableReading: boolean;
  enableSpotAndMarginTrading: boolean;
  enableInternalTransfer?: boolean;
  permitsUniversalTransfer?: boolean;
}

interface Options {
  mode: BinanceMode;
  apiKey?: string;
  apiSecret?: string;
  timeoutMs?: number;
}

export const createBinance = ({ mode, apiKey, apiSecret, timeoutMs = 15_000 }: Options) => {
  const base = BASE_URL[mode];
  let timeOffset = 0;

  const request = async <T>(method: 'GET' | 'POST', path: string, params: Record<string, string | number> = {}, sign = false): Promise<T> => {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const headers: Record<string, string> = {};
    if (sign) {
      if (!apiKey || !apiSecret) throw new BinanceError(`No ${mode} API key configured.`, 0, null);
      query.set('timestamp', String(Date.now() + timeOffset));
      query.set('recvWindow', '5000');
      query.set('signature', createHmac('sha256', apiSecret).update(query.toString()).digest('hex'));
      headers['X-MBX-APIKEY'] = apiKey;
    }
    const qs = query.toString();
    let res: Response;
    try {
      res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new BinanceError(`${method} ${path} failed: ${(e as Error).message}`, 0, null);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const b = body as { code?: number; msg?: string } | null;
      throw new BinanceError(`Binance ${res.status} on ${method} ${path}: ${b?.msg ?? text.slice(0, 200)}`, res.status, b?.code ?? null);
    }
    return body as T;
  };

  return {
    mode,
    hasKeys: Boolean(apiKey && apiSecret),

    /** Align signed-request timestamps with Binance's clock. */
    async syncTime(): Promise<void> {
      const { serverTime } = await request<{ serverTime: number }>('GET', '/api/v3/time');
      timeOffset = serverTime - Date.now();
    },

    async exchangeInfo(): Promise<BinanceSymbol[]> {
      const info = await request<{ symbols: BinanceSymbol[] }>('GET', '/api/v3/exchangeInfo', { permissions: 'SPOT' });
      return info.symbols;
    },

    /** Last trade price for every symbol. */
    async prices(): Promise<Map<string, number>> {
      const rows = await request<{ symbol: string; price: string }[]>('GET', '/api/v3/ticker/price');
      return new Map(rows.map((r) => [r.symbol, Number(r.price)]));
    },

    async balances(): Promise<Map<string, Balance>> {
      const acct = await request<{ balances: Balance[]; canTrade: boolean }>('GET', '/api/v3/account', {}, true);
      if (!acct.canTrade) throw new BinanceError('This API key cannot trade (canTrade = false).', 0, null);
      return new Map(acct.balances.filter((b) => Number(b.free) > 0 || Number(b.locked) > 0).map((b) => [b.asset, b]));
    },

    /** Live only: the key's permissions (testnet has no such endpoint). */
    async apiRestrictions(): Promise<ApiRestrictions> {
      return request<ApiRestrictions>('GET', '/sapi/v1/account/apiRestrictions', {}, true);
    },

    async marketBuy(symbol: string, quoteOrderQty: string, clientOrderId: string): Promise<OrderResult> {
      return request<OrderResult>(
        'POST',
        '/api/v3/order',
        { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty, newClientOrderId: clientOrderId, newOrderRespType: 'FULL' },
        true
      );
    },

    async marketSell(symbol: string, quantity: string, clientOrderId: string): Promise<OrderResult> {
      return request<OrderResult>(
        'POST',
        '/api/v3/order',
        { symbol, side: 'SELL', type: 'MARKET', quantity, newClientOrderId: clientOrderId, newOrderRespType: 'FULL' },
        true
      );
    },

    /** Look up an order by our client id (to recover after a crash or timeout). */
    async findOrder(symbol: string, clientOrderId: string): Promise<OrderResult | null> {
      try {
        const o = await request<Omit<OrderResult, 'fills'>>('GET', '/api/v3/order', { symbol, origClientOrderId: clientOrderId }, true);
        if (Number(o.executedQty) <= 0) return { ...o, fills: [] };
        const trades = await request<{ price: string; qty: string; commission: string; commissionAsset: string }[]>(
          'GET',
          '/api/v3/myTrades',
          { symbol, orderId: o.orderId },
          true
        );
        return { ...o, fills: trades.map((t) => ({ price: t.price, qty: t.qty, commission: t.commission, commissionAsset: t.commissionAsset })) };
      } catch (e) {
        if (e instanceof BinanceError && e.code === -2013) return null; // Order does not exist.
        throw e;
      }
    }
  };
};

export type BinanceClient = ReturnType<typeof createBinance>;
