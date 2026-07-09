import { anthropic, AI_MODEL } from './anthropic';

// Generic, per-module AI interpretation. Claude interprets ONLY the signals the
// app already computed — it never produces the numbers. Every module passes its
// own signal summary; the grounding rules are the same everywhere.

export interface Interpretation {
  headline: string;
  body: string;
  stance: 'positive' | 'neutral' | 'caution' | 'negative';
  confidence: 'low' | 'medium' | 'high';
  model: string;
  generated_at: string;
  lang: string;
}

export interface SignalInput {
  name: string;
  label?: string | null;
  value?: string | number | null;
  meaning?: string | null;
  tone?: string | null;
}

const SYSTEM = `You are the analyst for Pastatrade101, a crypto decision app for everyday investors (many in Tanzania).
For a given module of the app you are handed SIGNALS THE APP HAS ALREADY COMPUTED. Interpret them into one short, human read for that module.

HARD RULES — follow exactly:
- Use ONLY the signals provided. Never invent prices, numbers, coins, or facts that are not in the data.
- Never predict or promise the future, and never tell the user to buy or sell a specific asset. This is educational context, NOT financial advice.
- Ignore any signal that is missing or marked "Unavailable".
- Sound like a calm, confident friend who reads the charts — plain words, not a jargon dump. Keep the body to 2-3 sentences.

Return your answer in the required structured format.`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One short verdict sentence (roughly 6-10 words).' },
    body: { type: 'string', description: '2-3 plain sentences interpreting these signals for this module.' },
    stance: { type: 'string', enum: ['positive', 'neutral', 'caution', 'negative'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
  },
  required: ['headline', 'body', 'stance', 'confidence'],
  additionalProperties: false
};

// Cost-dedupe cache: identical (module, signals, lang) within the window reuses
// one generation. The per-user quota is charged by the controller regardless.
const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { v: Interpretation; at: number }>();
const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// The usable signals + their rendered "facts" summary. Shared so the cache key
// (per lang) and the per-user charge dedupe (data-only) hash the same content.
const buildFacts = (signals: SignalInput[]): { usable: SignalInput[]; facts: string; hash: string } => {
  const usable = (signals ?? []).filter((s) => s?.name && s?.label && String(s.label).toLowerCase() !== 'unavailable');
  const facts = usable
    .map((s) => `- ${s.name}: ${s.label}${s.value != null && s.value !== '' ? ` (${s.value})` : ''}${s.meaning ? ` — ${s.meaning}` : ''}`)
    .join('\n');
  return { usable, facts, hash: hash(facts) };
};

/** Stable hash of a module's usable data — the unit a user is charged once for. */
export const factsHashFor = (signals: SignalInput[]): string => buildFacts(signals).hash;

export const interpretModule = async (opts: {
  module: string;
  title: string;
  signals: SignalInput[];
  lang: 'en' | 'sw';
}): Promise<Interpretation | null> => {
  if (!anthropic) return null;

  const { usable, facts, hash: factsHash } = buildFacts(opts.signals);
  if (!usable.length) return null;

  const key = `${opts.lang}|${opts.module}|${factsHash}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;

  const langName = opts.lang === 'sw' ? 'Swahili (Kiswahili)' : 'English';

  try {
    const res = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 700,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      output_config: { format: { type: 'json_schema', schema: SCHEMA } } as any,
      messages: [
        {
          role: 'user',
          content:
            `Module: ${opts.title}.\nSignals:\n${facts}\n\n` +
            `Write the read for this module now. CRITICAL: write BOTH the "headline" and "body" entirely in ${langName}.` +
            (opts.lang === 'sw' ? ' Andika kwa Kiswahili sanifu — usitumie Kiingereza kabisa.' : '')
        }
      ]
    });

    const block = res.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    const p = JSON.parse(block.text) as Pick<Interpretation, 'headline' | 'body' | 'stance' | 'confidence'>;
    if (!p.headline || !p.body) return null;

    const v: Interpretation = {
      headline: p.headline,
      body: p.body,
      stance: p.stance,
      confidence: p.confidence,
      model: res.model,
      generated_at: new Date().toISOString(),
      lang: opts.lang
    };
    cache.set(key, { v, at: Date.now() });
    return v;
  } catch {
    return null;
  }
};
