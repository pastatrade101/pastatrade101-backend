import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(5050),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal('')),

  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters long')
    .default('development-only-change-this-secret'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // Google Sign-In — OAuth client ID (public). Used as the audience when
  // verifying the ID token. Blank → falls back to the baked-in public client id.
  GOOGLE_CLIENT_ID: z.string().optional().or(z.literal('')),

  // Payments — Snippe (mobile money / card / QR). Blank → provider disabled, so
  // upgrades fall back to manual admin activation.
  SNIPPE_API_KEY: z.string().optional().or(z.literal('')),
  SNIPPE_WEBHOOK_SECRET: z.string().optional().or(z.literal('')),
  SNIPPE_BASE_URL: z.string().url().default('https://api.snippe.sh'),
  // Public URL of THIS backend — used to build the Snippe webhook callback URL.
  PUBLIC_API_URL: z.string().url().default('http://localhost:5050'),

  // External data sources
  COINGECKO_API_KEY: z.string().optional().or(z.literal('')),
  // On-chain metrics — BGeometrics / bitcoin-data.com (free tier). Key is
  // optional (endpoints work keyless, just lower quota); blank = still works.
  BITCOIN_DATA_API_KEY: z.string().optional().or(z.literal('')),
  // Optional social sources (graceful if blank).
  YOUTUBE_API_KEY: z.string().optional().or(z.literal('')),
  // Anthropic (Claude) — powers the premium AI market synthesis. Blank → feature
  // silently disabled, the deterministic rule-based verdict is served instead.
  ANTHROPIC_API_KEY: z.string().optional().or(z.literal('')),
  ANTHROPIC_MODEL: z.string().optional().or(z.literal('')),
  // SerpApi Google Trends (preferred provider). Blank → unofficial connector → none.
  SERPAPI_API_KEY: z.string().optional().or(z.literal('')),
  // Twelve Data (macro regime: DXY / SPY / VIX / gold). Blank → module unavailable.
  TWELVE_DATA_API_KEY: z.string().optional().or(z.literal('')),
  // ICO intelligence (Early Project Radar) source. Disabled by default — no
  // scraping happens until ICODROPS_ENABLED=true AND a source URL is set. Robots
  // rules are still honoured at runtime regardless of these.
  ICODROPS_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  ICODROPS_BASE_URL: z.string().url().default('https://icodrops.com'),
  // Optional JSON endpoint (API-first). Leave blank to use the HTML collector.
  ICODROPS_API_URL: z.string().optional().or(z.literal('')),
  // CryptoRank — documented ICO / funding-round API (the primary Early Project
  // Radar source). Blank key → source is simply skipped in the sync.
  CRYPTORANK_API_KEY: z.string().optional().or(z.literal('')),
  CRYPTORANK_BASE_URL: z.string().url().default('https://api.cryptorank.io/v3'),
  // Endpoint path for the project/ICO list. Overridable without a code change if
  // your plan exposes a dedicated sales endpoint.
  CRYPTORANK_ICO_PATH: z.string().optional().or(z.literal('')),
  // Optional seed of CryptoRank ids to track (comma-separated). The admin UI is
  // the main way to manage the tracked list; this just pre-seeds numeric ids.
  CRYPTORANK_TRACK: z.string().optional().or(z.literal('')),
  COINGECKO_PRO: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  DEFILLAMA_BASE_URL: z.string().url().default('https://api.llama.fi'),
  STABLECOINS_BASE_URL: z.string().url().default('https://stablecoins.llama.fi'),

  // Cache + sync tuning
  CACHE_TTL_SECONDS: z.coerce.number().default(120),
  COINGECKO_THROTTLE_MS: z.coerce.number().default(2500),

  // In-process scheduler (auto-runs syncs while the server is up).
  SCHEDULER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'), // default on; set SCHEDULER_ENABLED=false to disable
  SCHEDULER_RUN_ON_BOOT: z
    .string()
    .optional()
    .transform((v) => v === 'true'), // default off, so restarts don't re-hammer upstreams
  FULL_SYNC_INTERVAL_MIN: z.coerce.number().default(120),
  PRICE_SYNC_INTERVAL_HOURS: z.coerce.number().default(24),
  RISK_SYNC_INTERVAL_HOURS: z.coerce.number().default(24),
  // On-chain (BGeometrics) is the only scheduler job that spends the free quota
  // (4 requests/run), so keep it daily.
  ONCHAIN_SYNC_INTERVAL_HOURS: z.coerce.number().default(24)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const messages = parsed.error.errors.map((error) => `${error.path.join('.')}: ${error.message}`);
  throw new Error(`Invalid environment configuration: ${messages.join(', ')}`);
}

if (parsed.data.NODE_ENV === 'production') {
  if (!parsed.data.SUPABASE_URL || !parsed.data.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.');
  }

  if (parsed.data.JWT_SECRET === 'development-only-change-this-secret') {
    throw new Error('JWT_SECRET must be changed in production.');
  }
}

export const env = parsed.data;

// Snippe payments config. `configured` gates the whole payment flow — when the
// API key is blank, upgrades fall back to manual admin activation.
export const snippe = {
  apiKey: env.SNIPPE_API_KEY || '',
  webhookSecret: env.SNIPPE_WEBHOOK_SECRET || '',
  baseUrl: env.SNIPPE_BASE_URL.replace(/\/+$/, ''),
  webhookUrl: `${env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/v1/payments/webhook/snippe`,
  configured: Boolean(env.SNIPPE_API_KEY)
};

// Twelve Data — macro regime (traditional-market context). `configured` gates the
// module; when blank the Macro Regime read is simply "unavailable".
export const twelvedata = {
  apiKey: env.TWELVE_DATA_API_KEY || '',
  configured: Boolean(env.TWELVE_DATA_API_KEY)
};

// ICO intelligence source config. `enabled` requires the explicit opt-in flag; the
// collector also checks robots.txt at runtime before fetching any path.
export const icodrops = {
  enabled: Boolean(env.ICODROPS_ENABLED),
  baseUrl: env.ICODROPS_BASE_URL.replace(/\/+$/, ''),
  apiUrl: env.ICODROPS_API_URL || '',
  hasApi: Boolean(env.ICODROPS_API_URL)
};

// CryptoRank — documented ICO / funding API. `configured` (a key is present) gates
// the source; the collector reads baseUrl + icoPath.
export const cryptorank = {
  apiKey: env.CRYPTORANK_API_KEY || '',
  baseUrl: env.CRYPTORANK_BASE_URL.replace(/\/+$/, ''),
  icoPath: env.CRYPTORANK_ICO_PATH || '/currencies',
  track: (env.CRYPTORANK_TRACK || '').split(',').map((s) => s.trim()).filter(Boolean),
  configured: Boolean(env.CRYPTORANK_API_KEY)
};

// CoinGecko sends Demo keys to api.coingecko.com and Pro keys to pro-api.coingecko.com,
// each with a different header name. Resolve both here so the client stays dumb.
export const coingecko = {
  baseUrl: env.COINGECKO_PRO ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3',
  headerName: env.COINGECKO_PRO ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key',
  apiKey: env.COINGECKO_API_KEY || '',
  hasKey: Boolean(env.COINGECKO_API_KEY)
};

// Comma-separated list of allowed front-end origins for CORS. Trailing slashes are stripped.
export const allowedOrigins = env.FRONTEND_URL.split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
