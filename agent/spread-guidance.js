// Phase C2: what an agent is told about two-leg debit verticals. The text is applied to the assembled system prompt ONLY when the
// sandbox permission `allowedStructures` lists a debit vertical; for every other sandbox the prompt is byte-identical to before.
// The agent's own Strategy Rules still decide WHEN a vertical is used; this module only supplies the shared HOW and removes the
// sentences that would otherwise tell the agent spreads are impossible.

export const DEBIT_VERTICAL_STRUCTURES = ['bull_call_debit', 'bear_put_debit'];

export function debitVerticalsAllowed(allowedStructures) {
  if (!Array.isArray(allowedStructures)) return [];
  return DEBIT_VERTICAL_STRUCTURES.filter(name => allowedStructures.includes(name));
}

const STRUCTURE_LABELS = { bull_call_debit: 'bull call debit', bear_put_debit: 'bear put debit' };

// Each pair is [text in the assembled prompt today, replacement]. A pair whose text is not present is skipped (the test suite
// asserts that every pair applies to the prompts of the three running agents, so a wording change cannot silently drop one).
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
  // The heartbeat policy-facts line ("... quote of the exact contract, is above N%") is rendered per beat by
  // renderAlphaDeskPolicyFacts(facts, { twoLeg }), not here.
];

export function debitVerticalMechanics(structures) {
  const names = structures.map(name => STRUCTURE_LABELS[name]).join(' and ');
  return [
    `- Debit vertical mechanics (your permissions allow: ${names}). Use a vertical only when your Strategy Rules say you may; otherwise place single-leg orders as above.`,
    ' A vertical is one same-expiry 1:1 order. A bull call spread buys the lower-strike call and sells the higher-strike call; a bear put spread buys the higher-strike put and sells the lower-strike put.',
    ' Submit it with `prophet_place_options_order` using `legs` (exactly two; each has symbol, side, position_intent and the positive quote price you used) and repeat the first leg in the top-level symbol, side and position_intent (put the long leg first: buy, buy_to_open). Use order_type limit; limit_price is the positive net debit per unit; quantity counts spread units, and the 1-10 cap counts units (10 units are 20 leg contracts).',
    ' Use one client_order_id for any assessment and the order. A retry keeps the identical legs, quantity and limit; a retry without `legs` is refused, never sent as a single leg.',
    ' Read each leg\'s timestamped bid, ask and sizes from the chain. The net mid is the long leg\'s mid minus the short leg\'s mid; start the limit at the net mid and never above the net ask. The entry spread cap is judged on each leg and the widest leg counts, so choose a short strike whose own spread fits.',
    ' Size on the same sizing basis as a single option, measured on the spread\'s maximum loss (net debit x units x 100), never on the long leg alone; a vertical buys more units for the same amount, so the 10-unit cap may bind first, and then the cap wins.',
    ' Keep your stops, targets and time exits on the underlying exactly as for a single option.',
    ' Exits: close a spread only with one two-leg closing order (sell the long leg, buy back the short leg; limit_price is the positive net credit per unit); never leg out with separate orders (a single-leg close of a grouped leg is refused). A partial target means closing half the units in one two-leg order, rounded down; at 1 unit your own rule decides between closing all and holding. After a terminal cancel, reprice on the net bid of both legs read in the same beat. A planned_for_next_session retry uses identical legs. Close a spread before its expiry session when the short leg is in the money; assignment handling is a backstop, not a plan.',
    ' After a fill call `prophet_get_option_groups`: a group marked broken blocks new spreads for this sandbox until it is resolved; the remaining leg is then managed under your own rules, and you never trade assigned stock yourself. Never promise a fill.',
  ].join('');
}

/** Applies the spread text to an assembled system prompt. A no-op (same string) when no debit vertical is allowed. */
export function applyDebitVerticalText(prompt, allowedStructures) {
  const structures = debitVerticalsAllowed(allowedStructures);
  if (!structures.length || typeof prompt !== 'string') return prompt;
  let out = prompt;
  for (const [from, to] of SPREAD_TEXT_REPLACEMENTS) out = out.split(from).join(to);
  const anchor = out.indexOf('- Use `prophet_place_options_order` for one OCC option symbol or, with `legs`');
  if (anchor < 0) return out;
  const lineEnd = out.indexOf('\n', anchor);
  const insertAt = lineEnd < 0 ? out.length : lineEnd;
  return `${out.slice(0, insertAt)}\n${debitVerticalMechanics(structures)}${out.slice(insertAt)}`;
}
