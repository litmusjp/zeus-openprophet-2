import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The Railway value must exist before the store captures the boot environment (once per process).
process.env.GEMINI_API_KEY = 'railway-gemini-value-0001';
delete process.env.OPENCODE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const secrets = await import('../agent/secrets-store.js');
const { createLoginVerifier, parseBasicHeader } = await import('../agent/dashboard-login.js');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-secrets-'));
  const file = path.join(dir, 'secrets.json');
  secrets.initSecrets({ filePath: file, split: false });
  return { dir, file };
}
const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

test('a saved provider key wins, shows only its source and last four, and Remove restores the Railway value', () => {
  const { file } = freshStore();
  secrets.applyProviderEnv();
  assert.equal(process.env.GEMINI_API_KEY, 'railway-gemini-value-0001');
  assert.deepEqual(Object.keys(secrets.providerStatus()), ['gemini', 'opencode', 'anthropic']);
  assert.equal(secrets.providerStatus().gemini.source, 'railway');
  assert.equal(secrets.providerStatus().opencode.source, 'unset');

  secrets.setProvider('gemini', 'saved-gemini-value-ABCD', '127.0.0.1');
  assert.equal(process.env.GEMINI_API_KEY, 'saved-gemini-value-ABCD');
  const status = secrets.providerStatus().gemini;
  assert.equal(status.source, 'saved');
  assert.equal(status.last4, 'ABCD');
  assert.ok(!JSON.stringify(secrets.providerStatus()).includes('saved-gemini-value'), 'status never carries the value');
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  secrets.removeProvider('gemini', '127.0.0.1');
  assert.equal(process.env.GEMINI_API_KEY, 'railway-gemini-value-0001');
  secrets.setProvider('anthropic', 'anthropic-test-key-WXYZ');
  assert.equal(process.env.ANTHROPIC_API_KEY, 'anthropic-test-key-WXYZ');
  secrets.removeProvider('anthropic');
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined, 'with no Railway value, removing leaves the variable unset');
});

test('provider values and names are validated', () => {
  freshStore();
  for (const bad of ['short', 'has space inside 12345', 'tab\tinside12345', '', null, undefined, 'x'.repeat(513)]) {
    assert.throws(() => secrets.setProvider('gemini', bad), /key must be 8 to 512/, String(bad));
  }
  assert.throws(() => secrets.setProvider('openai', 'abcdefghijkl'), /Unknown provider/);
  assert.throws(() => secrets.removeProvider('__proto__'), /Unknown provider/);
});

test('the file is written atomically, keeps a backup, and the change log never holds a value', () => {
  const { file } = freshStore();
  secrets.setProvider('opencode', 'opencode-key-one-1111');
  secrets.setProvider('opencode', 'opencode-key-two-2222');
  assert.ok(fs.existsSync(file + '.bak'), 'previous copy kept');
  assert.ok(!fs.readdirSync(path.dirname(file)).some(name => name.includes('.tmp-')), 'no temp file left behind');
  const log = secrets.changeLog(5);
  assert.equal(log[0].item, 'provider:opencode');
  assert.equal(log[0].action, 'saved');
  assert.ok(!JSON.stringify(log).includes('opencode-key'));
});

test('an unreadable store is never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-secrets-bad-'));
  const file = path.join(dir, 'secrets.json');
  fs.writeFileSync(file, '{not json');
  secrets.initSecrets({ filePath: file, split: false });
  assert.equal(secrets.isCorrupt(), true);
  assert.throws(() => secrets.setProvider('gemini', 'abcdefghijkl'), /unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});

