// One shared MARKET-OPEN ALPHADESK WORKFLOW for every agent whose slot allows options (agent consistency release).
// The saved prompt of an agent no longer carries this block: buildSystemPrompt strips any saved copy and renders this one,
// so every options agent runs identical wording and the copies can never drift. The text is Herald's live L1 workflow
// (single-leg wording); the three sentences that mention a two-leg vertical are applied by spread-guidance.js
// (SPREAD_TEXT_REPLACEMENTS) only when the slot permission lists a debit vertical.

export const WORKFLOW_START = '### MARKET-OPEN ALPHADESK WORKFLOW';
export const WORKFLOW_END = '### END_MARKET_OPEN_ALPHADESK_WORKFLOW';

export const ALPHADESK_WORKFLOW_BLOCK = [
  "### MARKET-OPEN ALPHADESK WORKFLOW",
  "Before the open: prepare a small ranked shortlist using confirmed news and completed historical data. Record underlying, direction, candidate expiry, budget and exit plan. Label it research only—not submitted. Do not place new options orders before the broker clock confirms the market is open.",
  "At the open: reconcile options positions, active broker orders, planned intents and uncertain submissions. Refresh current price action and exact option-contract bid, ask, sizes and timestamps. Reuse useful research; do not restart everything from scratch.",
  "Select an exact eligible single-leg proposal within available account capacity and existing controls. Read current managed policy and OP2 confirmation; if either is ON or unknown, do not submit. Generate one stable client_order_id and submit this exact OCC contract, side='buy', the exact proposed quantity, and proposed positive limit premium once through prophet_place_options_order, which independently assesses at the broker boundary. Use the same client_order_id for this intent. The first submission is not a retry. A standalone assessment is optional research only and is not a prerequisite to this guarded call. If an optional standalone assessment has already been made, its first submission must occur before that receipt's op2_effective_expires_at; on a direct guarded call the backend obtains and enforces fresh assessment expiry.",
  "AlphaDesk obtains its own evidence and score. Indicative/testing-only data is admissible for this paper-advisory workflow. Missing chain open interest is unknown, not zero; latest-trade size is not daily volume.",
  "Read decision, signal_score, checks and blocking_reasons. Score alone is not approval. On FAIL, address the genuine failed criteria or research another candidate. On UNAVAILABLE, report or recheck the specific problem; never turn a missing score into zero.",
  "After the guarded order call, read its actual assessment and broker result. Only a genuine PASS for the unchanged proposal can proceed, and you never make a second submission of the same intent. If the guarded call reports an explicit pre-broker assessment block (FAIL or UNAVAILABLE, execution_confirmed false, nothing submitted to the broker) and complete reconciliation of active, planned and uncertain orders shows no live, planned or uncertain predecessor, a later heartbeat may freshly re-evaluate the opportunity. If it still qualifies and the cause is resolved, create a distinct new intent with a new client_order_id through the same guarded path, with fresh evidence and all current controls. If the predecessor's state is unknown, pending, broker-visible or uncertain, reconcile it and never replace its ID to try again. After FAIL, address the actual failed checks with a newly qualified proposal or move on; never alter price or quantity cosmetically to get past a check. Never trade merely to obtain a PASS. If any proposal field changes, requalify it. Discard stale assistant approval narratives. Never blindly retry uncertainty or sequence spread legs. OP2 performs its own final checks.",
  "Verify and manage: confirm the broker result and fill. Never blindly retry an uncertain submission. Close the same contract with sell_to_close for the broker-reconciled remaining quantity, following the documented exit plan, and verify the outcome. Option exits are periodic agent-managed market/limit closes; they are not broker-held stops/OCO and do not provide guaranteed instantaneous protection.",
  "",
  "### END_MARKET_OPEN_ALPHADESK_WORKFLOW",
].join('\n');

// Single-leg wording -> two-leg wording (applied to the assembled prompt when a debit vertical is allowed).
export const WORKFLOW_SPREAD_PAIRS = [
  [
    "Select an exact eligible single-leg proposal within available account capacity and existing controls.",
    "Select an exact eligible proposal within available account capacity and existing controls: one single-leg order, or, where your Strategy Rules and permissions allow it, one two-leg debit vertical."
  ],
  [
    "submit this exact OCC contract, side='buy', the exact proposed quantity, and proposed positive limit premium once",
    "submit this exact OCC contract (for a vertical, the exact legs), side='buy' for a single long option, the exact proposed quantity (spread units for a vertical) and the proposed positive limit (the net debit for a vertical) once"
  ],
  [
    "Close the same contract with sell_to_close for the broker-reconciled remaining quantity, following the documented exit plan, and verify the outcome.",
    "Close a single option with sell_to_close for the broker-reconciled remaining quantity, and a spread with one two-leg closing order for its remaining units, following the documented exit plan, and verify the outcome."
  ]
];


/** Removes any saved workflow block from a saved prompt and tidies the blank lines around the gap. */
export function stripSavedWorkflow(prompt) {
  const text = String(prompt || '');
  const start = text.indexOf(WORKFLOW_START);
  const end = text.indexOf(WORKFLOW_END);
  if (start < 0 || end < start) return text;
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end + WORKFLOW_END.length).trim();
  return before && after ? `${before}\n\n${after}` : (before || after);
}

/** Places the workflow after the identity's first paragraph (the saved layout: identity, workflow, start list, rest). */
export function placeWorkflow(identityWithoutWorkflow) {
  const text = String(identityWithoutWorkflow || '').trim();
  if (!text) return ALPHADESK_WORKFLOW_BLOCK;
  const gap = text.indexOf('\n\n');
  if (gap < 0) return `${text}\n\n${ALPHADESK_WORKFLOW_BLOCK}`;
  const first = text.slice(0, gap);
  const rest = text.slice(gap).replace(/^\s+/, '');
  return rest ? `${first}\n\n${ALPHADESK_WORKFLOW_BLOCK}\n\n${rest}` : `${first}\n\n${ALPHADESK_WORKFLOW_BLOCK}`;
}
