import { clamp01to100 } from './technicals';

export interface EcosystemScoreInput {
  tvlChange30d: number | null;
  stablecoinInflowPct: number | null; // % change in stablecoin mcap on the chain (proxy for inflow)
  dexVolumeChange7d: number | null;
  feesChange: number | null;
  nativeToken30d: number | null;
  topTokens30d: number | null; // avg 30d return of top mapped tokens
}

// A percentage change → 0–100 sub-score centred on 50 (flat). +50% ≈ 100, −50% ≈ 0.
const growthScore = (changePct: number | null, fallback = 50): number =>
  changePct === null ? fallback : clamp01to100(50 + changePct);

export const ecosystemSignal = (score: number): string => {
  if (score < 35) return 'Weak';
  if (score < 50) return 'Neutral';
  if (score < 65) return 'Improving';
  if (score < 80) return 'Strong';
  if (score < 92) return 'Hot';
  return 'Overheated';
};

export const computeEcosystemScore = (input: EcosystemScoreInput): { score: number; signal: string } => {
  const score = Math.round(
    growthScore(input.tvlChange30d) * 0.25 +
      growthScore(input.stablecoinInflowPct) * 0.2 +
      growthScore(input.dexVolumeChange7d) * 0.2 +
      growthScore(input.feesChange) * 0.15 +
      growthScore(input.nativeToken30d) * 0.1 +
      growthScore(input.topTokens30d) * 0.1
  );

  return { score, signal: ecosystemSignal(score) };
};
