import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSlackNotification } from '../agent/slack-format.js';

test('prefixes a Slack notification with the account name', () => {
  assert.equal(
    formatSlackNotification(':robot_face: Test notification', 'Litmus2'),
    '[Litmus2] :robot_face: Test notification',
  );
});

test('uses a safe fallback when the account name is missing', () => {
  assert.equal(formatSlackNotification('Test notification', ''), '[OpenProphet] Test notification');
});
