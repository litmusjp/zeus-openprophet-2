import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const html = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');

function between(start, end) {
  const s = html.indexOf(start), e = html.indexOf(end, s);
  assert.ok(s >= 0 && e > s, `found ${start}`);
  return html.slice(s, e);
}

test('the Plugins and Settings panels have the credential containers and load them on tab switch', () => {
  assert.match(html, /<div id="provider-key-cards"><\/div>/);
  assert.match(html, /id="dashboard-login-card"/);
  assert.match(html, /id="railway-managed-line"/);
  assert.match(html, /if \(id === 'plugins'\) \{ loadChatGPTStatus\(\); loadSecretsStatus\(\); \}/);
  assert.match(html, /if \(id === 'settings'\) loadSecretsStatus\(\);/);
  // the provider cards sit inside the AI Providers section, after the ChatGPT card
  assert.ok(html.indexOf('id="provider-key-cards"') > html.indexOf('chatgpt-connect-btn'));
  assert.ok(html.indexOf('id="provider-key-cards"') < html.indexOf('Slack Notifications'));
  // the login card is at the bottom of Settings, after Backup & Restore
  assert.ok(html.indexOf('id="dashboard-login-section"') > html.indexOf('Backup &amp; Restore'));
});

test('the cards render only a source label and the last four characters, never a value', () => {
  const code = between('// ── Credentials managed in the app', 'async function loadChatGPTStatus() {');
  const elements = { 'provider-key-cards': { innerHTML: '', children: [] }, 'dashboard-login-card': { innerHTML: '' }, 'railway-managed-line': { innerHTML: '' } };
  const context = {
    document: { getElementById: id => elements[id] || null },
    esc: s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    showToast() {}, confirm: () => true, Date, console,
  };
  vm.createContext(context);
  vm.runInContext(code + '\n;globalThis.__render = (s) => { _secretsStatus = s; renderProviderKeyCards(); renderDashboardLoginCard(); };', context);
  context.__render({
    providers: {
      gemini: { source: 'saved', last4: 'ABCD', savedAt: '2026-11-09T05:00:00Z' },
      opencode: { source: 'railway', last4: '7788', savedAt: null },
      anthropic: { source: 'unset', last4: null, savedAt: null },
    },
    dashboardLogin: { source: 'saved', username: 'operator', savedAt: '2026-11-09T05:00:00Z', railwayLoginAlsoValid: true },
    railwayManaged: [{ name: 'ALPHADESK_CONTROL_KEY', set: true }, { name: 'TRADING_BOT_TOKEN', set: false }],
    changeLog: [{ item: 'provider:gemini', action: 'saved', at: '2026-11-09T05:00:00Z' }],
  });
  const cards = elements['provider-key-cards'].innerHTML;
  assert.match(cards, /Saved in app · ends ABCD/);
  assert.match(cards, /Railway variable · ends 7788/);
  assert.match(cards, /Not set/);
  assert.match(cards, /Billed per token through this key, unlike the ChatGPT subscription/);
  assert.match(cards, /type="password"/);
  assert.equal((cards.match(/Remove<\/button>/g) || []).length, 3);
  assert.match(cards, /disabled onclick="removeProviderKey\('opencode'\)"/);
  assert.match(elements['dashboard-login-card'].innerHTML, /Saved in app · operator/);
  assert.match(elements['dashboard-login-card'].innerHTML, /Railway login stays valid as a backup/);
  assert.match(elements['railway-managed-line'].innerHTML, /ALPHADESK_CONTROL_KEY \(set\), TRADING_BOT_TOKEN \(not set\)/);
});
