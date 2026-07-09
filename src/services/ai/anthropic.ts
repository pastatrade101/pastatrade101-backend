import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';

// Shared Claude client for the AI interpretation layer. Null when no key is
// configured, so every caller degrades gracefully to the deterministic output.
export const AI_MODEL = env.ANTHROPIC_MODEL || 'claude-opus-4-8';
export const anthropic = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
export const aiEnabled = (): boolean => !!anthropic;
