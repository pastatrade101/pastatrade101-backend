import { supabase } from '../../config/supabase';
import { getTrendingCoins, getCategories } from '../sources/coingeckoRadar.client';
import { getTrendingPools, parseGtId, type GtPool } from '../sources/geckoTerminal.client';
import { screenTokens, type TokenSecurity } from '../sources/goplus.client';
import { fromTrendingCoin, fromTrendingPool, type RadarCandidate } from './earlyOpportunity.service';
import { getSettings } from './earlyOpportunitySettings.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_SEC: TokenSecurity = { checked: false, is_honeypot: null, buy_tax: null, sell_tax: null, is_open_source: null, mintable: null, freezable: null };

const log = async (source_name: string, status: string, records: number, started: string, error?: string, metadata?: Record<string, unknown>) => {
  try {
    await supabase.from('early_opportunity_sync_logs').insert({ source_name, status, started_at: started, finished_at: new Date().toISOString(), records_processed: records, error_message: error ?? null, metadata: metadata ?? null });
  } catch {
    /* logging is best-effort */
  }
};

/**
 * Fetch all radar sources, screen DEX tokens with GoPlus, score, and store.
 * Each source is logged and isolated — one failure can't break the others.
 * Returns the number of candidates upserted.
 */
export const runEarlyOpportunitySync = async (): Promise<number> => {
  const settings = await getSettings();
  const startedAt = new Date().toISOString();

  // ── 1. Trending coins (CoinGecko) ──
  let coins: RadarCandidate[] = [];
  try {
    const t0 = new Date().toISOString();
    const raw = await getTrendingCoins();
    coins = raw.map((item, i) => fromTrendingCoin(item, i + 1, raw.length, settings)).filter((c): c is RadarCandidate => c !== null);
    await log('coingecko_trending', raw.length ? 'success' : 'unavailable', coins.length, t0);
  } catch (e) {
    await log('coingecko_trending', 'failed', 0, startedAt, e instanceof Error ? e.message : String(e));
  }

  // ── 2. Trending DEX pools (GeckoTerminal): global + a few networks ──
  const poolMap = new Map<string, GtPool>();
  try {
    const t0 = new Date().toISOString();
    const networks = ['', 'eth', 'solana', 'base']; // '' = global
    for (const net of networks) {
      const pools = await getTrendingPools(net || undefined);
      for (const p of pools) if (!poolMap.has(p.id)) poolMap.set(p.id, p);
      await sleep(1200); // respect ~30 req/min
    }
    await log('geckoterminal_trending', poolMap.size ? 'success' : 'unavailable', poolMap.size, t0, undefined, { networks: networks.length });
  } catch (e) {
    await log('geckoterminal_trending', 'failed', 0, startedAt, e instanceof Error ? e.message : String(e));
  }

  // ── 3. GoPlus security screening for pool base tokens ──
  let security: Record<string, TokenSecurity> = {};
  const pools = [...poolMap.values()];
  try {
    const t0 = new Date().toISOString();
    const tokens = pools
      .map((p) => {
        const { network } = parseGtId(p.id);
        const contract = parseGtId(p.relationships?.base_token?.data?.id).address;
        return network && contract ? { network, contract } : null;
      })
      .filter((x): x is { network: string; contract: string } => x !== null);
    security = await screenTokens(tokens);
    await log('goplus_security', Object.keys(security).length ? 'success' : 'partial', Object.values(security).filter((s) => s.checked).length, t0);
  } catch (e) {
    await log('goplus_security', 'failed', 0, startedAt, e instanceof Error ? e.message : String(e));
  }

  const poolCands = pools
    .map((p, i) => {
      const { network } = parseGtId(p.id);
      const contract = parseGtId(p.relationships?.base_token?.data?.id).address;
      const sec = network && contract ? security[`${network}:${contract.toLowerCase()}`] ?? NO_SEC : NO_SEC;
      return fromTrendingPool(p, i + 1, pools.length, settings, sec);
    })
    .filter((c): c is RadarCandidate => c !== null);

  // ── 4. Categories (narrative radar) — fetched for the view, logged here ──
  try {
    const t0 = new Date().toISOString();
    const cats = await getCategories();
    await log('coingecko_categories', cats.length ? 'success' : 'unavailable', cats.length, t0);
  } catch (e) {
    await log('coingecko_categories', 'failed', 0, startedAt, e instanceof Error ? e.message : String(e));
  }

  // ── 5. Store candidates + daily history ──
  const all = [...coins, ...poolCands];
  if (!all.length) return 0;

  const now = new Date().toISOString();
  const rows = all.map((c) => ({ ...c, quality_badges: c.quality_badges, risk_flags: c.risk_flags, last_seen_at: now, updated_at: now, source_status: 'active' }));

  const { data: upserted, error } = await supabase
    .from('early_opportunity_candidates')
    .upsert(rows, { onConflict: 'source_name,external_id' })
    .select('id, source_name, external_id, opportunity_score, risk_score, confidence, price_usd, liquidity_usd, volume_24h, transactions_24h');
  if (error) throw new Error(`Failed to store radar candidates: ${error.message}`);

  // Daily history snapshot (one row per candidate per day).
  const today = now.slice(0, 10);
  const histRows = (upserted ?? []).map((u) => ({
    candidate_id: u.id,
    date: today,
    price_usd: u.price_usd,
    liquidity_usd: u.liquidity_usd,
    volume_24h: u.volume_24h,
    transactions_24h: u.transactions_24h,
    opportunity_score: u.opportunity_score,
    risk_score: u.risk_score,
    confidence: u.confidence
  }));
  if (histRows.length) {
    for (let i = 0; i < histRows.length; i += 500) {
      await supabase.from('early_opportunity_history').upsert(histRows.slice(i, i + 500), { onConflict: 'candidate_id,date' });
    }
  }

  return upserted?.length ?? all.length;
};
