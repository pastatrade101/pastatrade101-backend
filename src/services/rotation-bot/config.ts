import type { BinanceMode } from './binance';

// The bot's settings come from the environment of the machine that runs it
// (backend/.env): the server for the admin page's buttons, the Mac for the command
// line. Keys are read here and never logged or sent anywhere but Binance.

export const botKeys = (mode: BinanceMode) =>
  mode === 'live'
    ? { apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET }
    : { apiKey: process.env.BINANCE_TESTNET_API_KEY, apiSecret: process.env.BINANCE_TESTNET_API_SECRET };

export const hasBotKeys = (mode: BinanceMode) => {
  const k = botKeys(mode);
  return Boolean(k.apiKey && k.apiSecret);
};

/** The most the live bot may manage (USDT); 0 when unset. */
export const maxBudgetUsdt = () => Number(process.env.BOT_MAX_BUDGET_USDT || 0);
export const liveEnabled = () => process.env.BOT_LIVE_ENABLED === 'true';

/** Why this machine can't place orders for a mode, or null when it can. */
export const whyCannotTrade = (mode: BinanceMode): string | null => {
  if (!hasBotKeys(mode)) {
    return mode === 'live'
      ? 'No live API key on this server — add BINANCE_API_KEY and BINANCE_API_SECRET to backend/.env.'
      : 'No testnet API key on this server — add BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET to backend/.env.';
  }
  if (mode === 'live' && !liveEnabled()) return 'Live trading is off — it needs BOT_LIVE_ENABLED=true in backend/.env.';
  if (mode === 'live' && !(maxBudgetUsdt() > 0)) return 'Live trading needs BOT_MAX_BUDGET_USDT in backend/.env (the most the bot may manage).';
  return null;
};
