import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatStore, classifyFailures } from '../agent/chat-store.js';
import { getRangeConfirmation } from '../range-confirmation.js';

// D1 (Nov 20 build): only the structured, correctly scoped session_not_covered range refusal is a warning. Everything else stays essential.
const WARNING = 'get_range_confirmation date outside the calendar coverage';
const NOW = Date.parse('2026-11-18T15:00:00Z');
const CAL = async () => ({ sessions: [{ date: '2026-11-18', open: '09:30', close: '16:00' }, { date: '2026-11-19', open: '09:30', close: '16:00' }] });
const PRIOR = { symbol: 'DIS', window_start: '2026-11-17T14:30:00Z', window_minutes: 15 };

// The real tool output (what mcp-server.js hands back for this refusal), stored the way the harness stores a failed tool call.
const realPayload = async (args = PRIOR) => getRangeConfirmation(args, { fetchBars: async () => { throw new Error('no read expected'); }, fetchCalendar: CAL, now: NOW });
const record = (payload, over = {}, args = PRIOR) => ({
  kind: 'tool_call', tool: 'prophet_get_range_confirmation', args, status: 'error',
  error: typeof payload === 'string' ? payload : JSON.stringify(payload), ...over,
});
const wrapped = (payload, over = {}, args = PRIOR) => ({
  kind: 'tool_call', tool: 'get_range_confirmation', args, status: 'completed',
  result: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true }), ...over,
});

test('D1 (+): the real session_not_covered answer is a warning, in every stored shape', async () => {
  const payload = await realPayload();
  assert.equal(payload.status, 'session_not_covered');
  for (const rec of [record(payload), wrapped(payload), record(payload, { result: JSON.stringify(payload) })]) {
    const { essential, warnings } = classifyFailures([rec]);
    assert.equal(essential.length, 0);
    assert.deepEqual(warnings, [WARNING]);
  }
});

test('D1 (-): every other refusal, failure and look-alike stays essential', async () => {
  const good = await realPayload();
  const text = message => record(message); // plain prose, not structured evidence
  const cases = {
    'calendar unavailable (plain text)': text('the broker market calendar is unavailable, so the session bounds cannot be verified (503)'),
    'authentication failure': text('Trading bot request failed: {"status":401,"category":"authentication"}'),
    'transport failure': text('Trading bot request failed: {"category":"transport_error","retryable":true}'),
    'timeout': text('UnknownError: The operation timed out.'),
    'invalid input text': text('window_start must be a real RFC3339 UTC timestamp ending in Z'),
    'future input text': text('window_start 2026-11-18T20:00:00Z is in the future (current UTC 2026-11-18T15:00:00Z)'),
    'no session on a date (holiday)': text('the broker market calendar has no regular session on 2026-11-18 (a weekend or a market holiday), so the range cannot be computed'),
    'truncated payload': record(JSON.stringify(good).slice(0, 80)),
    'malformed payload (a required key missing)': record({ ...good, coverage_end: undefined }),
    'same words under another status': record({ ...good, status: 'invalid_input' }),
    'same words, no status': record({ error: good.message }),
    'a contradictory error key in the same payload': record({ ...good, error: 'the broker market calendar is unavailable' }),
    'an extra key': record({ ...good, retryable: true }),
    'a date inside the coverage': record({ ...good, requested_date: '2026-11-18' }, {}, { ...PRIOR, window_start: '2026-11-18T14:30:00Z' }),
    'requested date different from the request': record({ ...good, requested_date: '2026-11-16' }),
    'coverage reversed': record({ ...good, coverage_start: '2026-11-19', coverage_end: '2026-11-18' }),
    'a date that is not a date': record({ ...good, requested_date: 'yesterday' }),
    'no message': record({ ...good, message: '' }),
    'wrong reason': record({ ...good, reason: 'calendar_unavailable' }),
    'request args missing': { ...record(good), args: undefined },
    'request window_start malformed': record(good, {}, { ...PRIOR, window_start: '2026-11-17T14:30:00' }),
    'two payloads in one answer': record(`[${JSON.stringify(good)},${JSON.stringify(good)}]`),
    'prose beside the payload': record(`${JSON.stringify(good)} please retry`),
    'a different tool with the same payload': { ...record(good), tool: 'prophet_get_options_chain' },
  };
  for (const [name, rec] of Object.entries(cases)) {
    const { essential, warnings } = classifyFailures([rec]);
    assert.equal(essential.length, 1, `${name}: stays essential`);
    assert.deepEqual(warnings, [], `${name}: no warning`);
  }
});

