// Phase C2: what an agent is told about two-leg debit verticals. The text is applied to the assembled system prompt ONLY when the
// sandbox permission `allowedStructures` lists a debit vertical; for every other sandbox the assembled system prompt is
// byte-identical to before. The agent's own Strategy Rules still decide WHEN a vertical is used; this module only supplies the
// shared HOW and removes the sentences that would otherwise tell the agent spreads are impossible or price a spread like one leg.

export const DEBIT_VERTICAL_STRUCTURES = ['bull_call_debit', 'bear_put_debit'];

export function debitVerticalsAllowed(allowedStructures) {
  if (!Array.isArray(allowedStructures)) return [];
  return DEBIT_VERTICAL_STRUCTURES.filter(name => allowedStructures.includes(name));
}

const STRUCTURE_LABELS = { bull_call_debit: 'bull call debit', bear_put_debit: 'bear put debit' };

// Each pair is [text in the assembled prompt today, replacement]. A pair whose text is not present is skipped here; the offline
// tests assert that every pair applies to the rendered prompts, and applyDebitVerticalText still adds the mechanics block when
// its usual anchor is missing (see below), so a wording drift can never leave a spread-enabled prompt without the recipe.
export const SPREAD_TEXT_REPLACEMENTS = [
  [
    'For an eligible unchanged single-leg proposal, prefer one guarded `prophet_place_options_order` call;',
    'For an eligible unchanged proposal (one single leg, or one two-leg debit vertical where your Strategy Rules allow it), prefer one guarded `prophet_place_options_order` call;',
  ],
  [
    'Assessment currently supports long calls, long puts, and same-expiry 1:1 directional debit verticals. Agent execution is single-leg only; never claim an unsupported spread was executed.',
    'Assessment supports long calls, long puts, and same-expiry 1:1 directional debit verticals. You may place a two-leg debit vertical only where your Strategy Rules allow it and your permissions list it (see Debit vertical mechanics); no other multi-leg shape is placed. Never claim a spread was executed unless the tool returns it filled.',
  ],
  [
    "verify the same OCC contract's timestamped bid, ask and sizes.",
    "verify the same OCC contract's timestamped bid, ask and sizes (for a two-leg vertical, each leg's).",
  ],
  [
    'Use `prophet_place_options_order` for a single OCC option symbol. Its agent schema is single-leg only. Do not construct a spread through sequential single-leg orders; backend atomic multi-leg support is not exposed by this tool.',
    'Use `prophet_place_options_order` for one OCC option symbol or, with `legs`, for one atomic two-leg debit vertical (see Debit vertical mechanics). Never construct a spread through sequential single-leg orders.',
  ],
  [
    "measured on AlphaDesk's own quote of that exact contract, is above",
    "measured on AlphaDesk's own quote of that exact contract (for a two-leg order, of its widest leg), is above",
  ],
  // The single-contract pricing owner: a vertical is priced on its net quote, including the first invalidation exit.
  [
    'Start an entry limit at the mid and never above the ask.',
    'Start an entry limit at the mid and never above the ask (a two-leg vertical: its net mid and net ask, defined in Debit vertical mechanics).',
  ],
  [
    'use a marketable limit at or just below the current bid of the same contract; to take profit, start at the mid and reprice on a later heartbeat.',
    'use a marketable limit at or just below the current bid of the same contract (a two-leg vertical: at or just below its net bid, defined in Debit vertical mechanics, read in the same beat); to take profit, start at the mid (a vertical: its net mid) and reprice on a later heartbeat.',
  ],
  // The heartbeat policy-facts line ("... quote of the exact contract, is above N%") is rendered per beat by
  // renderAlphaDeskPolicyFacts(facts, { twoLeg }), not here.
];

const ANCHOR = '- Use `prophet_place_options_order` for one OCC option symbol or, with `legs`';