test('the dashboard password is stored only as a salted hash', () => {
  const { file } = freshStore();
  assert.throws(() => secrets.validateLoginInput({ username: 'ab', newPassword: 'long-enough-pass', confirmPassword: 'long-enough-pass' }), /Username/);
  assert.throws(() => secrets.validateLoginInput({ username: 'a:b', newPassword: 'long-enough-pass', confirmPassword: 'long-enough-pass' }), /Username/);
  assert.throws(() => secrets.validateLoginInput({ username: 'operator', newPassword: 'short', confirmPassword: 'short' }), /at least 12/);
  assert.throws(() => secrets.validateLoginInput({ username: 'operator', newPassword: 'long-enough-pass', confirmPassword: 'different-pass-xx' }), /do not match/);
  secrets.setDashboardLogin({ username: 'operator', newPassword: 'correct horse battery' });
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('correct horse battery'));
  assert.match(onDisk, /"hash": "[0-9a-f]{128}"/);
  assert.equal(secrets.verifySavedPassword('operator', 'correct horse battery'), true);
  assert.equal(secrets.verifySavedPassword('operator', 'wrong horse battery!'), false);
  assert.equal(secrets.verifySavedPassword('someone-else', 'correct horse battery'), false);
  secrets.removeDashboardLogin();
  assert.equal(secrets.getDashboardLogin(), null);
  assert.equal(secrets.verifySavedPassword('operator', 'correct horse battery'), false);
});

test('both logins are valid, the Railway login is never delayed, and the saved one is verified once then remembered', () => {
  let slowChecks = 0;
  let clock = 1_000_000;
  let saved = { username: 'operator' };
  const verifier = createLoginVerifier({
    railway: { user: 'rail', pass: 'rail-pass' },
    saved: () => saved,
    verifySaved: (u, p) => { slowChecks += 1; return u === 'operator' && p === 'saved-pass-123'; },
    now: () => clock,
  });
  assert.equal(verifier.isConfigured(), true);
  assert.deepEqual(verifier.verify(basic('rail', 'rail-pass')), { ok: true, source: 'railway' });
  assert.equal(verifier.verify(basic('rail', 'nope')).ok, false);
  assert.equal(verifier.verify('Bearer x').ok, false);
  assert.equal(verifier.verify(undefined).ok, false);

  assert.equal(verifier.verify(basic('operator', 'saved-pass-123')).source, 'saved');
  assert.equal(verifier.verify(basic('operator', 'saved-pass-123')).source, 'saved');
  assert.equal(slowChecks, 1, 'the second request uses the remembered approval');
  clock += 11 * 60 * 1000;
  assert.equal(verifier.verify(basic('operator', 'saved-pass-123')).ok, true);
  assert.equal(slowChecks, 2, 'the approval expires after ten minutes');

  verifier.invalidate();
  assert.equal(verifier.verify(basic('operator', 'saved-pass-123')).ok, true);
  assert.equal(slowChecks, 3, 'a login change clears the remembered approvals');

  // three free typos, then a growing pause for the saved login only
  verifier.invalidate();
  for (let i = 0; i < 3; i++) assert.deepEqual(verifier.verify(basic('operator', 'bad' + i)), { ok: false, source: null });
  const fourth = verifier.verify(basic('operator', 'bad3'));
  assert.equal(fourth.ok, false);
  const paused = verifier.verify(basic('operator', 'saved-pass-123'));
  assert.equal(paused.ok, false);
  assert.ok(paused.retryAfterSeconds >= 1, 'inside the pause even the right saved password waits');
  assert.equal(verifier.verify(basic('rail', 'rail-pass')).ok, true, 'the Railway login is never delayed');
  clock += 20_000;
  assert.equal(verifier.verify(basic('operator', 'saved-pass-123')).ok, true, 'after the pause the saved login works again');

  saved = null;
  verifier.invalidate();
  assert.equal(verifier.verify(basic('operator', 'saved-pass-123')).ok, false, 'removing the saved login stops it working');
  assert.equal(verifier.verify(basic('rail', 'rail-pass')).ok, true);
});

test('with no Railway login the saved one is enough, and with neither the service reports not configured', () => {
  const only = createLoginVerifier({ railway: {}, saved: () => ({ username: 'operator' }), verifySaved: () => true });
  assert.equal(only.isConfigured(), true);
  assert.equal(only.verify(basic('operator', 'anything-at-all')).ok, true);
  const none = createLoginVerifier({ railway: {}, saved: () => null });
  assert.equal(none.isConfigured(), false);
  assert.equal(none.verify(basic('a', 'b')).ok, false);
});

test('Basic header parsing', () => {
  assert.deepEqual(parseBasicHeader(basic('u', 'p:q')), { user: 'u', pass: 'p:q' });
  assert.equal(parseBasicHeader('Bearer abc'), null);
  assert.deepEqual(parseBasicHeader('Basic ' + Buffer.from('nocolon').toString('base64')), { user: '', pass: '' });
});
