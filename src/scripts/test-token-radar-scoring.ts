/**
 * Token Position Radar — scoring-engine tests.
 * Run:  npx tsx src/scripts/test-token-radar-scoring.ts
 * Pure functions, no I/O — exits non-zero on any failure (CI-friendly).
 */
import { computeScores, ratingFor, type ScoringInput } from '../services/token-radar/scoringEngine';
import type { TokenSecurityDetail } from '../services/sources/goplus.client';

const sec = (o: Partial<TokenSecurityDetail>): TokenSecurityDetail => ({
  checked: true, is_honeypot: false, cannot_sell_all: false, buy_tax: 0, sell_tax: 0,
  is_open_source: true, is_proxy: false, mintable: false, freezable: false, has_blacklist: false,
  hidden_owner: false, can_take_back_ownership: false, owner_change_balance: false, selfdestruct: false,
  holder_count: 5000, top10_percent: 25, creator_percent: 3, lp_locked_percent: 90, ...o
});
const base = (o: Partial<ScoringInput>): ScoringInput => ({
  liquidity_usd: 450000, volume_24h: 900000, market_cap: 12e6, fdv: 18e6,
  price_change_h1: 1, price_change_h6: 5, price_change_h24: 12, buys_24h: 800, sells_24h: 500,
  age_days: 210, security: sec({}), market: { macro_score: 62, btc_risk: 0.4, leverage_risk: 0.45, alt_season: 55 },
  input_type: 'address', ...o
});

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}`);
};

const g = computeScores(base({}), true);
check('healthy: opportunity 55-90', g.scores.opportunity >= 55 && g.scores.opportunity <= 90);
check('healthy: no severe risk', g.severe.length === 0);
check('healthy: contract_safety >= 70', (g.scores.contract_safety ?? 0) >= 70);

const h = computeScores(base({ security: sec({ is_honeypot: true }) }), true);
check('honeypot: rating = High Risk / Avoid for Now', h.rating === 'High Risk / Avoid for Now');
check('honeypot: risk >= 70', h.scores.risk >= 70);
check('honeypot: contract_safety = 0', h.scores.contract_safety === 0);

const w = computeScores(base({ liquidity_usd: 4000, volume_24h: 100, age_days: 3, security: sec({ holder_count: 60, top10_percent: 88, lp_locked_percent: 5, is_open_source: false }) }), true);
check('weak: severe risk detected', w.severe.length > 0);
check('weak: risk >= 60', w.scores.risk >= 60);

const u = computeScores(base({ security: { checked: false } as TokenSecurityDetail }), true);
check('unknown contract: contract_safety null (no crash)', u.scores.contract_safety === null);
check('unknown contract: confidence lower than full', u.scores.confidence < g.scores.confidence);

check('band: 82 → Strong Opportunity', ratingFor(82, []) === 'Strong Opportunity');
check('band: 70 → Good Watchlist Candidate', ratingFor(70, []) === 'Good Watchlist Candidate');
check('band: 55 → Neutral / Wait for Confirmation', ratingFor(55, []) === 'Neutral / Wait for Confirmation');
check('band: 40 → Weak Setup', ratingFor(40, []) === 'Weak Setup');
check('band: 20 → High Risk / Avoid for Now', ratingFor(20, []) === 'High Risk / Avoid for Now');
check('band: severe overrides a high opportunity', ratingFor(95, ['x']) === 'High Risk / Avoid for Now');

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '⚠️ FAILURES'} — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
