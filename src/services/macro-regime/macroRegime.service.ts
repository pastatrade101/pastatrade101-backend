import { supabase } from '../../config/supabase';
import { getDailySeries, macroConfigured, type TdPoint } from '../sources/twelvedata.client';

// ─────────────────────────────────────────────────────────────────────────────
// Macro Regime — reads the traditional-market backdrop (dollar, equities,
// volatility, gold, rates) and distils it into a risk-on / risk-off read for
// crypto. Twelve Data is used INTERNALLY to derive a signal; raw quotes are not
// stored or displayed — only directional reads. Graceful when symbols/keys are
// missing (reweights over what's available, like every Pastatrade model).
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Role = 'equities' | 'dollar' | 'volatility' | 'gold' | 'rates';
interface Input {
  symbol: string;
  role: Role;
  weight: number;
  label: string;
}

// The free Twelve Data plan serves US ETFs + forex, but NOT indices (DXY/VIX) or
// bond yields. So we use ETF proxies that ARE free: UUP tracks the dollar index,
// VIXY tracks VIX futures. This keeps the two biggest crypto drivers (dollar +
// volatility) working on the free tier. Each is optional and reweights.
const INPUTS: Input[] = [
  { symbol: 'SPY', role: 'equities', weight: 0.35, label: 'Equities (S&P 500)' },
  { symbol: 'UUP', role: 'dollar', weight: 0.35, label: 'US Dollar' },
  { symbol: 'VIXY', role: 'volatility', weight: 0.2, label: 'Volatility' },
  // XAU/USD (spot gold) is used instead of the GLD ticker — "GLD" resolves
  // ambiguously (e.g. a JSE fund), whereas XAU/USD is unambiguous spot gold in USD.
  { symbol: 'XAU/USD', role: 'gold', weight: 0.1, label: 'Gold' }
];

interface Analysis {
  last: number;
  mom20: number;
  direction: 'up' | 'down' | 'flat';
  bullish: number; // 0–1 uptrend strength
}

const analyze = (s: TdPoint[]): Analysis | null => {
  if (s.length < 25) return null;
  const c = s.map((p) => p.close);
  const last = c[c.length - 1];
  const ma20 = mean(c.slice(-20));
  const ma50 = c.length >= 50 ? mean(c.slice(-50)) : ma20;
  const mom20 = c[c.length - 21] ? last / c[c.length - 21] - 1 : 0;
  const bullish = clamp01((last > ma20 ? 0.45 : 0) + (ma20 >= ma50 ? 0.25 : 0) + clamp01((mom20 + 0.04) / 0.12) * 0.3);
  const direction = last > ma20 && mom20 > 0.005 ? 'up' : last < ma20 && mom20 < -0.005 ? 'down' : 'flat';
  return { last, mom20, direction, bullish };
};

// Risk-on contribution (0–1, high = supportive for crypto) per input role.
// Symmetric around 0.5 so a neutral input doesn't push the regime either way.
const contribution = (role: Role, a: Analysis): number => {
  if (role === 'equities') return a.bullish; // equities up = risk-on
  if (role === 'dollar' || role === 'rates') return 1 - a.bullish; // dollar up = headwind
  if (role === 'volatility') return 1 - a.bullish; // volatility (VIXY) up = risk-off
  // gold: ambiguous (safe-haven vs debasement) → only a mild tilt, centred at 0.5
  return clamp01(0.5 + (0.5 - a.bullish) * 0.5);
};

interface Component {
  input: string;
  read: string;
  driver: string;
  tone: 'good' | 'warn' | 'neutral';
}

const describe = (input: Input, a: Analysis, c: number): Component => {
  // Tone follows the directional read so the colour matches the word (a sideways
  // input reads neutral, not green). The numeric `c` still drives the score.
  void c;
  const riskOn = input.role === 'equities' ? a.direction === 'up' : input.role === 'dollar' || input.role === 'volatility' ? a.direction === 'down' : false;
  const riskOff = input.role === 'equities' ? a.direction === 'down' : input.role === 'dollar' || input.role === 'volatility' ? a.direction === 'up' : false;
  const tone: Component['tone'] = riskOn ? 'good' : riskOff ? 'warn' : 'neutral';
  let read: string;
  let driver: string;
  switch (input.role) {
    case 'equities':
      read = a.direction === 'up' ? 'Trending up — risk-on' : a.direction === 'down' ? 'Trending down — risk-off' : 'Sideways';
      driver = a.direction === 'up' ? 'equities are trending higher' : a.direction === 'down' ? 'equities are falling' : 'equities are sideways';
      break;
    case 'dollar':
      read = a.direction === 'up' ? 'Strengthening — headwind' : a.direction === 'down' ? 'Weakening — tailwind' : 'Stable';
      driver = a.direction === 'up' ? 'the dollar is strengthening' : a.direction === 'down' ? 'the dollar is easing' : 'the dollar is stable';
      break;
    case 'volatility':
      read = a.direction === 'up' ? 'Rising — risk-off' : a.direction === 'down' ? 'Falling — risk-on' : 'Stable';
      driver = a.direction === 'up' ? 'volatility is rising' : a.direction === 'down' ? 'volatility is easing' : 'volatility is subdued';
      break;
    case 'gold':
      read = a.direction === 'up' ? 'Bid — some caution' : a.direction === 'down' ? 'Softer' : 'Stable';
      driver = a.direction === 'up' ? 'gold is bid' : a.direction === 'down' ? 'gold is softening' : 'gold is stable';
      break;
    default:
      read = a.direction === 'up' ? 'Yields rising — headwind' : a.direction === 'down' ? 'Yields falling — tailwind' : 'Yields stable';
      driver = a.direction === 'up' ? 'yields are rising' : a.direction === 'down' ? 'yields are falling' : 'yields are stable';
  }
  return { input: input.label, read, driver, tone };
};

