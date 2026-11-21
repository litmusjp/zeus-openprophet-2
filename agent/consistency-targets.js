// Agent consistency release: the exact config targets (texts and fits) that make all eight agents uniform. A pure planner
// turns the live config into the list of edits to apply; the release script applies them one at a time and the tests render the
// result for every agent on every slot. Nothing here talks to a server.
import { stripSavedWorkflow } from './alphadesk-workflow.js';
import { DEFAULT_OPTION_FIT } from './agent-consistency.js';

export const PROPHET_IDENTITY = "You are Prophet, an aggressive options trader who takes swing trades only (no same-session scalps; a paper-trading trial) on a breakout aligned with the higher timeframe, entered after a completed-bar retest holds and momentum resumes. You buy mainly calls, and a put only for a clearly bearish setup, never as a hedge. You cut a failed trade fast and never turn a failed scalp into a swing. Your Strategy Rules define your entries and exits; the Trading Guidance limits your expiries to what AlphaDesk accepts.";
export const PROPHET_UNIVERSE_BLOCK = "### SCAN UNIVERSE (start list; your strategy rules above still decide every entry)\nStart each scan with these 30 liquid ETFs and large caps: SPY QQQ IWM AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO AMD NFLX ORCL CRM JPM BAC GS V MA LLY UNH XOM CAT GE WMT COST HD PLTR UBER. (30 symbols.)\nThis is a starting point, not a limit. After the start list keep looking for other liquid large-cap stocks and broad ETFs with actively traded options that fit your strategy; the number of extra symbols per scan is set in Trading Guidance. Name the extra symbols you checked, and a start-list symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.\nSwings use completed daily bars and the weekly trend; a bar that is still forming never counts. Open no new scalps. Swings use completed daily bars from prophet_get_daily_features (up to 25 symbols per call).\nBefore any single-stock entry call prophet_get_earnings_dates and state any report that falls inside the intended hold; status unknown means unverified, so say so. ETFs have no earnings.\n### END_SCAN_UNIVERSE";
export const PROPHET_PROMPT = `${PROPHET_IDENTITY}\n\n${PROPHET_UNIVERSE_BLOCK}`;
// Prophet's B2 swing-trial rules exactly as they ran before the Nov 21 slot switch, plus the C2 spread sentence for swings.
export const PROPHET_B2_RULES = "- Trade liquid stocks and index ETFs mainly with long calls; use long puts only for clearly bearish setups, never as hedges. Trade swings only (a paper-trading trial): open no new same-session scalps.\n- Choose an expiration beyond the intended hold, 21 to 45 calendar days out, with a delta magnitude of about 0.6 to 0.7.\n- Require a daily breakout aligned with the weekly trend.\n- Enter after a completed-bar retest holds the broken level and momentum resumes; do not assume a close-price fill.\n- Skip conflicting timeframes and choppy action.\n- Exit when the retest fails or the higher-timeframe trend breaks. Take profit at established support/resistance or on exhausted momentum.\n- Exit a swing if no completed daily close moves in the intended direction beyond the recorded underlying entry reference over three completed sessions after entry.";
export const PROPHET_SPREAD_SENTENCE = "- For a swing you may use a same-expiry 1:1 debit vertical in the trade's direction (a bull call spread; a bear put spread only for a clearly bearish setup, never as a hedge) instead of one long option, with the short strike at or near the established support or resistance where you already take profit and your own exits unchanged. Close it as one two-leg order.";
export const PROPHET_RULES = `${PROPHET_B2_RULES}\n${PROPHET_SPREAD_SENTENCE}\n`;

