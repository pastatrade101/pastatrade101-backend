import { supabase } from '../../config/supabase';
import { env } from '../../config/env';
import { AppError } from '../../utils/api-response';
import { getSupplyProfitLoss } from '../sources/bgeometrics.client';
import { readSeries } from '../series/store';

// ─────────────────────────────────────────────────────────────────────────────
// Bitcoin Supply in Profit & Loss
// Holder-profitability / market-stress metric derived from BGeometrics'
// supply-profit + supply-loss (BTC amounts whose last on-chain move was below /
// above the current price). We compute percentages, ratio and spread, classify
// the current market state, detect profit/loss crossovers and produce plain
// language interpretation + a Premium takeaway. This is a real on-chain metric —
// it is never synthesised from price alone.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_NAME = 'BGeometrics';
const RECOVERY_WINDOW_DAYS = 21; // a fresh profit-over-loss crossover = "recovery"

const round = (v: number, dp = 2): number => Number(v.toFixed(dp));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface SupplyRow {
  date: string;
  btc_price: number | null;
  supply_in_profit_percent: number | null;
  supply_in_loss_percent: number | null;
  supply_in_profit_btc: number | null;
  supply_in_loss_btc: number | null;
  profit_loss_ratio: number | null;
  profit_loss_spread: number | null;
}

export type CrossoverType = 'profit_above_loss' | 'loss_above_profit';
export interface Crossover {
  date: string;
  type: CrossoverType;
  meaning: string;
}

// ── Read the full stored history (chunked — ~1.3k rows and growing) ──
const readRows = async (): Promise<SupplyRow[]> => {
  const out: SupplyRow[] = [];
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('btc_supply_profit_loss')
      .select('date, btc_price, supply_in_profit_percent, supply_in_loss_percent, supply_in_profit_btc, supply_in_loss_btc, profit_loss_ratio, profit_loss_spread')
      .order('date', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error) throw new AppError('Unable to load supply profit/loss history.', 500, [error]);
    if (!data?.length) break;
    out.push(...(data as SupplyRow[]));
    if (data.length < CHUNK) break;
  }
  return out;
};

// ── Current-state classification (spread + loss% thresholds from the spec) ──
type StateLabel =
  | 'Profit dominance'
  | 'Healthy profit environment'
  | 'Equilibrium zone'
  | 'Loss dominance'
  | 'Capitulation pressure'
  | 'Recovery confirmation';

interface StateMeta {
  state: StateLabel;
  signal: string;
  tone: 'profit' | 'healthy' | 'neutral' | 'loss' | 'capitulation' | 'recovery';
}

const baseState = (lossPct: number, spread: number): StateMeta => {
  if (lossPct > 55) return { state: 'Capitulation pressure', signal: 'Capitulation pressure / extreme stress', tone: 'capitulation' };
  if (spread > 50 || lossPct <= 20) return { state: 'Profit dominance', signal: 'Profit dominance / possible distribution risk', tone: 'profit' };
  if (spread >= 20) return { state: 'Healthy profit environment', signal: 'Healthy profit environment', tone: 'healthy' };
  if (spread >= -10) return { state: 'Equilibrium zone', signal: 'Equilibrium / transition zone', tone: 'neutral' };
  return { state: 'Loss dominance', signal: 'Loss dominance / market stress', tone: 'loss' };
};

const interpretationFor = (meta: StateMeta, profitPct: number, lossPct: number, spread: number): string => {
  const p = round(profitPct, 1);
  const l = round(lossPct, 1);
  const s = round(spread, 1);
  switch (meta.tone) {
    case 'capitulation':
      return `${l}% of BTC supply is in loss versus ${p}% in profit (spread ${s > 0 ? '+' : ''}${s}%). A large share of holders are underwater — historically a capitulation-style / late bear-market environment. This can support accumulation, but price can stay weak for an extended period.`;
    case 'loss':
      return `More BTC supply is underwater than in profit — ${l}% in loss versus ${p}% in profit (spread ${s}%). This suggests market stress and potential accumulation conditions, but it should be confirmed with the BTC risk score, on-chain metrics and price trend. Loss dominance is not automatically bullish.`;
    case 'neutral':
      return `Supply in profit (${p}%) and supply in loss (${l}%) are close (spread ${s > 0 ? '+' : ''}${s}%). The market is near a pain/equilibrium zone — historically this convergence often appears during deep bear-market or bottoming conditions, or during transitions.`;
    case 'healthy':
      return `${p}% of BTC supply is in profit versus ${l}% in loss (spread +${s}%). A healthy profit environment: most holders are in profit without the extreme readings seen at cycle tops.`;
    case 'recovery':
      return `Supply in profit (${p}%) has moved back above supply in loss (${l}%, spread ${s > 0 ? '+' : ''}${s}%). More supply is returning to profit — a sign of recovery from prior stress. Confirm with the BTC risk score and price trend.`;
    case 'profit':
    default:
      return `${p}% of BTC supply is in profit versus ${l}% in loss (spread +${s}%). Most holders are in profit — this is common in strong bull markets and can raise distribution risk if price is also extended above its trend.`;
  }
};