test('D1 (-): an incomplete range is an ordinary answer, never this warning', () => {
  const rec = { kind: 'tool_call', tool: 'prophet_get_range_confirmation', args: PRIOR, status: 'completed', result: JSON.stringify({ status: 'window_incomplete', range: null, notes: ['Not every bar of the window is present'] }) };
  const { essential, warnings } = classifyFailures([rec]);
  assert.equal(essential.length, 0);
  assert.deepEqual(warnings, []);
});

test('D1 (-): the structured status carries the same shape the label demands (tool answer and label agree)', async () => {
  const payload = await realPayload({ ...PRIOR, window_start: '2026-11-16T15:00:00Z' });
  assert.equal(payload.status, 'session_not_covered');
  assert.equal(payload.requested_date, '2026-11-16');
  assert.deepEqual(Object.keys(payload).sort(), ['coverage_end', 'coverage_start', 'message', 'reason', 'requested_date', 'status']);
  assert.deepEqual(classifyFailures([record(payload, {}, { ...PRIOR, window_start: '2026-11-16T15:00:00Z' })]).warnings, [WARNING]);
});

// ── the beat outcome through the public ChatStore paths ──
const ACCOUNT = 'acct-n20';
async function activityFor(records) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-nov20-'));
  try {
    const store = new ChatStore(root);
    await store.startSession(ACCOUNT, 'session-n20', { agentName: 'Herald' });
    const file = path.join(root, 'sandboxes', ACCOUNT, 'chat-history', 'session-session-n20.jsonl');
    const lines = records.map((r, i) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 19, 19, 51, i)).toISOString(), activityId: 'act-n20', origin: 'Heartbeat', ...r }));
    await fs.appendFile(file, lines.join('\n') + '\n');
    const list = (await store.listActivities(ACCOUNT, { limit: 5 })).activities[0];
    const detail = await store.getActivity(ACCOUNT, 'act-n20');
    return { list, detail };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function expectOutcome(name, records, outcome, errorLabel) {
  const { list, detail } = await activityFor(records);
  assert.equal(list.outcome, outcome, `${name}: list outcome`);
  assert.equal(detail.outcome, outcome, `${name}: detail outcome`);
  assert.equal(list.labels.includes('Error'), errorLabel, `${name}: list Error label`);
  assert.equal(detail.labels.includes('Error'), errorLabel, `${name}: detail Error label`);
}

test('D1 (+): a beat whose only failing record is the not-covered refusal is Recorded with the warning and no Error label', async () => {
  const payload = await realPayload();
  await expectOutcome('only the refusal', [record(payload)], `Recorded (warning: ${WARNING})`, false);
});

test('D1 (-): the same refusal plus another essential failure in the beat leaves the beat Failed', async () => {
  const payload = await realPayload();
  const other = { kind: 'tool_call', tool: 'get_account', args: {}, status: 'error', error: 'Trading bot request failed: {"status":401}' };
  await expectOutcome('refusal plus account failure', [record(payload), other], 'Failed', true);
  const text = record('window_start must be a real RFC3339 UTC timestamp ending in Z');
  await expectOutcome('refusal plus an invalid-input refusal', [record(payload), text], 'Failed', true);
});

test('D1 (-): the same text under a different status keeps the beat Failed', async () => {
  const payload = await realPayload();
  await expectOutcome('different status', [record({ ...payload, status: 'invalid_input' })], 'Failed', true);
});