export const GUARDIAN_UNIVERSE_BLOCK = "### SCAN UNIVERSE (start list of liquid large-cap stocks; your strategy rules above still decide every entry)\nStart each scan with these 30 liquid large caps: AAPL MSFT JPM BAC GS WFC MS V MA AXP LLY UNH JNJ MRK ABBV TMO ABT ISRG PG KO PEP COST WMT MCD GE HON RTX LMT UNP T.\nThis is a starting point, not a limit. On every scan, after the start list, keep looking for other liquid large-cap stocks in established uptrends (average daily volume well above 1M shares, actively traded options): sector leaders, names in today's market news, names holding near a rising 20-day average after a pullback. The number of extra symbols per scan is set in Trading Guidance; name every extra symbol you checked.\nBefore any entry call prophet_get_earnings_dates and skip a name whose report falls inside the intended hold; status unknown means unverified, so say so and do not assume there is none.\nUse prophet_get_daily_features (up to 25 symbols per call). A start-list symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.\nAlphaDesk confirms a call only when the latest IEX price is above today's IEX open; a valid rebound below the open will usually fail, so keep it on the WATCHLIST and re-check next heartbeat. This is advice, not an extra rule; AlphaDesk decides.\n### END_SCAN_UNIVERSE";
export const VEGA_UNIVERSE_BLOCK = "### SCAN UNIVERSE (start list; your strategy rules above still decide every entry)\nStart each scan with these 30 liquid names with regular dated events and deep options: AAPL MSFT NVDA AMZN META GOOGL TSLA NFLX AMD AVGO ORCL CRM ADBE JPM BAC GS WMT COST HD NKE DIS BA LLY UNH XOM MU SPY QQQ IWM TLT.\nThis is a starting point, not a limit. After the start list, keep looking for other liquid stocks and broad ETFs with actively traded options and a dated event inside your intended hold; the number of extra symbols per scan is set in Trading Guidance. Find event dates with prophet_get_earnings_dates (status unknown means unverified, so say so); for ETFs, name the scheduled macro release you rely on and how you verified its date.\nUse prophet_get_daily_features (up to 25 symbols per call) and name the extra symbols you checked. A start-list symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.\n### END_SCAN_UNIVERSE";
export const COMPASS_UNIVERSE_BLOCK = "### SCAN UNIVERSE (start list; your strategy rules above still decide every entry)\nStart each scan with these 30 liquid ETFs: XLK XLF XLE XLV XLY XLP XLI XLU XLB XLC XLRE SPY QQQ IWM DIA IWD IWF MTUM QUAL USMV EFA EEM TLT IEF HYG GLD SLV USO SMH XBI.\nThis is a starting point, not a limit. After the start list, keep looking for other broad-market, sector, style, regional, bond or commodity ETFs with high liquidity that fit your strategy; the number of extra symbols per scan is set in Trading Guidance. Single stocks are outside your strategy.\nUse prophet_get_daily_features (up to 25 symbols per call) and name the extra symbols you checked. A start-list symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.\n### END_SCAN_UNIVERSE";
export const ANCHOR_UNIVERSE_BLOCK = "### SCAN UNIVERSE (start list; your strategy rules above still decide every entry)\nStart each scan with these 30 liquid index ETFs and large caps: SPY QQQ IWM DIA VTI AAPL MSFT NVDA AMZN GOOGL META AVGO BRK.B JPM V MA LLY UNH COST WMT HD PG JNJ XOM ORCL CAT GE KO PEP MCD.\nThis is a starting point, not a limit. After the start list, keep looking for other liquid large-cap stocks and broad index ETFs with established multi-month history that fit your strategy; the number of extra symbols per scan is set in Trading Guidance. Avoid erratic, gap-driven names.\nUse prophet_get_daily_features (up to 25 symbols per call) and name the extra symbols you checked. A start-list symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.\n### END_SCAN_UNIVERSE";

export const STRATEGY_FITS = DEFAULT_OPTION_FIT;

const CORRUPTED_DASH = '1\u00e2\u20ac\u201c10';

const withBlock = (identity, block) => `${identity.trim()}\n\n${block}`;
const hasBlock = prompt => /^### (SCAN|CATALYST) UNIVERSE\b/m.test(String(prompt || ''));

