import { AppError } from '../../utils/api-response';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FetchJsonOptions = {
  headers?: Record<string, string>;
  // Retry on 429 / 5xx with exponential backoff. CoinGecko's free tiers throttle hard.
  retries?: number;
  label?: string;
};

export const fetchJson = async <T>(url: string, options: FetchJsonOptions = {}): Promise<T> => {
  const { headers = {}, retries = 3, label = 'upstream' } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', ...headers } });

      if (response.status === 429 || response.status >= 500) {
        // Honour Retry-After when present, otherwise back off exponentially.
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
        lastError = new AppError(`${label} responded ${response.status}.`, 502);
        if (attempt < retries) {
          await sleep(backoff);
          continue;
        }
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new AppError(`${label} request failed (${response.status}): ${body.slice(0, 200)}`, 502);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
    }
  }

  throw lastError instanceof AppError ? lastError : new AppError(`${label} request failed.`, 502, [lastError]);
};