// ── Nov 20 QA B02: producer to classifier, malformed calendar evidence and impossible dates ──
test('B02 (-): a malformed calendar through the real producer stays essential in the classifier, with no bar read', async () => {
  const calendars = {
    'only row has bad open and close': { sessions: [{ date: '2026-11-18', open: 'bad', close: 'bad' }] },
    'only row has an impossible date': { sessions: [{ date: '2026-99-99', open: 'bad', close: 'bad' }] },
    'impossible date with readable times': { sessions: [{ date: '2026-99-99', open: '09:30', close: '16:00' }] },
    'a good row beside a bad one': { sessions: [{ date: '2026-11-18', open: '09:30', close: '16:00' }, { date: '2026-11-19', open: 'x', close: 'y' }] },
  };
  for (const [name, calendar] of Object.entries(calendars)) {
    let reads = 0;
    const produced = await getRangeConfirmation(PRIOR, { fetchBars: async () => { reads += 1; return { bars: [] }; }, fetchCalendar: async () => calendar, now: NOW });
    assert.equal(produced.status, 'invalid_input', name);
    assert.equal(reads, 0, `${name}: no bar read`);
    // the way the MCP server hands a refusal back: plain error text
    const { essential, warnings } = classifyFailures([record(produced.error)]);
    assert.equal(essential.length, 1, `${name}: essential`);
    assert.deepEqual(warnings, [], name);
  }
});

test('B02 (-): the recognizer needs real calendar dates, in every date of a stored payload', async () => {
  const good = await realPayload();
  const impossible = ['2026-99-99', '2026-02-30', '2026-13-01', '2026-00-10', '2026-11-31', '0000-01-01', '2026-1-1'];
  for (const bad of impossible) {
    const variants = {
      'coverage_end': { ...good, coverage_end: bad },
      'coverage_start': { ...good, coverage_start: bad },
      'requested_date': { ...good, requested_date: bad },
    };
    for (const [field, payload] of Object.entries(variants)) {
      // the request date must still match, so the request args follow requested_date when that is the bad field
      const args = field === 'requested_date' ? { ...PRIOR, window_start: PRIOR.window_start } : PRIOR;
      const { essential, warnings } = classifyFailures([record(payload, {}, args)]);
      assert.equal(essential.length, 1, `${field}=${bad}: essential`);
      assert.deepEqual(warnings, [], `${field}=${bad}`);
    }
  }
  // the exact case Hermes named: a directly stored payload with an impossible coverage end
  const stored = { status: 'session_not_covered', reason: 'date_outside_calendar_coverage', requested_date: '2026-11-17', coverage_start: '2026-11-18', coverage_end: '2026-99-99', message: 'outside' };
  assert.equal(classifyFailures([record(stored)]).essential.length, 1);
  // and the genuine one with the same shape and real dates still warns
  assert.deepEqual(classifyFailures([record({ ...stored, coverage_end: '2026-11-19' })]).warnings, [WARNING]);
});

test('B02 (+/-): the genuine unsupported prior date still warns; a holiday today and a second failure stay essential', async () => {
  const good = await realPayload();
  assert.deepEqual(classifyFailures([record(good)]).warnings, [WARNING]);
  const holiday = await getRangeConfirmation({ symbol: 'DIS', window_start: '2026-11-18T14:30:00Z' }, { fetchBars: async () => ({ bars: [] }), fetchCalendar: async () => ({ sessions: [{ date: '2026-11-19', open: '09:30', close: '16:00' }] }), now: NOW });
  assert.equal(holiday.status, 'invalid_input');
  assert.equal(classifyFailures([record(holiday.error, {}, { ...PRIOR, window_start: '2026-11-18T14:30:00Z' })]).essential.length, 1);
  const other = { kind: 'tool_call', tool: 'get_account', args: {}, status: 'error', error: 'Trading bot request failed: {"status":401}' };
  const { essential } = classifyFailures([record(good), other]);
  assert.equal(essential.length, 1);
  assert.equal(essential[0].tool, 'get_account');
});
