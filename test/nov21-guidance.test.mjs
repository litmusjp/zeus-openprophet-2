import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';

// Nov 21 build, text items H1 (target spent), H2 (reuse the recorded range) and H3 (every exit each pass). Herald only.
const render = id => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: id });
const count = (text, phrase) => text.split(phrase).length - 1;
const herald = render('catalyst-news');
const OTHERS = ['equity-momentum', 'etf-mean-reversion', 'long-premium-volatility', 'default', 'capital-preservation', 'unknown-x'];

const NEW = {
  H1_read_history: 'Before you place any target order, read this position\'s own history since its entry fill',
  H1_pointer: 'point to the broker-confirmed cumulative target fills',
  H1_spent: 'When the cumulative filled quantity already equals the allocation, the target is spent and you place no target order',
  H1_reserved: 'a working or uncertain target order still reserves the allocation',
  H1_complete_once: 'you may complete only the unfilled, unreserved part, once',
  H1_new_position: 'A later new position in the same contract has its own allocation.',
  H2_no_earlier_call: 'do not call it for an earlier session at all: reuse the recorded range, anchor and bars.',
  H2_current_session_allowed: 'Reading the current session again with the recorded anchor, for a confirmation, stop or re-entry check, is allowed and never re-records or changes the range; call it to record a range only when none has been recorded yet.',
  H2_missing_record: 'If a position you hold has no recorded range, say so in your decision; never estimate one or recompute it from a later session.',
  H2_once_per_event: 'Record RANGE_RECORDED once per event and cite it on later passes.',
  H3_every_exit: 'At each evaluation of a position you hold, list every exit that your Strategy Rules and the recorded plan define for it',
  H3_own_rule: 'test each one with its own rule as written; the timing or bar rule of one exit never changes the rule of another exit.',
};

test('H1/H2/H3: each new instruction appears exactly once in the Herald guidance and in no other family', () => {
  for (const [name, phrase] of Object.entries(NEW)) {
    assert.equal(count(herald, phrase), 1, name);
    for (const id of OTHERS) assert.equal(count(render(id), phrase), 0, `${id}: ${name}`);
  }
});

test('H1: target-spent is keyed to the position lifecycle and the broker fills, not to the contract forever', () => {
  assert.match(herald, /this position's own history since its entry fill/);
  assert.match(herald, /A later new position in the same contract has its own allocation\./);
  assert.doesNotMatch(herald, /never (?:place|create) (?:a|any) target (?:order )?(?:on|for) (?:this|the same) contract again/i);
});

test('H1: the existing once-per-position allocation rules are all still present', () => {
  assert.match(herald, /This target exit happens once per position/);
  assert.match(herald, /A placed target order reserves that allocation but is not a confirmed fill/);
  assert.match(herald, /you never create a second target allocation/);
  assert.match(herald, /After the first target exit, a later touch of the target never closes the remainder/);
});

test('H2: the earlier-session refusal sentence and the recorded-range reuse both remain', () => {
  assert.match(herald, /When it refuses a date it cannot cover \(an earlier session\), use the range already recorded for that event and do not recompute it\./);
  assert.equal(count(herald, 'RANGE_RECORDED'), 3, 'one record instruction, one reuse instruction, one once-per-event instruction');
});

test('H2: the prohibition covers earlier-session recomputation only; fresh current-session reads with the recorded anchor stay allowed', () => {
  assert.match(herald, /do not call it for an earlier session at all/);
  assert.match(herald, /Reading the current session again with the recorded anchor, for a confirmation, stop or re-entry check, is allowed and never re-records or changes the range/);
  assert.doesNotMatch(herald, /do not call (?:it|prophet_get_range_confirmation) (?:again|at all)\b(?! for an earlier)/i, 'no blanket ban on the helper');
  assert.match(herald, /returns the range and every completed bar after the window with its volume baseline and whether it confirms/);
});

test('H3: each exit keeps its own predicate (stop END after the fill, target touch, re-entry START, time exit)', () => {
  assert.match(herald, /compare the bar's end time \(a bar is stamped with its start, so its end is the start plus 5 minutes\) with the fill time/);
  assert.match(herald, /This does not change the target, which stays a price touch/);
  assert.match(herald, /starts after the exit fill of that exact contract/);
  assert.match(herald, /Close-time exit: an exit is due by the close only when/);
});

test('H1-H3 add no number and no new tool name to the Herald guidance', () => {
  for (const phrase of Object.values(NEW)) {
    assert.doesNotMatch(phrase, /\d/, phrase);
    assert.doesNotMatch(phrase, /prophet_[a-z_]+/, phrase);
  }
});