export function debitVerticalMechanics(structures) {
  const names = structures.map(name => STRUCTURE_LABELS[name]).join(' and ');
  return [
    `- Debit vertical mechanics (your permissions allow: ${names}). Use a vertical only when your Strategy Rules say you may; otherwise place single-leg orders as above.`,
    ' A vertical is one same-expiry 1:1 order. A bull call spread buys the lower-strike call and sells the higher-strike call; a bear put spread buys the higher-strike put and sells the lower-strike put.',
    ' Every vertical order uses `prophet_place_options_order` with `legs` (exactly two; each has symbol, side, position_intent and the positive quote price you used) and order_type limit. The top-level symbol, side and position_intent always repeat the FIRST leg you list. quantity counts spread units, and the 1-10 cap counts units (10 units are 20 leg contracts). Use one client_order_id for any assessment and the order. A retry keeps the identical legs, quantity and limit; a retry without `legs` is refused, never sent as a single leg.',
    ' OPENING (only): list the long leg first. Its side is buy and its position_intent is buy_to_open, so the top-level fields are the long leg with buy / buy_to_open; the second leg sells the other strike with sell_to_open. limit_price is the positive net debit per unit.',
    ' CLOSING (only): reverse both legs. List the formerly long leg first with sell / sell_to_close, then the formerly short leg with buy / buy_to_close, and repeat the first leg at the top level (sell / sell_to_close). limit_price is the positive net credit per unit and quantity is the remaining units. Never reuse the opening buy / buy_to_open fields for a close.',
    ' Net quotes, from each leg\'s timestamped bid and ask read in the same beat: net bid = long bid minus short ask; net ask = long ask minus short bid; net mid = long mid minus short mid. An entry starts at the net mid and never goes above the net ask. A due invalidation or stop exit uses a marketable limit at or just below the net bid. A target exit starts at the net mid and is repriced on a later heartbeat. Your existing exit triggers, second-heartbeat review of an unfilled order, immediate handling of a due stop and once-only target allocation are unchanged; a replacement still waits for a terminal cancel, the cumulative filled quantity and the remaining unreserved units, and without fresh quotes for both legs you do not submit.',
    ' The entry spread cap is judged on each leg and the widest leg counts, so choose a short strike whose own spread fits.',
    ' Size on the same sizing basis as a single option, measured on the spread\'s maximum loss (net debit x units x 100), never on the long leg alone; a vertical buys more units for the same amount, so the 10-unit cap may bind first, and then the cap wins.',
    ' Keep your stops, targets and time exits on the underlying exactly as for a single option. If your strategy or recorded plan calls for taking half off, close half the units in one two-leg order, rounded down; at 1 unit your own rule decides between closing all and holding.',
    ' Never leg out with separate orders (a single-leg close of a grouped leg is refused). A planned_for_next_session retry uses identical legs. Close a spread before its expiry session when the short leg is in the money; assignment handling is a backstop, not a plan.',
    ' After a fill call `prophet_get_option_groups`: a group marked broken blocks new spreads for this sandbox until it is resolved; the remaining leg is then managed under your own rules, and you never trade assigned stock yourself. Never promise a fill.',
  ].join('');
}

/**
 * Applies the spread text to an assembled system prompt. A no-op (same string) when no debit vertical is allowed. The mechanics
 * block follows the order-tool line; if that line's wording ever changes, the block is appended instead, never dropped.
 */
export function applyDebitVerticalText(prompt, allowedStructures) {
  const structures = debitVerticalsAllowed(allowedStructures);
  if (!structures.length || typeof prompt !== 'string') return prompt;
  let out = prompt;
  for (const [from, to] of SPREAD_TEXT_REPLACEMENTS) out = out.split(from).join(to);
  const block = debitVerticalMechanics(structures);
  const anchor = out.indexOf(ANCHOR);
  if (anchor < 0) return `${out}\n\n${block}`;
  const lineEnd = out.indexOf('\n', anchor);
  const insertAt = lineEnd < 0 ? out.length : lineEnd;
  return `${out.slice(0, insertAt)}\n${block}${out.slice(insertAt)}`;
}
