'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMinimaxProfiles } = require('../../src/electron/providers/minimax/profiles');
const { hashKey } = require('../../src/shared/hashKey');

function fixture(initial = {}, response = () => ({ ok: true, status: 200,
  json: async () => ({ available_amount: 8, base_resp: { status_code: 0 } }) }), env = { MINIMAX_CODING_API_KEY: 'env-secret' }) {
  let settings = structuredClone(initial);
  const changes = [];
  const requests = [];
  const api = createMinimaxProfiles({
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

test('MiniMax profiles keep legacy credentials read-only until a validated profile edit migrates them', async () => {
  const f = fixture({ minimaxApiKey: 'legacy-secret', minimaxBillingMode: 'api', minimaxApiRegion: 'cn',
    limitsEnabled: false, limitProviders: '' });
  assert.equal(f.api.getProfiles().profiles.default.apiKey, 'set');
  assert.equal(f.settings().minimaxApiKey, 'legacy-secret');
  assert.equal((await f.api.saveProfile({ name: 'work', apiKey: 'work-secret', billingMode: 'api', apiRegion: 'intl' })).ok, true);
  assert.equal(f.requests.length, 1, 'save probes neither Code nor optional Spend');
  assert.equal(f.requests[0].url, 'https://api.minimax.io/account/query_balance');
  assert.equal(f.settings().minimaxApiKey, '');
  assert.equal(f.settings().minimaxApiProfiles.default.apiKey, 'legacy-secret');
  assert.equal(f.settings().minimaxApiProfiles.work.apiRegion, 'intl');
  assert.equal(f.settings().limitsEnabled, true);
  assert.equal(f.settings().limitProviders, 'minimax');
  assert.ok(f.changes.some(change => change.key === hashKey('minimax', 'env-secret') && change.refresh),
    'migrating away from a legacy override also refreshes the newly available environment lane');
  assert.equal(JSON.stringify(f.api.getProfiles()).includes('-secret'), false);
  f.patch({ limitsEnabled: false, limitProviders: '' });
  f.api.renameProfile('work', 'office');
  assert.equal(f.settings().minimaxApiProfiles.office.apiKey, 'work-secret');
  f.api.setProfileEnabled('office', false);
  assert.equal(f.settings().minimaxApiProfiles.office.enabled, false);
  f.api.setProfileEnabled('office', true);
  f.api.deleteProfile('office');
  assert.equal(f.settings().minimaxApiProfiles.office, undefined);
  assert.equal(f.settings().limitsEnabled, false, 'profile maintenance must preserve the collection switch');
  assert.equal(f.settings().limitProviders, '');
  await f.api.saveProfile({ name: 'env-copy', apiKey: 'env-secret', billingMode: 'api', apiRegion: 'cn' });
  f.api.setProfileEnabled('env-copy', false);
  assert.equal(f.api.getProfiles().hasEnvVar, false);
  f.api.deleteProfile('env-copy');
  assert.equal(f.api.getProfiles().hasEnvVar, true);
  assert.deepEqual(f.changes.at(-1), { key: hashKey('minimax', 'env-secret'), refresh: true });
});

test('MiniMax rejected or superseded profile probes cannot replace a saved credential', async () => {
  let release;
  const f = fixture({ minimaxApiProfiles: { work: { apiKey: 'saved-secret', billingMode: 'api' } } },
    () => new Promise(resolve => { release = resolve; }));
  const saving = f.api.saveProfile({ name: 'work', apiKey: 'new-secret', billingMode: 'api', apiRegion: 'cn' });
  await new Promise(resolve => setImmediate(resolve));
  f.api.deleteProfile('work');
  release({ ok: false, status: 401, json: async () => ({}) });
  assert.equal((await saving).ok, false);
  assert.deepEqual(Object.keys(f.settings().minimaxApiProfiles), []);
  const rejected = fixture({ minimaxApiKey: 'saved-secret' }, () => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.equal((await rejected.api.saveProfile({ name: 'work', apiKey: 'bad', apiRegion: 'cn' })).ok, false);
  assert.equal(rejected.settings().minimaxApiKey, 'saved-secret');
});

test('MiniMax profile replacement requires its key and follows the shared indeterminate verdict', async () => {
  const f = fixture({ minimaxApiProfiles: {
    work: { apiKey: 'saved-secret', billingMode: 'api', apiRegion: 'cn' },
    personal: { apiKey: 'personal-secret', billingMode: 'token-plan', apiRegion: 'intl' }
  } },
    () => ({ ok: false, status: 503, json: async () => ({}) }));
  const before = structuredClone(f.settings());
  assert.equal((await f.api.saveProfile({ name: 'personal', apiKey: '', billingMode: 'api', apiRegion: 'cn' })).ok, false);
  assert.deepEqual(f.settings(), before);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.api.saveProfile({ name: 'work', apiKey: 'saved-secret', billingMode: 'api', apiRegion: 'intl' })).ok, true);
  assert.equal(f.settings().minimaxApiProfiles.work.apiKey, 'saved-secret');
  assert.equal(f.settings().minimaxApiProfiles.work.apiRegion, 'intl');
  await assert.rejects(f.api.saveProfile({ name: 'duplicate', apiKey: 'saved-secret', billingMode: 'api', apiRegion: 'cn' }), /already has a profile/);
  assert.equal(f.settings().minimaxApiProfiles.duplicate, undefined);
  const inherited = fixture({ minimaxApiProfiles: { work: { apiKey: 'saved-secret', billingMode: 'api', apiRegion: '' } } },
    undefined, { MINIMAX_API_REGION: 'cn' });
  assert.equal((await inherited.api.saveProfile({ name: 'work', apiKey: 'saved-secret', billingMode: 'api', apiRegion: '' })).ok, true);
  assert.equal(inherited.settings().minimaxApiProfiles.work.apiRegion, '');
  assert.equal(inherited.requests[0].url, 'https://api.minimaxi.com/account/query_balance');
  const { limitProviderEntry } = require('../../src/shared/limits/registry');
  assert.equal(limitProviderEntry('minimax').envProbe.probe({ MINIMAX_API_REGION: 'cn' }), 'cn');
});

test('MiniMax profile saves persist private keys and notify the runtime with the committed configuration', async t => {
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
  const profiles = createMinimaxProfiles({
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
  assert.equal((await profiles.saveProfile({ name: 'work', apiKey: 'work-secret', billingMode: 'api', apiRegion: 'cn' })).ok, true);
  await Promise.all(refreshes);
  assert.equal(runtime.getSnapshot().providers.find(row => row.accountName === 'work')?.status, 'ok');
  assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes('-secret'), false);
  const saved = store.readDocument().credentials.providers.minimax;
  assert.equal(saved.profiles.default.apiKey, 'legacy-secret');
  assert.equal(saved.profiles.work.apiKey, 'work-secret');
  assert.equal(saved.apiKey, undefined);
});