export interface MacroRegimeResult {
  as_of: string;
  regime_score: number | null; // 0–100, high = risk-on
  regime_label: string;
  dollar_trend: 'strengthening' | 'weakening' | 'stable' | 'unknown';
  confidence: 'High' | 'Medium' | 'Low';
  symbols_used: number;
  components: Component[];
  interpretation: string;
}

const labelFor = (s: number): string => (s < 20 ? 'Strong risk-off' : s < 40 ? 'Risk-off' : s < 60 ? 'Neutral / mixed' : s < 80 ? 'Risk-on' : 'Strong risk-on');

const buildInterpretation = (score: number, comps: Component[]): string => {
  const supportive = comps.filter((c) => c.tone === 'good').map((c) => c.driver);
  const cautionary = comps.filter((c) => c.tone === 'warn').map((c) => c.driver);
  const list = (a: string[]) => (a.length === 1 ? a[0] : a.length === 2 ? `${a[0]} and ${a[1]}` : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  if (score >= 60) {
    return `Risk-on macro backdrop for crypto — ${supportive.length ? list(supportive) : 'conditions are broadly supportive'}. This is a tailwind for Bitcoin and risk assets.${cautionary.length ? ` Watch for a shift if ${list(cautionary)}.` : ' Watch the dollar and volatility for any reversal.'}`;
  }
  if (score < 40) {
    return `Risk-off macro backdrop — ${cautionary.length ? list(cautionary) : 'conditions are broadly cautious'}, a headwind for crypto and risk assets. Historically this pressures Bitcoin, so patience and risk management are warranted.${supportive.length ? ` The one bright spot: ${list(supportive)}.` : ''}`;
  }
  return `Mixed macro signals — ${supportive.length ? list(supportive) : 'some support'}, but ${cautionary.length ? list(cautionary) : 'some caution'}. No clear risk-on or risk-off regime; crypto lacks a strong macro tailwind or headwind right now.`;
};

export const computeMacroRegime = async (): Promise<MacroRegimeResult> => {
  const analyzed: { input: Input; a: Analysis }[] = [];
  if (macroConfigured()) {
    for (const input of INPUTS) {
      const s = await getDailySeries(input.symbol, 60);
      const a = analyze(s);
      if (a) analyzed.push({ input, a });
      await sleep(2200); // respect the 8-credits/min free limit
    }
  }

  if (!analyzed.length) {
    return {
      as_of: new Date().toISOString(),
      regime_score: null,
      regime_label: 'Unavailable',
      dollar_trend: 'unknown',
      confidence: 'Low',
      symbols_used: 0,
      components: [],
      interpretation: macroConfigured() ? 'Macro market data is unavailable right now. This read is skipped until it returns.' : 'Macro regime is not configured (Twelve Data key missing).'
    };
  }

  let wsum = 0;
  let acc = 0;
  const components: Component[] = [];
  let dollar_trend: MacroRegimeResult['dollar_trend'] = 'unknown';
  for (const { input, a } of analyzed) {
    const c = contribution(input.role, a);
    wsum += input.weight;
    acc += input.weight * c;
    components.push(describe(input, a, c));
    if (input.role === 'dollar') dollar_trend = a.direction === 'up' ? 'strengthening' : a.direction === 'down' ? 'weakening' : 'stable';
  }
  const regime_score = Math.round(100 * clamp01(acc / (wsum || 1)));
  const confidence: MacroRegimeResult['confidence'] = analyzed.length >= 4 ? 'High' : analyzed.length >= 2 ? 'Medium' : 'Low';

  return {
    as_of: new Date().toISOString(),
    regime_score,
    regime_label: labelFor(regime_score),
    dollar_trend,
    confidence,
    symbols_used: analyzed.length,
    components,
    interpretation: buildInterpretation(regime_score, components)
  };
};

/** Compute + store today's macro regime. Returns 1 when stored, 0 when unavailable. */
export const storeMacroRegimeDaily = async (): Promise<number> => {
  const r = await computeMacroRegime();
  if (r.regime_score == null) return 0;
  const now = new Date().toISOString();
  const { error } = await supabase.from('macro_regime_daily').upsert(
    {
      date: now.slice(0, 10),
      regime_score: r.regime_score,
      regime_label: r.regime_label,
      dollar_trend: r.dollar_trend,
      confidence: r.confidence,
      symbols_used: r.symbols_used,
      components: r.components,
      interpretation: r.interpretation,
      source_status: 'active',
      updated_at: now
    },
    { onConflict: 'date' }
  );
  if (error) throw new Error(`Failed to store macro regime: ${error.message}`);
  return 1;
};

/** Latest stored read — for the overview + the module page. Best-effort. */
export const getLatestMacroRegime = async (): Promise<{ regime_score: number | null; regime_label: string; dollar_trend: string } | null> => {
  try {
    const { data } = await supabase.from('macro_regime_daily').select('regime_score, regime_label, dollar_trend').order('date', { ascending: false }).limit(1).maybeSingle();
    if (!data || data.regime_score == null) return null;
    return { regime_score: Number(data.regime_score), regime_label: (data.regime_label as string) ?? 'Neutral', dollar_trend: (data.dollar_trend as string) ?? 'unknown' };
  } catch {
    return null;
  }
};
