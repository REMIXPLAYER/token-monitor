'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMinimaxApiKeys } = require('../../src/electron/providers/minimax/apiKeys');
const { hashKey } = require('../../src/shared/hashKey');

function fixture(initial = {}, response = () => ({ ok: true, status: 200,
  json: async () => ({ available_amount: 8, base_resp: { status_code: 0 } }) }), env = { MINIMAX_CODING_API_KEY: 'env-secret' }) {
  let settings = structuredClone(initial);
  const changes = [];
  const requests = [];
  const api = createMinimaxApiKeys({
    getSettings: () => settings,
    saveSettings: () => {},
    env,
    changed: (key, refresh) => changes.push({ key, refresh }),
    probeDeps: () => ({ fetch: async (url, init) => { requests.push({ url, init }); return response(url, init); } })
  });
  return { api, changes, requests, settings: () => settings, patch: patch => {
    api.noteSettingsPatch(patch); settings = { ...settings, ...patch };
  } };
}

test('MiniMax key additions preserve legacy credentials and deduplicate without user account names', async () => {
  const f = fixture({ minimaxApiKey: 'legacy-secret', minimaxBillingMode: 'api', minimaxApiRegion: 'cn',
    limitsEnabled: false, limitProviders: '' });
  assert.equal(f.api.getKeys().length, 1);
  assert.equal(f.settings().minimaxApiKey, 'legacy-secret');
  assert.equal((await f.api.addKey({ apiKey: 'work-secret', billingMode: 'api' })).ok, true);
  assert.equal(f.requests.length, 1, 'save probes neither Code nor optional Spend');
  assert.equal(f.requests[0].url, 'https://api.minimax.io/account/query_balance');
  assert.equal(f.settings().minimaxApiKey, '');
  assert.equal(f.settings().minimaxApiProfiles.default.apiKey, 'legacy-secret');
  assert.equal(f.api.getKeys().find(key => key.accountKey === hashKey('minimax', 'work-secret')).apiRegion, 'auto');
  assert.equal(f.settings().limitsEnabled, true);
  assert.equal(f.settings().limitProviders, 'minimax');
  assert.ok(f.changes.some(change => change.key === hashKey('minimax', 'env-secret') && change.refresh));
  assert.equal(JSON.stringify(f.api.getKeys()).includes('-secret'), false);
  await f.api.addKey({ apiKey: 'work-secret', billingMode: 'api' });
  assert.equal(f.api.getKeys().length, 3, 'duplicate key is not a second credential');
  f.patch({ limitsEnabled: false, limitProviders: '' });
  const id = f.api.getKeys().find(key => key.accountKey === hashKey('minimax', 'work-secret')).id;
  assert.equal(f.api.removeKey(id).ok, true);
  assert.equal(f.settings().limitsEnabled, false);
  assert.equal(f.settings().limitProviders, '');
  await f.api.addKey({ apiKey: 'env-secret', billingMode: 'api' });
  assert.equal(f.api.getKeys().filter(key => key.accountKey === hashKey('minimax', 'env-secret')).length, 1);
  f.api.removeKey(f.api.getKeys().find(key => key.accountKey === hashKey('minimax', 'env-secret')).id);
  assert.equal(f.api.getKeys().find(key => key.id === 'environment').removable, false);
  assert.deepEqual(f.changes.at(-1), { key: hashKey('minimax', 'env-secret'), refresh: true });
});

test('MiniMax rejected or superseded key probes cannot change saved credentials', async () => {
  let release;
  const f = fixture({ minimaxApiProfiles: { work: { apiKey: 'saved-secret', billingMode: 'api' } } },
    () => new Promise(resolve => { release = resolve; }));
  const saving = f.api.addKey({ apiKey: 'new-secret', billingMode: 'api' });
  await new Promise(resolve => setImmediate(resolve));
  f.api.removeKey('work');
  release({ ok: true, json: async () => ({ available_amount: 8 }) });
  assert.equal((await saving).ok, false);
  assert.deepEqual(Object.keys(f.settings().minimaxApiProfiles), []);
  const rejected = fixture({ minimaxApiKey: 'saved-secret' }, () => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.equal((await rejected.api.addKey({ apiKey: 'bad' })).ok, false);
  assert.equal(rejected.settings().minimaxApiKey, 'saved-secret');
});

test('MiniMax key saves reject empty input, retain inherited regions and use the shared indeterminate verdict', async () => {
  const f = fixture({ minimaxApiProfiles: { work: { apiKey: 'saved-secret', billingMode: 'api', apiRegion: '' } } },
    () => ({ ok: false, status: 503, json: async () => ({}) }), { MINIMAX_API_REGION: 'cn' });
  const before = structuredClone(f.settings());
  assert.equal((await f.api.addKey({ apiKey: '', billingMode: 'api' })).ok, false);
  assert.deepEqual(f.settings(), before);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.api.addKey({ apiKey: 'saved-secret', billingMode: 'api' })).ok, true);
  assert.equal(f.settings().minimaxApiProfiles.work.apiKey, 'saved-secret');
  assert.equal(f.settings().minimaxApiProfiles.work.apiRegion, '');
  assert.equal(f.api.getKeys()[0].apiRegion, 'cn');
  assert.equal(f.requests[0].url, 'https://api.minimaxi.com/account/query_balance');
});

test('MiniMax key saves persist private keys and notify the runtime with the committed configuration', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { CredentialStore, persistSettingsAndCredentials } = require('../../src/shared/credentialStore');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'minimax-profiles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new CredentialStore(directory);
  const settings = { minimaxApiKey: 'legacy-secret', minimaxBillingMode: 'api', limitsEnabled: false, limitProviders: '' };
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const { fetchMinimaxLimits } = require('../../src/shared/providers/minimax/limits');
  const { runLimitInvalidation } = require('../../src/electron/deviceRuntimeCoordinator');
  const fetch = async () => ({ ok: true, json: async () => ({ available_amount: 5 }) });
  const runtime = createLimitsRuntime(settings, { autoStart: false, autoRetry: false,
    probeProvider: (_id, options) => fetchMinimaxLimits(options, { env: {}, homeDir: directory, fetch }) });
  t.after(() => runtime.stop());
  const refreshes = [];
  const profiles = createMinimaxApiKeys({
    getSettings: () => settings, env: {},
    saveSettings: () => persistSettingsAndCredentials({ store, settingsPath: path.join(directory, 'settings.json'),
      settings, previousSettings: {} }),
    probeDeps: () => ({ fetch }),
    changed: (accountKey, refresh, reason) => {
      runtime.reconfigure(settings);
      refreshes.push(runLimitInvalidation({ clearLimits: runtime.clear, refreshLimits: runtime.refresh },
        { provider: 'minimax', source: 'api', accountKey }, reason, { clear: true, refresh }));
    }
  });
  assert.equal((await profiles.addKey({ apiKey: 'work-secret', billingMode: 'api' })).ok, true);
  await Promise.all(refreshes);
  assert.equal(runtime.getSnapshot().providers.find(row => row.accountKey === hashKey('minimax', 'work-secret'))?.status, 'ok');
  assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes('-secret'), false);
  const saved = store.readDocument().credentials.providers.minimax;
  assert.equal(saved.profiles.default.apiKey, 'legacy-secret');
  assert.equal(saved.profiles[profiles.getKeys().find(key => key.accountKey === hashKey('minimax', 'work-secret')).id].apiKey, 'work-secret');
  assert.equal(saved.apiKey, undefined);
});
