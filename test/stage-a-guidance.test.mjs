import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';

// Nov 19 Stage A (Herald text only): A1 completed-bar conditions, A2 Herald-scoped cancel clarification,
// A3 range record/anchor wording, A4 option quote routing. The other strategy families must render exactly as before.

const render = strategyId => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId });
const catalyst = render('catalyst-news');
const OTHERS = ['equity-momentum', 'etf-mean-reversion', 'long-premium-volatility', 'default', 'capital-preservation'];
const count = (text, needle) => text.split(needle).length - 1;
const lineOf = (text, start) => text.split('\n').filter(l => l.startsWith(start));

const STAGE_A_PHRASES = [
  '- Completed-bar conditions:',
  'a different reading of the same bars is not a reason to cancel',
  'the range belongs to that session and its window',
  'When a recorded range is available to you',
  'a candidate or one you hold',
  'it reports not found for a contract you do not hold',
];

test('Stage A: each new phrase appears exactly once in Herald and never in another family', () => {
  for (const phrase of STAGE_A_PHRASES) {
    assert.equal(count(catalyst, phrase), 1, phrase);
    for (const other of OTHERS) assert.equal(count(render(other), phrase), 0, `${other}: ${phrase}`);
  }
});

test('A1: one generic completed-bar sentence for confirmation, stop and trail; eligibility and the price-touch target unchanged', () => {
  const [line] = lineOf(catalyst, '- Completed-bar conditions:');
  assert.equal(lineOf(catalyst, '- Completed-bar conditions:').length, 1);
  assert.match(line, /any eligible completed bar since its reference point satisfies it/);
  assert.match(line, /never only the first bar or only the latest bar/);
  assert.match(line, /a later bar on the other side never undoes a trigger that an earlier eligible bar already met/);
  assert.match(line, /start at or after the end of the range window/);
  assert.match(line, /completed after your entry fill/);
  assert.match(line, /This does not change the target, which stays a price touch/);
  assert.match(line, /entering still follows every other rule/);
  // the existing eligibility, target and once-only text is untouched
  assert.match(catalyst, /a bar inside the window never confirms/);
  assert.match(catalyst, /This target exit happens once per position/);
  assert.match(catalyst, /When price reaches it, close half of the broker-confirmed contracts rounded down/);
  assert.doesNotMatch(line, /fresh|age limit|last few|within the last/i); // no freshness constraint (D-S1 option c is not chosen)
});

test('A2: the cancel clarification is Herald only, at the existing sentence; the shared default and every other family are unchanged', () => {
  const cancel = /cancel it unless it still qualifies at the same limit/;
  assert.equal(count(catalyst, 'Review an unfilled opening order at the second heartbeat after submission'), 1);
  assert.match(catalyst, /cancel it unless it still qualifies at the same limit; judge whether it still qualifies with the recorded range and the confirmation rule, and a different reading of the same bars is not a reason to cancel\. Copy order IDs exactly/);
  for (const other of OTHERS) {
    const text = render(other);
    assert.match(text, cancel, other); // the default still cancels unless it qualifies at the same limit
    assert.match(text, /cancel it unless it still qualifies at the same limit\. Copy order IDs exactly/, other);
    assert.doesNotMatch(text, /recorded range and the confirmation rule/, other);
  }
  // no second competing cancel paragraph
  assert.equal(count(catalyst, 'cancel it unless'), 1);
});

test('A3: session anchor for pre-open news, record once, read when available, no silent reset, no promise of persistence', () => {
  assert.match(catalyst, /another article about the same event, or a new anchor article, never restarts it/);
  assert.match(catalyst, /Record the range once per event, the first time you have the complete window, with prophet_log_decision \(the symbol, the session date, the anchor time, the window, the feed, the high, the low and the midpoint\)/);
  assert.match(catalyst, /use it and do not recompute it; when none is, compute it once from exactly the window bars, cite their start times/);
  assert.match(catalyst, /record a correction that cites the bars, and do not rewrite earlier entries/);
  assert.doesNotMatch(catalyst, /store_trade_setup/);
});

test('A4: option prices come from the chain for a candidate or a held contract; a position read is not a quote; get_quote is for stocks', () => {
  const [line] = lineOf(catalyst, '- Option quotes:');
  assert.equal(lineOf(catalyst, '- Option quotes:').length, 1);
  assert.match(line, /a candidate or one you hold, from prophet_get_options_chain for its exact expiry and type/);
  assert.match(line, /gives exposure and a mark, not an executable quote/);
  assert.match(line, /prophet_get_quote is for stocks and ETFs and fails on an option symbol/);
  assert.doesNotMatch(line, /\b\d+ ?(seconds|minutes)\b/); // no second numeric freshness cap
  for (const other of OTHERS) assert.doesNotMatch(render(other), /- Option quotes:/, other);
});

test('prompt hygiene: the added Stage A text has no dates, clock times, prices or symbols', () => {
  const lines = catalyst.split('\n').filter(l => STAGE_A_PHRASES.some(p => l.includes(p)));
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    assert.doesNotMatch(line, /\b20\d\d\b|\b\d{1,2}:\d{2}\b|\$\d|\b[A-Z]{2,5}\d{6}[CP]\d{8}\b/, line.slice(0, 80));
    assert.doesNotMatch(line, /\b(AMD|BA|DIS|NVDA|MRK|XOM|AAPL|SPY)\b/);
  }
});
