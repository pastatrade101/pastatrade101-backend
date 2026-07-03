/**
 * Token Position Radar — scoring-engine tests (v2).
 * Run:  npx tsx src/scripts/test-token-radar-scoring.ts
 * Pure functions, no I/O — exits non-zero on any failure.
 */
import { computeAnalysis, downgradeRating, type AnalysisInput, type MarketData } from '../services/token-radar/scoringEngine';
import type { HolderDataResult } from '../services/token-radar/holderData.service';
import type { TokenSecurityDetail } from '../services/sources/goplus.client';

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

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '⚠️ FAILURES'} — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
