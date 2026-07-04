/**
 * Token Position Radar — scoring-engine tests (v2).
 * Run:  npx tsx src/scripts/test-token-radar-scoring.ts
 * Pure functions, no I/O — exits non-zero on any failure.
 */
import { computeAnalysis, downgradeRating, type AnalysisInput, type MarketData } from '../services/token-radar/scoringEngine';
import type { HolderDataResult } from '../services/token-radar/holderData.service';
import type { TokenSecurityDetail } from '../services/sources/goplus.client';
import { analyzeCandles, type HistoricalCandle } from '../services/token-radar/chartIntelligence.service';

const sec = (o: Partial<TokenSecurityDetail>): TokenSecurityDetail => ({
  checked: true, is_honeypot: false, cannot_sell_all: false, buy_tax: 0, sell_tax: 0, is_open_source: true, is_proxy: false,
  mintable: false, freezable: false, has_blacklist: false, hidden_owner: false, can_take_back_ownership: false,
  owner_change_balance: false, selfdestruct: false, holder_count: null, top10_percent: null, creator_percent: null, lp_locked_percent: 90, ...o
});
const holder = (o: Partial<HolderDataResult>): HolderDataResult => ({
  holders: null, top10_percent: null, top20_percent: null, whale_concentration: null, source: 'unknown', confidence: 'low', verified: false, ...o
});
const dex = (o: Partial<MarketData>): MarketData => ({
  liquidity_usd: 450000, volume_24h: 250000, market_cap: 12e6, fdv: 18e6, price_change_h1: 1, price_change_h6: 4, price_change_h24: 8, buys_24h: 600, sells_24h: 400, ...o
});
const input = (o: Partial<AnalysisInput>): AnalysisInput => ({
  dex: dex({}), holder: holder({}), security: sec({}), age_days: 210,
  market: { macro_score: 62, btc_risk: 0.4, leverage_risk: 0.45, alt_season: 55 }, input_type: 'address', ...o
});

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${n}`); };

// downgradeRating monotonicity
check('downgrade: Good → Weak = Weak', downgradeRating('Good Watchlist Candidate', 'Weak Setup') === 'Weak Setup');
check('downgrade: High Risk stays (won\'t upgrade to Weak)', downgradeRating('High Risk / Avoid for Now', 'Weak Setup') === 'High Risk / Avoid for Now');
check('downgrade: Neutral → High Risk = High Risk', downgradeRating('Neutral / Wait for Confirmation', 'High Risk / Avoid for Now') === 'High Risk / Avoid for Now');

// Case 1: DEXScreener low holders, UNVERIFIED, dead volume → NOT auto High Risk
const c1 = computeAnalysis(input({ holder: holder({ holders: 2, top10_percent: 50, source: 'dexscreener', confidence: 'low', verified: false }), dex: dex({ liquidity_usd: 579_110_000, volume_24h: 0.01, market_cap: 1.15e9 }) }));
check('case1: not High Risk (unverified holders)', c1.rating !== 'High Risk / Avoid for Now');
check('case1: at least Weak Setup', ['Weak Setup', 'Neutral / Wait for Confirmation'].includes(c1.rating) === false ? c1.rating === 'Weak Setup' : true);
check('case1: rating is Weak Setup (dead volume)', c1.rating === 'Weak Setup');
check('case1: unverified-holder warning present', c1.warnings.some((w) => w.label === 'Unverified Holder Data'));
check('case1: data-quality mismatch warning present', c1.data_quality_warnings.length > 0);
check('case1: analysis quality reduced (< availability)', c1.confidence.analysis_quality < c1.confidence.data_availability);
check('case1: holder weight tiny (0.03) & not used', c1.holder_meta.weight_used === 0.03 && c1.holder_meta.used_in_final_score === false);
console.log(`   case1 → ${c1.rating} | avail ${c1.confidence.data_availability} quality ${c1.confidence.analysis_quality} combined ${c1.confidence.combined} | action="${c1.action_label}"`);

// Case 2: VERIFIED (etherscan/high) holders=2, health 0 → High Risk
const c2 = computeAnalysis(input({ holder: holder({ holders: 2, top10_percent: 99, source: 'etherscan', confidence: 'high', verified: true }), dex: dex({ liquidity_usd: 579_110_000, volume_24h: 0.01 }) }));
check('case2: verified low holders → High Risk', c2.rating === 'High Risk / Avoid for Now');
check('case2: action = Avoid for now', c2.action_label === 'Avoid for now');

// Case 3: high liquidity, dead activity → data quality warning + ≥ Weak
const c3 = computeAnalysis(input({ dex: dex({ liquidity_usd: 579_110_000, volume_24h: 0.01 }), holder: holder({}) }));
check('case3: data-quality warning', c3.data_quality_warnings.length > 0);
check('case3: downgraded ≥ Weak Setup', ['Weak Setup', 'High Risk / Avoid for Now'].includes(c3.rating));

// Case 4: good liquidity/holders/volume, verified → Good/Strong
const c4 = computeAnalysis(input({ dex: dex({ liquidity_usd: 500_000, volume_24h: 250_000 }), holder: holder({ holders: 12000, top10_percent: 22, source: 'moralis', confidence: 'high', verified: true }), security: sec({}) }));
check('case4: Good or Strong', ['Good Watchlist Candidate', 'Strong Opportunity'].includes(c4.rating));
check('case4: holder weight full (0.15) & used', c4.holder_meta.weight_used === 0.15 && c4.holder_meta.used_in_final_score === true);
console.log(`   case4 → ${c4.rating} | opp ${c4.scores.opportunity}`);

// Case 5: low liquidity → Weak or High Risk
const c5 = computeAnalysis(input({ dex: dex({ liquidity_usd: 3000, volume_24h: 20000 }), holder: holder({ holders: 800, top10_percent: 40, source: 'goplus', confidence: 'medium', verified: true }) }));
check('case5: Weak or High Risk', ['Weak Setup', 'High Risk / Avoid for Now'].includes(c5.rating));

// Case 6: honeypot verified → High Risk
const c6 = computeAnalysis(input({ security: sec({ is_honeypot: true }) }));
check('case6: honeypot → High Risk', c6.rating === 'High Risk / Avoid for Now');

// Case 7: no data at all → Unknown / Insufficient Data
const c7 = computeAnalysis(input({ dex: null, holder: holder({ source: 'unknown' }), security: null }));
check('case7: Unknown / Insufficient Data', c7.rating === 'Unknown / Insufficient Data');
check('case7: opportunity null', c7.scores.opportunity === null);


// Case 8: hostile market regime → rating capped at Neutral + risk bumped
const goodInput = input({ dex: dex({ liquidity_usd: 500_000, volume_24h: 250_000 }), holder: holder({ holders: 12000, top10_percent: 22, source: 'moralis', confidence: 'high', verified: true }) });
const noRegime = computeAnalysis(goodInput);
const hostile = computeAnalysis({ ...goodInput, regime: { env_score: 22, label: 'High-risk market regime', warnings: [] } });
check('case8: hostile regime caps rating at Neutral', hostile.rating === 'Neutral / Wait for Confirmation');
check('case8: hostile regime raises risk', (hostile.scores.risk ?? 0) > (noRegime.scores.risk ?? 0));
check('case8: explanation mentions market regime', hostile.rating_explanation.toLowerCase().includes('market regime'));

// Case 9: supportive regime lifts timing (never upgrades rating beyond its own merit)
const supportive = computeAnalysis({ ...goodInput, regime: { env_score: 80, label: 'Strong altcoin tailwind', warnings: [] } });
check('case9: supportive regime lifts timing', (supportive.scores.timing ?? 0) > (noRegime.scores.timing ?? 0));
check('case9: rating not artificially upgraded past Good/Strong', ['Good Watchlist Candidate', 'Strong Opportunity'].includes(supportive.rating));


// ── Chart Intelligence (pure) ──
const mkCandles = (closes: number[], vol: (i: number) => number | null): HistoricalCandle[] =>
  closes.map((c, idx) => ({ timestamp: new Date(Date.UTC(2026, 0, 1) + idx * 86400000).toISOString(), open: c * 0.99, high: c * 1.02, low: c * 0.98, close: c, volume: vol(idx), source: 'binance' as const }));
const up = Array.from({ length: 120 }, (_, idx) => 1 + idx * 0.01); // steady uptrend
const down = Array.from({ length: 120 }, (_, idx) => 3 - idx * 0.015); // steady downtrend
const btcFlat = Array.from({ length: 120 }, () => 100); // BTC flat → token trend = RS

const bull = analyzeCandles(mkCandles(up, (idx) => 1000 * Math.pow(1.04, idx)), btcFlat, 'binance')!; // vol +~32%/wk → rising
check('chart: uptrend+rising vol → bullish structure', bull.maStructure === 'bullish');
check('chart: uptrend → outperforming BTC', bull.relativeStrengthVsBtc.status === 'outperforming_btc');
check('chart: breakout score high', bull.breakoutScore >= 70);

const bear = analyzeCandles(mkCandles(down, () => 10), btcFlat, 'coingecko')!;
check('chart: downtrend → bearish structure', bear.maStructure === 'bearish');
check('chart: inactive volume warning', bear.warnings.some((w) => w.label === 'Inactive Volume'));
check('chart: underperforming BTC warning', bear.warnings.some((w) => w.label === 'Underperforming BTC'));

check('chart: <7 candles → null (no crash)', analyzeCandles(mkCandles([1, 2, 3], () => 100), btcFlat, 'binance') === null);

// Momentum blend: chart scores lift/depress momentum vs base
const withChart = computeAnalysis({ ...goodInput, chart: { volume_trend_score: 80, relative_strength_score: 85, breakout_score: 80 } });
const noChart = computeAnalysis(goodInput);
check('chart: strong chart lifts momentum', (withChart.scores.momentum ?? 0) > (noChart.scores.momentum ?? 0));
check('chart: missing chart adds low warning', noChart.warnings.some((w) => w.label === 'No Chart History'));


// ── Case 10: BASED — strong momentum on a thin book (Momentum vs Liquidity Mismatch) ──
const based = computeAnalysis(input({
  dex: dex({ liquidity_usd: 14_000, volume_24h: 963, market_cap: 22_640_000, fdv: 44_630_000, price_change_h24: 4, price_change_h6: 2, price_change_h1: 1, buys_24h: 40, sells_24h: 25 }),
  holder: holder({ holders: 3639, top10_percent: 55, source: 'goplus', confidence: 'medium', verified: true }),
  age_days: 75,
  listing_strength: 97,
  market: { macro_score: 35, btc_risk: 0.8, leverage_risk: 0.45, alt_season: 55 }, // hostile backdrop → risk ~72 like the real BASED scan
  chart: { volume_trend_score: 70, relative_strength_score: 95, breakout_score: 80, chart_trend_score: 94, rs_outperforming: true, structure_bullish: true }
}));
check('case10: rating = Neutral (capped, not upgraded)', based.rating === 'Neutral / Wait for Confirmation');
check('case10: mismatch warning present', based.warnings.some((w) => w.label === 'Momentum vs Liquidity Mismatch'));
check('case10: setup type = Momentum-led setup', based.setup_type === 'Momentum-led setup');
check('case10: action = Wait for liquidity confirmation', based.action_label === 'Wait for liquidity confirmation');
check('case10: positives mention outperforming BTC', based.positives.some((x) => x.includes('outperforming BTC')));
check('case10: positives mention bullish structure', based.positives.some((x) => x.includes('above MA20 and MA50')));
check('case10: positives mention strong listings', based.positives.some((x) => x.includes('listing presence is strong')));
check('case10: risk-signal names elevated risk', based.warnings.some((w) => w.label === 'Elevated Risk Score'));
check('case10: risk-signal names thin liquidity', based.warnings.some((w) => w.label === 'Thin Liquidity'));
check('case10: explanation says momentum alone is not enough', based.rating_explanation.includes('not enough to upgrade the setup'));
console.log(`   case10 → ${based.rating} | ${based.setup_type} | action="${based.action_label}" | risk ${based.scores.risk} liq ${based.scores.liquidity} momentum ${based.scores.momentum}`);

// Case 11: very thin book + very low volume → capped at Weak Setup even with great chart
const thin = computeAnalysis(input({
  dex: dex({ liquidity_usd: 4_000, volume_24h: 400, buys_24h: 10, sells_24h: 8 }),
  holder: holder({ holders: 900, top10_percent: 45, source: 'goplus', confidence: 'medium', verified: true }),
  listing_strength: 95,
  chart: { volume_trend_score: 75, relative_strength_score: 90, breakout_score: 85, chart_trend_score: 92, rs_outperforming: true, structure_bullish: true }
}));
check('case11: capped ≤ Weak Setup despite chart 92 + listings 95', ['Weak Setup', 'High Risk / Avoid for Now'].includes(thin.rating));

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '⚠️ FAILURES'} — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
