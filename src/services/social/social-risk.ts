// Pure Social Risk scoring (v2). Combines Google Trends + Fear & Greed +
// Wikipedia + YouTube into a 0–1 social-attention risk (high attention/hype =
// higher risk). Reweights over whatever is active; future sources (X/Twitter,
// Reddit, Telegram/Discord) are status-only.

export interface SocialInputs {
  trends_bitcoin: number | null; // 0–100
  trends_bitcoin_price: number | null; // 0–100
  fear_greed: number | null; // 0–100
  wikipedia_risk: number | null; // 0–1 (combined, normalized)
  youtube_attention: number | null; // 0–1
  leverage_euphoria?: number | null; // 0–1 (derivatives leverage risk overlay)
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Combine the two scored Trends keywords (Bitcoin weighted higher) into one risk.
const trendsRisk = (bitcoin: number | null, price: number | null): number | null => {
  const parts = [
    { w: 0.6, v: bitcoin == null ? null : bitcoin / 100 },
    { w: 0.4, v: price == null ? null : price / 100 }
  ].filter((p) => p.v != null) as { w: number; v: number }[];
  if (!parts.length) return null;
  const tot = parts.reduce((s, p) => s + p.w, 0);
  return clamp01(parts.reduce((s, p) => s + p.w * p.v, 0) / tot);
};

export const socialLabel = (score: number): string => {
  if (score < 0.2) return 'Very low attention';
  if (score < 0.4) return 'Quiet / accumulation-friendly';
  if (score < 0.6) return 'Normal attention';
  if (score < 0.8) return 'Elevated attention';
  return 'Hype / overheated attention';
};

const trendsMeaning = (v: number): string =>
  v < 25
    ? 'Search interest is low. Public attention is quiet, which supports accumulation.'
    : v < 50
      ? 'Search interest is normal. Public attention is not yet in hype territory.'
      : v < 75
        ? 'Search interest is elevated. Retail attention may be increasing.'
        : 'Search interest is high. Retail hype risk is rising.';

export const metricMeaning = (key: string, value: number | null): string => {
  if (value == null) return 'Data unavailable.';
  if (key === 'fear_greed')
    return value < 40 ? 'Sentiment remains fearful, which lowers social risk.' : value < 60 ? 'Sentiment is balanced.' : 'Greed is rising, which adds social risk.';
  if (key.startsWith('wikipedia')) return 'Public curiosity vs recent history; spikes during high-price periods add risk.';
  if (key.startsWith('youtube'))
    return value < 40 ? 'Crypto video activity is quiet.' : value < 70 ? 'Crypto video activity is elevated but not extreme.' : 'Crypto video activity is high — possible hype.';
  if (key.startsWith('leverage'))
    return value < 0.4 ? 'Futures leverage is calm — little crowding.' : value < 0.6 ? 'Futures leverage is moderate.' : 'Futures leverage is elevated — crowding/euphoria building.';
  return trendsMeaning(value); // google_trends_*
};

export type SourceStatus = Record<string, string>;

export interface SocialResult {
  score: number | null;
  label: string;
  coverage_status: string;
  interpretation: string;
  source_status: SourceStatus;
}

/**
 * Social Risk Score — crowd-attention first. Base weights 30% Fear & Greed ·
 * 25% Google Trends · 20% YouTube · 15% Wikipedia · 10% Leverage Euphoria,
 * reweighted proportionally over whatever is active. Leverage Euphoria is a
 * crowding overlay: it only counts when at least one attention source is present
 * (never stands alone) and is capped at 10% so it can't dominate.
 */
export const computeSocialRisk = (i: SocialInputs): SocialResult => {
  const tRisk = trendsRisk(i.trends_bitcoin, i.trends_bitcoin_price);
  const fgRisk = i.fear_greed == null ? null : clamp01(i.fear_greed / 100);

  // Attention sources represent crowd interest (the core of Social Risk).
  const attention = [
    { name: 'Fear & Greed', w: 0.3, v: fgRisk },
    { name: 'Google Trends', w: 0.25, v: tRisk },
    { name: 'YouTube', w: 0.2, v: i.youtube_attention },
    { name: 'Wikipedia', w: 0.15, v: i.wikipedia_risk }
  ].filter((p) => p.v != null) as { name: string; w: number; v: number }[];

  // Leverage euphoria only joins when there's at least one attention source —
  // it sharpens crowding detection but must never be the sole driver.
  const levOn = attention.length > 0 && i.leverage_euphoria != null;
  const components = [...attention];
  if (levOn) components.push({ name: 'Leverage Euphoria', w: 0.1, v: i.leverage_euphoria as number });

  const has = {
    trends: tRisk != null,
    wikipedia: i.wikipedia_risk != null,
    fear_greed: fgRisk != null,
    youtube: i.youtube_attention != null,
    leverage: levOn
  };

  const source_status: SourceStatus = {
    fear_greed: has.fear_greed ? 'Active' : 'Unavailable',
    google_trends: has.trends ? 'Active' : 'Pending official API access',
    youtube: has.youtube ? 'Active' : 'Unavailable',
    wikipedia: has.wikipedia ? 'Active' : 'Unavailable',
    leverage_euphoria: levOn ? 'Active' : i.leverage_euphoria != null ? 'Idle (needs attention data)' : 'Unavailable'
  };

  const active = components.map((c) => c.name);
  const missing = ['Fear & Greed', 'Google Trends', 'YouTube', 'Wikipedia'].filter((n) => !active.includes(n));
  const coverage_status =
    !components.length
      ? 'Social metrics unavailable.'
      : missing.length === 0
        ? `Social metrics are fully active. Current score uses ${active.join(', ')}.`
        : `Social metrics are partially active. Current score uses ${active.join(', ')}. ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} unavailable.`;

  if (!components.length) {
    return { score: null, label: 'Unavailable', coverage_status, interpretation: 'No social data available yet.', source_status };
  }

  const totW = components.reduce((s, c) => s + c.w, 0);
  const score = clamp01(components.reduce((s, c) => s + c.w * c.v, 0) / totW);

  const interpretation =
    score < 0.4
      ? 'Social attention remains low-to-normal. Bitcoin is not in a strong retail-hype phase, which supports a lower overall risk reading.'
      : score < 0.6
        ? 'Social attention is rising but not extreme — this may suggest renewed interest rather than full retail hype.'
        : 'Social attention is elevated. Trends, YouTube activity and sentiment show rising retail interest; if price risk is also elevated, this increases overall market risk.';

  return { score: Number(score.toFixed(3)), label: socialLabel(score), coverage_status, interpretation, source_status };
};
