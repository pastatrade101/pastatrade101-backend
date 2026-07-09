import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';

// Premium AI "Market Today" synthesis. Claude does NOT compute anything — it only
// interprets the signals the app already computed into one short, human read.
// The deterministic rule-based verdict remains the source of truth and fallback:
// any failure (no key, error, thin data) returns null and the UI uses the rule read.

export interface MarketRead {
  headline: string;
  body: string;
  stance: 'risk_on' | 'neutral' | 'cautious' | 'risk_off';
  confidence: 'low' | 'medium' | 'high';
  model: string;
  generated_at: string;
  lang: string;
}

interface Signal {
  name: string;
  label: string;
  value: string | null;
  meaning: string;
  tone: string;
}
type Signals = Record<string, Signal>;
interface MarketConditionLike {
  label?: string | null;
  reason?: string | null;
}

const MODEL = env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

// The signals only change when a new sync runs, so we generate ONE synthesis per
// (snapshot, language) and serve it to every user — cost is per-sync, not per-user.
// TTL is a safety cap in case a snapshot never changes.
const TTL_MS = 3 * 60 * 60 * 1000;
const cache = new Map<string, { read: MarketRead; at: number }>();

const SYSTEM = `You are the market analyst for Pastatrade101, a crypto decision app for everyday investors (many in Tanzania).
You are given SIGNALS THAT THE APP HAS ALREADY COMPUTED. Your only job is to interpret them into one short, human "market today" read.

HARD RULES — follow exactly:
- Use ONLY the signals provided. Never invent prices, percentages, coins, or numbers that are not in the data.
- Never predict or promise the future. Describe the CURRENT conditions the signals show.
- Ignore any signal whose label is "Unavailable".
- This is educational market context, NOT financial advice. Never tell the user to buy or sell a specific asset.
- Sound like a calm, confident friend who reads the charts — plain words, not a jargon dump. Keep the body to 2-3 sentences.

Return your answer in the required structured format.`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One short verdict sentence (roughly 6-10 words).' },
    body: { type: 'string', description: '2-3 plain sentences interpreting the signals together.' },
    stance: { type: 'string', enum: ['risk_on', 'neutral', 'cautious', 'risk_off'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
  },
  required: ['headline', 'body', 'stance', 'confidence'],
  additionalProperties: false
};

const snapshotOf = (signals: Signals, mc: MarketConditionLike): string =>
  JSON.stringify({
    c: mc?.label ?? null,
    s: Object.values(signals).map((s) => `${s.name}:${s.label}:${s.value ?? ''}:${s.tone}`)
  });

export const aiMarketReadEnabled = (): boolean => !!client;

export const generateMarketRead = async (
  signals: Signals,
  marketCondition: MarketConditionLike,
  lang: 'en' | 'sw' = 'en'
): Promise<MarketRead | null> => {
  if (!client) return null; // no key → deterministic fallback

  const usable = Object.values(signals ?? {}).filter((s) => s?.label && s.label !== 'Unavailable');
  if (usable.length < 2) return null; // not enough live data to synthesise

  const key = `${lang}|${snapshotOf(signals, marketCondition)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.read;

  const langLine = lang === 'sw' ? 'Write everything in clear, natural Swahili (Kiswahili).' : 'Write everything in clear English.';

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: [{ type: 'text', text: `${SYSTEM}\n\n${langLine}`, cache_control: { type: 'ephemeral' } }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      output_config: { format: { type: 'json_schema', schema: SCHEMA } } as any,
      messages: [
        {
          role: 'user',
          content:
            `Overall market condition (from the app): ${marketCondition?.label ?? 'Unknown'}.\n` +
            `Signals:\n` +
            usable.map((s) => `- ${s.name}: ${s.label}${s.value ? ` (${s.value})` : ''} — ${s.meaning}`).join('\n') +
            `\n\nWrite the market-today read now.`
        }
      ]
    });

    const block = res.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    const parsed = JSON.parse(block.text) as Pick<MarketRead, 'headline' | 'body' | 'stance' | 'confidence'>;
    if (!parsed.headline || !parsed.body) return null;

    const read: MarketRead = {
      headline: parsed.headline,
      body: parsed.body,
      stance: parsed.stance,
      confidence: parsed.confidence,
      model: res.model,
      generated_at: new Date().toISOString(),
      lang
    };
    cache.set(key, { read, at: Date.now() });
    return read;
  } catch {
    return null; // any failure → deterministic fallback
  }
};