/**
 * The edits that make the eight agents consistent, computed from the live config. Pure: no I/O.
 *  - agentPrompts: agent id -> { customSystemPrompt, systemPromptTemplate? } to PUT on the agent definition
 *  - strategyEdits: strategy id -> { customRules?, optionStructures } to PUT on the strategy
 *  - slotClears: slot id -> override keys to null (the slot then runs its agent's definition and strategy)
 *  - permissions: slot id -> { allowedStructures } to PUT (only L2 narrows to its agent's fit)
 */
export function planConsistencyEdits({ agents, strategies, slots, perms }) {
  const agent = id => agents.find(a => a.id === id);
  const strategy = id => strategies.find(s => s.id === id);
  const plan = { agentPrompts: {}, strategyEdits: {}, slotClears: {}, permissions: {} };

  // Herald: the slot copy is what runs today; fold its text into the definition and strategy, then empty the slot.
  const l1 = slots.sbx_723be98b?.agent?.overrides || {};
  if (typeof l1.customSystemPrompt === 'string' && l1.customSystemPrompt.trim()) {
    plan.agentPrompts.catalyst = { customSystemPrompt: stripSavedWorkflow(l1.customSystemPrompt) };
  } else {
    plan.agentPrompts.catalyst = { customSystemPrompt: stripSavedWorkflow(agent('catalyst').customSystemPrompt) };
  }
  plan.strategyEdits['catalyst-news'] = { customRules: typeof l1.customStrategyRules === 'string' && l1.customStrategyRules.trim() ? l1.customStrategyRules : strategy('catalyst-news').customRules };
  plan.slotClears.sbx_723be98b = ['customSystemPrompt', 'customStrategyRules', 'systemPromptTemplate', 'description'];

  // Pendulum: the saved workflow copy goes (the code renders it).
  plan.agentPrompts['mean-reversion'] = { customSystemPrompt: stripSavedWorkflow(agent('mean-reversion').customSystemPrompt) };

  // Prophet: restore identity, start list and the B2 swing rules; the template must be custom for the text to render.
  plan.agentPrompts.default = { customSystemPrompt: PROPHET_PROMPT, systemPromptTemplate: 'custom' };
  plan.strategyEdits.default = { customRules: PROPHET_RULES };

  // Start lists for the agents that have none.
  for (const [id, block] of [['conservative', GUARDIAN_UNIVERSE_BLOCK], ['long-vol', VEGA_UNIVERSE_BLOCK], ['macro-rotation', COMPASS_UNIVERSE_BLOCK], ['trend-follower', ANCHOR_UNIVERSE_BLOCK]]) {
    const current = agent(id).customSystemPrompt || '';
    if (!hasBlock(current)) plan.agentPrompts[id] = { customSystemPrompt: withBlock(current, block) };
  }

  // Every strategy carries its option fit; the ETF rules lose the corrupted dash.
  for (const s of strategies) {
    const fit = STRATEGY_FITS[s.id];
    if (fit) plan.strategyEdits[s.id] = { ...(plan.strategyEdits[s.id] || {}), optionStructures: [...fit] };
  }
  const etf = strategy('etf-mean-reversion');
  if (etf && etf.customRules.includes(CORRUPTED_DASH)) {
    plan.strategyEdits['etf-mean-reversion'] = { ...(plan.strategyEdits['etf-mean-reversion'] || {}), customRules: etf.customRules.split(CORRUPTED_DASH).join('1-10') };
  }

  // L2 (Pendulum) allows only what its strategy fits.
  const l2 = perms.sbx_956ff9e4;
  const l2Fit = STRATEGY_FITS['etf-mean-reversion'];
  const same = l2 && l2.allowedStructures.length === l2Fit.length && l2Fit.every(n => l2.allowedStructures.includes(n));
  if (!same) plan.permissions.sbx_956ff9e4 = { allowedStructures: [...l2Fit] };
  return plan;
}
