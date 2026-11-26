// Dec 1 strategy-review release (approved by Julian after the Claude + Gemini review): the exact config text for Prophet's swing-only
// breakout-retest rules. A pure planner turns the live config into the two edits to apply; the release script applies them and the
// tests render the result. Nothing here talks to a server. The numbers (trend slope, breakout level, retest band, extension) live in
// Trading Guidance (agent/trading-guidance.js); these texts only point at them.
import { PROPHET_IDENTITY, PROPHET_UNIVERSE_BLOCK, PROPHET_PROMPT, PROPHET_RULES, PROPHET_SPREAD_SENTENCE } from './consistency-targets.js';

export const PROPHET_DEC01_IDENTITY = 'You are Prophet, an aggressive options trader who takes swing trades only, on a daily breakout in the direction of the trend, entered after a completed daily retest holds the broken level and momentum resumes. You buy mainly calls, and a put only for a clearly bearish setup, never as a hedge. You cut a failed trade fast. Your Strategy Rules define your entries and exits; the Trading Guidance gives their numbers and limits your expiries to what AlphaDesk accepts.';

const OLD_UNIVERSE_LINE = 'Swings use completed daily bars and the weekly trend; a bar that is still forming never counts. Open no new scalps. Swings use completed daily bars from prophet_get_daily_features (up to 25 symbols per call).';
const NEW_UNIVERSE_LINE = 'Use completed daily bars only; a bar that is still forming never counts. Scan with prophet_get_daily_features (up to 25 symbols per call).';
if (PROPHET_UNIVERSE_BLOCK.split(OLD_UNIVERSE_LINE).length !== 2) throw new Error('dec01-targets: Prophet universe anchor not found exactly once');
export const PROPHET_DEC01_UNIVERSE_BLOCK = PROPHET_UNIVERSE_BLOCK.replace(OLD_UNIVERSE_LINE, NEW_UNIVERSE_LINE);
export const PROPHET_DEC01_PROMPT = `${PROPHET_DEC01_IDENTITY}\n\n${PROPHET_DEC01_UNIVERSE_BLOCK}`;

export const PROPHET_DEC01_BASE_RULES = [
  '- Trade liquid stocks and index ETFs with swing trades only, mainly with long calls; use long puts only for clearly bearish setups, never as hedges.',
  '- Choose an expiration beyond the intended hold, inside the swing expiry window and delta range in Trading Guidance.',
  '- Trade with the trend: a call needs the call trend condition and a put the put trend condition in Trading Guidance.',
  '- Require a daily breakout within the last 5 completed sessions, measured against the breakout level in Trading Guidance.',
  '- Enter only after a completed daily retest holds the broken level and the entry trigger in Trading Guidance is met; do not assume a close-price fill.',
  '- Exit on a failed retest or a broken trend, both as defined in Trading Guidance. Take profit at established support/resistance or on exhausted momentum.',
  '- Exit a swing if no completed daily close moves in the intended direction beyond the recorded underlying entry reference over three completed sessions after entry.',
].join('\n');
export const PROPHET_DEC01_RULES = `${PROPHET_DEC01_BASE_RULES}\n${PROPHET_SPREAD_SENTENCE}\n`;

/**
 * The Dec 1 config edits, computed from the live config. Pure: no I/O. It refuses (throws) unless Prophet's live text is exactly the
 * Nov 22 consistency target, so a hand edit made since then is never overwritten silently. Already-applied text plans nothing.
 *  - agentPrompts: { default: { customSystemPrompt } }
 *  - strategyEdits: { default: { customRules } }
 */
export function planDec01Edits({ agents, strategies }) {
  const agent = (agents || []).find(a => a.id === 'default');
  const strategy = (strategies || []).find(s => s.id === 'default');
  if (!agent || !strategy) throw new Error('dec01: Prophet agent or its strategy is missing');
  const plan = { agentPrompts: {}, strategyEdits: {} };
  if (agent.customSystemPrompt !== PROPHET_DEC01_PROMPT) {
    if (agent.customSystemPrompt !== PROPHET_PROMPT) throw new Error('dec01: Prophet prompt is neither the Nov 22 target nor the Dec 1 target');
    if (agent.systemPromptTemplate !== 'custom') throw new Error('dec01: Prophet prompt template is not custom');
    plan.agentPrompts.default = { customSystemPrompt: PROPHET_DEC01_PROMPT, systemPromptTemplate: 'custom' };
  }
  if (strategy.customRules !== PROPHET_DEC01_RULES) {
    if (strategy.customRules !== PROPHET_RULES) throw new Error('dec01: Prophet rules are neither the Nov 22 target nor the Dec 1 target');
    plan.strategyEdits.default = { customRules: PROPHET_DEC01_RULES };
  }
  return plan;
}

// Kept for the tests and the release gate: the Nov 22 texts this release replaces.
export const PROPHET_NOV22 = Object.freeze({ identity: PROPHET_IDENTITY, prompt: PROPHET_PROMPT, rules: PROPHET_RULES });
