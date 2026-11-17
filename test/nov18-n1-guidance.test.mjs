import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';

// Nov 18 N1: instruction-text tests for the catalyst (Herald) family. They check the wording of
// the Trading Guidance (the only thing N1 changes), plus a literal reference calculation of the
// written range rule on the saved opening bars, so the wording cannot drift from the arithmetic.

const render = strategyId => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId });
const catalyst = render('catalyst-news');
const count = (text, needle) => text.split(needle).length - 1;

const NEW_PHRASES = [
  'The window is exactly the completed bars whose start time falls from the session open',
  'Record the range once per event with prophet_log_decision',
  'the confirming bar must start at or after the end of the range window, and a bar inside the window never confirms',
  '- Re-entering an event:',
  'for a call the wrong side is below the level, for a put it is above the level',
  'The bar must have completed after your entry fill',
  'A placed target order reserves that allocation but is not a confirmed fill',
  '- Close-time exit:',
  '- Option quotes:',
];

test('each new instruction appears exactly once, in the catalyst family only', () => {
  for (const phrase of NEW_PHRASES) {
    assert.equal(count(catalyst, phrase), 1, phrase);
    for (const other of ['equity-momentum', 'etf-mean-reversion', 'long-premium-volatility', 'default', 'capital-preservation']) {
      assert.equal(count(render(other), phrase), 0, `${other}: ${phrase}`);
    }
  }
});

test('N1-a range: window is defined by bar start times, validated, recorded once per event, corrected openly', () => {
  assert.match(catalyst, /a bar that starts at the end of the window is not part of the range/);
  assert.match(catalyst, /Check that every bar of the window is present, complete and from the same feed before you use the range/);
  assert.match(catalyst, /the anchor time, the window, the feed, the high, the low and the midpoint/);
  assert.match(catalyst, /reuse that recorded range for every later entry and stop on the same event/);
  assert.match(catalyst, /record a correction that cites the bars, and do not rewrite earlier entries/);
  assert.doesNotMatch(catalyst, /store_trade_setup/); // that tool is for completed trades, not an open event
});

// NOTE: this arithmetic test uses local constants; it documents the written rule, and the wording assertions above are what pin the rendered text.
test('N1-a reference calculation: the saved three opening bars give one range, and the 4th bar and the in-window close cannot confirm', () => {
  const bars = [ // start, high, low, close (the saved opening bars of one catalyst day; completed, one feed)
    // The first three rows are the saved opening bars; the 14:45 row is ADAPTED scaffolding (only its low, 497.96, is the saved value).
    ['14:30', 511.43, 504.62, 504.62], ['14:35', 509.31, 503.81, 507.83], ['14:40', 510.8, 500.71, 501.2], ['14:45', 506.0, 497.96, 499.0],
  ];
  // Herald's saved settings (not the repo defaults): a 15-minute range, stop at 0.5 of the range, target 3 x the range height.
  const windowMinutes = 15; const fraction = 0.5; const targetMultiple = 3;
  const open = 14 * 60 + 30;
  const minutes = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const inWindow = bars.filter(b => minutes(b[0]) >= open && minutes(b[0]) < open + windowMinutes);
  assert.equal(inWindow.length, windowMinutes / 5); // every bar of the window is present
  const high = Math.max(...inWindow.map(b => b[1])); const low = Math.min(...inWindow.map(b => b[2]));
  assert.deepEqual([low, high], [500.71, 511.43]);
  assert.equal(Number((low + fraction * (high - low)).toFixed(2)), 506.07); // put stop level (midpoint at 0.5)
  assert.equal(Number((low - targetMultiple * (high - low)).toFixed(2)), 468.55); // put target
  const confirms = b => minutes(b[0]) >= open + windowMinutes && b[3] < low; // a put confirms below the low, after the window
  assert.equal(confirms(bars[2]), false); // the 14:40 close (501.20) is inside the window: never a confirmation
  assert.equal(inWindow.some(b => b[0] === '14:45'), false); // the 14:45 bar's low (497.96) is not part of the range
});

test('N1-b target: once per position, quantity at first touch, a pending order reserves the allocation', () => {
  assert.match(catalyst, /based on the quantity held when the target is first reached \(not on the quantity left after a partial exit\)/);
  assert.match(catalyst, /a position that was a single contract at that moment closes in full/);
  assert.match(catalyst, /Record that quantity and the order id when you place the target exit/);
  assert.match(catalyst, /if it is cancelled without a fill you may complete the unfilled part of the same allocation, and you never create a second target allocation/);
  assert.match(catalyst, /After the first target exit, a later touch of the target never closes the remainder; only the trail, the stop, invalidating news or a due close-time exit do/);
});