const takeawayFor = (meta: StateMeta, profitPct: number, lossPct: number): string => {
  switch (meta.tone) {
    case 'capitulation':
      return 'A majority of BTC supply is underwater. Historically this kind of stress appears in late bear markets and capitulation phases rather than tops. It supports accumulation pressure over distribution risk, but it is not a precise bottom signal — price can remain weak for months.';
    case 'loss':
      return `BTC supply in loss is slightly higher than supply in profit. Historically this type of condition appears during market stress rather than euphoria. It supports the view that the market is closer to accumulation pressure than distribution risk, but it is not a precise bottom signal.`;
    case 'neutral':
      return 'Supply in profit and loss are near equilibrium. This convergence has historically appeared around bottoming or transition phases. Treat it as a low-conviction zone — confirm direction with the BTC risk score, on-chain metrics and price trend.';
    case 'healthy':
      return 'Most supply is in profit without extreme readings. This is a constructive, mid-cycle profitability environment. Distribution risk only becomes elevated if profit dominance climbs toward euphoria while price is extended.';
    case 'recovery':
      return 'Supply has shifted back into profit after a period of stress — an early sign of recovery. Confirm follow-through with price trend and the broader on-chain risk score before treating it as a durable turn.';
    case 'profit':
    default:
      return `Roughly ${round(profitPct, 0)}% of supply is in profit. High profit dominance can mark a mature or overheated market; distribution risk rises if this coincides with price extended above its long-term trend. It is a context signal, not a sell trigger.`;
  }
};

// ── Crossover detection (sign change of the profit−loss spread) ──
const detectCrossovers = (rows: SupplyRow[]): Crossover[] => {
  const out: Crossover[] = [];
  let prev: number | null = null;
  for (const r of rows) {
    const s = r.profit_loss_spread;
    if (s == null) continue;
    if (prev != null) {
      if (prev < 0 && s >= 0)
        out.push({ date: r.date, type: 'profit_above_loss', meaning: 'Market recovery is improving — more supply is returning to profit.' });
      else if (prev > 0 && s <= 0)
        out.push({ date: r.date, type: 'loss_above_profit', meaning: 'Market stress is increasing — this can appear during deep corrections or bear-market capitulation.' });
    }
    prev = s;
  }
  return out;
};

const RISK_LABELS = (r: number): string => (r < 0.4 ? 'Low' : r < 0.6 ? 'Moderate' : r < 0.8 ? 'Elevated' : 'High');

