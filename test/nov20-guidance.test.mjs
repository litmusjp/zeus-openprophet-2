import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';

// Nov 20 build, text items C1 (anchor), C2 (exit and re-entry references) and C3 (reducing-order pricing). Herald only.
const render = id => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: id });
const count = (text, phrase) => text.split(phrase).length - 1;
const herald = render('catalyst-news');
const OTHERS = ['equity-momentum', 'etf-mean-reversion', 'long-premium-volatility', 'default', 'capital-preservation', 'unknown-x'];

// The text each item adds. Each phrase must appear exactly once in the Herald guidance and never in any other family.
const NEW = {
  C1_session_open_utc: 'the start is the session open for overnight or pre-open news (session_open_utc from get_datetime;',
  C1_session_close_utc: 'the end is the actual session close (session_close_utc from get_datetime; early-close days end earlier)',
  C1_utc_fields_only: 'Take the open and the close in UTC only from those two get_datetime fields and never work a UTC time out from any other field.',
  C1_range_recorded: 'with prophet_log_decision using action RANGE_RECORDED',
  C1_two_facts: 'the event publication time and the effective window start as two separate facts',
  C1_same_anchor: 'reuse that recorded range, with the same anchor, for every later entry and stop on the same event',
  C1_earlier_publication: 'An earlier verified publication time that you find later wins only through an explicit correction that cites the article and the bars; the earlier record is not rewritten.',
  C1_event_identity: 'counts as a new event only if it cites a distinct verified publication; otherwise it is the same event and the re-entering rule applies.',
  C1_tool_anchor_used: 'Its answer states anchor_requested and anchor_used: record and reuse anchor_used as the window start.',
  C1_uncovered_date: 'When it refuses a date it cannot cover (an earlier session), use the range already recorded for that event and do not recompute it.',
  C2_stop_exact_fill: 'The bar must have completed after the broker-confirmed entry fill of that exact contract (take the fill time from the filled order or the position of that contract, never from another contract or from a plan)',
  C2_stop_same_heartbeat: 'with the fill time, using bars fetched in the same heartbeat.',
  C2_reentry_exit_fill: 'starts after the exit fill of that exact contract (read from the filled order of that contract, never from another contract or from a plan)',
  C3_reducing_order: 'A reducing order of yours (a take-profit exit) has its own test: it is stale once it is still unfilled at the second heartbeat after submission, and only then:',
  C3_stop_not_held: 'A stop or invalidation exit is never held for this review.',
};

test('C1/C2/C3: each new instruction appears exactly once in the Herald guidance and in no other family', () => {
  for (const [name, phrase] of Object.entries(NEW)) {
    assert.equal(count(herald, phrase), 1, name);
    for (const id of OTHERS) assert.equal(count(render(id), phrase), 0, `${id}: ${name}`);
  }
});

test('C1: no instruction to turn a New York wall-clock string into a UTC time remains', () => {
  assert.doesNotMatch(herald, /session_open_et|session_close_et/);
  assert.doesNotMatch(herald, /as UTC|\bET to UTC|offset/i);
});

test('C1/C2/C3 added text carries no dates, times of day, tickers or seasonal wording', () => {
  const added = Object.values(NEW).join(' ');
  assert.doesNotMatch(added, /\b20\d\d\b|\b\d{1,2}:\d{2}\b|\b(NVDA|AMZN|JPM|DIS|WMT|CRM|UNH|AAPL|SPY)\b/);
  assert.doesNotMatch(added, /summer|winter|daylight|standard time/i);
  assert.doesNotMatch(added, /(EDT|EST)/);
  assert.doesNotMatch(herald, /\b(summer|winter|daylight|standard time|EDT|EST)\b/i);
});

test('C2: the existing stop, target and re-entry semantics are kept, not replaced', () => {
  // stop: the bar END is compared with the fill; a bar in progress at the fill that completes later can trigger
  assert.match(herald, /compare the bar's end time \(a bar is stamped with its start, so its end is the start plus 5 minutes\) with the fill time/);
  assert.match(herald, /a bar that was in progress at your fill and completes after it can/);
  assert.match(herald, /A bar that had already completed before your fill, and any bar inside the range window, never triggers the stop/);
  assert.match(herald, /a later bar on the other side never undoes a trigger that an earlier eligible bar already met/);
  // target: a price touch, once per position
  assert.match(herald, /This does not change the target, which stays a price touch/);
  assert.match(herald, /This target exit happens once per position/);
  // re-entry: a confirming bar that STARTS after the exit, and a reconciled predecessor
  assert.match(herald, /completed-bar confirmation that starts after the exit fill of that exact contract/);
  assert.match(herald, /an earlier position that is fully reconciled \(no remaining quantity and no active, planned or uncertain order\)/);
  // never a blanket start-after-fill rule for stops or targets
  assert.doesNotMatch(herald, /bars? (that )?start(s|ing)? after (the|your) (entry )?fill/i);
  assert.doesNotMatch(herald, /(stop|target)[^.]{0,80}start(s|ing)? after (the|your) (entry )?fill/i);
});

test('C3: Herald-only conditional at the shared pricing owner, no cancel-every-beat wording', () => {
  assert.match(herald, /The second-heartbeat review above applies to opening orders only\. A reducing order of yours/);
  for (const id of OTHERS) {
    const text = render(id);
    assert.doesNotMatch(text, /A reducing order of yours/, id);
    if (text.includes('Option cost discipline')) assert.equal(count(text, 'The second-heartbeat review above applies to opening orders only.'), 1, id);
  }
  assert.doesNotMatch(herald, /each (beat|heartbeat)[^.]{0,60}cancel|cancel[^.]{0,60}(every|each) (beat|heartbeat)/i);
  // the existing replacement safety is still named in the pricing line
  assert.match(herald, /confirm the cancel is terminal and read its cumulative filled quantity; a replacement covers only the verified remaining quantity/);
  assert.match(herald, /to take profit, start at the mid and reprice on a later heartbeat/);
  assert.match(herald, /reconcile the held quantity and every other working exit, then reprice only the remaining unreserved quantity/);
});

test('every other family preview is byte-identical to the previous release', () => {
  for (const id of OTHERS) {
    const before = fs.readFileSync(new URL(`./fixtures/nov20-preview-${id}.txt`, import.meta.url), 'utf8');
    assert.equal(render(id), before, id);
  }
});