test('N1-c stop: direction by side, post-entry bar only, cited; other exits unaffected', () => {
  assert.match(catalyst, /for a call the wrong side is below the level, for a put it is above the level/);
  assert.match(catalyst, /The bar must have completed after your entry fill: compare the bar's end time \(a bar is stamped with its start, so its end is the start plus 5 minutes\) with the fill time/);
  assert.doesNotMatch(catalyst, /compare its start time with the fill time/); // the start-vs-fill predicate was a contradiction
  assert.match(catalyst, /A bar that had already completed before your fill, and any bar inside the range window, never triggers the stop; a bar that was in progress at your fill and completes after it can/);
  assert.match(catalyst, /Cite the bar's start time, its close, the level and the feed when you exit on the stop/);
  assert.match(catalyst, /Target, time and invalidating-news exits are separate and are not affected by this/);
});

test('N1-c reference: a stop bar is eligible on its COMPLETION after the fill (fill inside a bar, wholly pre-entry bar, formation bar; put and call mirror)', () => {
  const minutes = (h, m, s = 0) => h * 60 + m + s / 60;
  const BAR = 5; const windowEnd = minutes(14, 45); const fill = minutes(15, 22, 30);
  // Written rule: eligible only if the bar completed after the fill (start + 5 minutes > fill) and is not inside the range window.
  const eligible = (start, fillTime = fill) => start + BAR > fillTime && start >= windowEnd;
  const wrongSide = (side, close, level) => (side === 'put' ? close > level : close < level);
  const stops = (side, start, close, level) => eligible(start) && wrongSide(side, close, level);
  assert.equal(stops('put', minutes(15, 20), 506.5, 506.07), true);   // fill inside the 15:20 bar: it completes at 15:25, after the fill
  assert.equal(stops('call', minutes(15, 20), 505.0, 506.07), true);  // mirror for a call
  assert.equal(stops('put', minutes(15, 15), 506.5, 506.07), false);  // wholly pre-entry (completed 15:20, before the fill)
  assert.equal(stops('put', minutes(14, 40), 506.5, 506.07), false); // formation-window bar
  assert.equal(stops('put', minutes(15, 25), 504.0, 506.07), false);  // post-entry bar but the right side for a put: no stop
  // The contradictory predicate would wrongly suppress the straddling bar:
  const startAfterFill = start => start > fill;
  assert.equal(startAfterFill(minutes(15, 20)), false);
});

test('N1-d close-time exit: only when due, 30-minute window, catch-up, reconciliation, no invented price', () => {
  assert.match(catalyst, /an exit is due by the close only when the reaction has failed to develop or your recorded plan says to exit by the close; a working position may be held overnight/);
  assert.match(catalyst, /first regular-session evaluation with 30 minutes or less to the close \(minutes_to_close from get_datetime, which follows early closes\), or at once if you are already inside that window/);
  assert.match(catalyst, /A stop or invalidation that is already due is acted on at the next evaluation as usual and is never delayed to this window/);
  assert.match(catalyst, /Reconcile the broker orders and the confirmed quantity first/);
  assert.match(catalyst, /cancel it, wait until the broker shows it terminal, read its cumulative fills, then sell only the remaining broker-confirmed quantity at a fresh exact-contract quote/);
  assert.match(catalyst, /record DATA_BLOCK; never invent a price, never duplicate an order, and never leave a due exit to an evaluation after the close/);
  assert.doesNotMatch(catalyst, /close every position|flatten/i); // no unconditional end-of-session flatten
});

test('N1-e quotes: option quotes come from the chain; a position read is not a quote; the stock tool is for stocks', () => {
  assert.match(catalyst, /from prophet_get_options_chain for its exact expiry and type/);
  assert.match(catalyst, /A position read \(prophet_get_options_position\) gives exposure and a mark, not an executable quote/);
  assert.match(catalyst, /prophet_get_quote is for stocks and ETFs, not for option symbols/);
});

test('N1-f re-entry (D-R1 b): needs its own post-exit confirmation, the recorded range and a reconciled predecessor', () => {
  assert.match(catalyst, /a later entry on the same event needs its own completed-bar confirmation that starts after your exit/);
  assert.match(catalyst, /an earlier position that is fully reconciled \(no remaining quantity and no active, planned or uncertain order\)/);
  assert.doesNotMatch(catalyst, /no new entry on that event for the rest/i); // the session-long ban is not the chosen behaviour
});

test('prompt hygiene: the added text has no dates, clock times, prices or symbols', () => {
  const lines = catalyst.split('\n').filter(l => NEW_PHRASES.some(p => l.includes(p)) || l.startsWith('- Target') || l.startsWith('- Stop'));
  for (const line of lines) {
    assert.doesNotMatch(line, /\b20\d\d\b|\b\d{1,2}:\d{2}\b|\$\d|\b[A-Z]{2,5}\d{6}[CP]\d{8}\b/, line.slice(0, 80));
    assert.doesNotMatch(line, /\b(AMD|BA|DIS|XOM|AAPL|SPY)\b/);
  }
});