// Build the "latest" summary block shared by both endpoints.
const buildSummary = (rows: SupplyRow[], crossovers: Crossover[]) => {
  const latest = rows[rows.length - 1];
  if (!latest || latest.supply_in_profit_percent == null || latest.supply_in_loss_percent == null) return null;

  const profitPct = Number(latest.supply_in_profit_percent);
  const lossPct = Number(latest.supply_in_loss_percent);
  const spread = Number(latest.profit_loss_spread ?? profitPct - lossPct);

  let meta = baseState(lossPct, spread);
  // Promote to "Recovery confirmation" when profit has just regained the lead.
  const lastCross = crossovers[crossovers.length - 1];
  const recentRecovery =
    lastCross && lastCross.type === 'profit_above_loss' && daysBetween(lastCross.date, latest.date) <= RECOVERY_WINDOW_DAYS;
  if (recentRecovery && spread >= 0 && meta.tone !== 'profit' && meta.tone !== 'healthy')
    meta = { state: 'Recovery confirmation', signal: 'Recovery confirmation / improving conditions', tone: 'recovery' };

  // Own normalized risk: higher profit dominance → higher cycle/distribution risk.
  const riskScore = round(Math.min(1, Math.max(0, profitPct / 100)), 3);

  return {
    date: latest.date,
    btc_price: latest.btc_price,
    supply_in_profit_percent: round(profitPct, 1),
    supply_in_loss_percent: round(lossPct, 1),
    supply_in_profit_btc: latest.supply_in_profit_btc,
    supply_in_loss_btc: latest.supply_in_loss_btc,
    profit_loss_ratio: latest.profit_loss_ratio,
    profit_loss_spread: round(spread, 1),
    current_state: meta.state,
    signal: meta.signal,
    tone: meta.tone,
    interpretation: interpretationFor(meta, profitPct, lossPct, spread),
    premium_takeaway: takeawayFor(meta, profitPct, lossPct),
    risk_score: riskScore,
    risk_label: RISK_LABELS(riskScore),
    recent_crossover: lastCross ? { date: lastCross.date, type: lastCross.type, meaning: lastCross.meaning } : null,
    source_name: SOURCE_NAME,
    source_status: 'active' as const,
    last_synced: latest.date
  };
};

export type SupplySummary = NonNullable<ReturnType<typeof buildSummary>>;

// ── Sync: fetch BGeometrics supply-profit/loss, derive, store ──
export const syncSupplyProfitLoss = async (): Promise<number> => {
  const { profit, loss } = await getSupplyProfitLoss();

  if (!profit.length || !loss.length) {
    // Nothing fetched — only acceptable if we already have stored data.
    const { count } = await supabase.from('btc_supply_profit_loss').select('id', { count: 'exact', head: true });
    if (!count)
      throw new AppError(
        'Supply in Profit/Loss returned no data — likely the keyless rate limit (10 req/hour). Add BITCOIN_DATA_API_KEY or retry next hour.',
        502
      );
    return 0;
  }

  const lossByDate = new Map(loss.map((p) => [p.date, p.value]));
  const btc = await readSeries('btc-full').catch(() => []);
  const priceByDate = new Map(btc.map((p) => [p.date, p.value]));

  const rows = profit
    .map((p) => {
      const profitBtc = p.value;
      const lossBtc = lossByDate.get(p.date);
      if (lossBtc == null) return null;
      const total = profitBtc + lossBtc;
      if (!(total > 0)) return null;
      const profitPct = (profitBtc / total) * 100;
      const lossPct = (lossBtc / total) * 100;
      const ratio = lossPct > 0 ? profitPct / lossPct : null;
      return {
        date: p.date,
        btc_price: priceByDate.get(p.date) ?? null,
        supply_in_profit_percent: round(profitPct, 2),
        supply_in_loss_percent: round(lossPct, 2),
        supply_in_profit_btc: round(profitBtc, 2),
        supply_in_loss_btc: round(lossBtc, 2),
        profit_loss_ratio: ratio == null ? null : round(ratio, 4),
        profit_loss_spread: round(profitPct - lossPct, 2),
        source_name: SOURCE_NAME,
        source_status: 'active',
        updated_at: new Date().toISOString()
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase.from('btc_supply_profit_loss').upsert(rows.slice(i, i + 1000), { onConflict: 'date' });
    if (error) throw new AppError('Failed to store supply profit/loss data.', 500, [error]);
  }
  return rows.length;
};

// ── Read APIs for the controllers ──
export const getSupplyProfitLossLatest = async (): Promise<SupplySummary | null> => {
  const rows = await readRows();
  if (!rows.length) return null;
  return buildSummary(rows, detectCrossovers(rows));
};

export const getSupplyProfitLossHistory = async () => {
  const rows = await readRows();
  if (!rows.length)
    return {
      available: false,
      reason: env.BITCOIN_DATA_API_KEY ? 'Not synced yet — run the on-chain sync.' : 'Supply in Profit/Loss unavailable from current provider.',
      series: [] as SupplyRow[],
      crossovers: [] as Crossover[],
      latest: null as SupplySummary | null
    };
  const crossovers = detectCrossovers(rows);
  return { available: true, reason: null, series: rows, crossovers, latest: buildSummary(rows, crossovers) };
};
