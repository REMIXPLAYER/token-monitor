'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCopilotProfiles } = require('../../src/electron/providers/copilot/profiles');

const USAGE = {
  copilot_plan: 'pro',
  quota_reset_date: '2026-07-01',
  quota_snapshots: {
    premium_interactions: {
      entitlement: 100,
      remaining: 90,
      percent_remaining: 90,
      quota_id: 'premium_interactions'
    }
  }
};

const IDENTITIES = new Map([
  ['gho-a', { login: 'octocat', id: 42 }],
  ['gho-b', { login: 'hubot', id: 7 }],
  ['gho-noid', { id: 99 }]
]);

function fixture(initial = {}) {
  let settings = structuredClone(initial);
  let saveFails = false;
  const changes = [];
  const fetch = async (url, init) => {
    const token = String(init.headers.Authorization || '').replace(/^token\s+/, '');
    if (token === 'bad') return { ok: false, status: 401, json: async () => ({}) };
    if (token === 'down') return { ok: false, status: 500, json: async () => ({}) };
    if (String(url).includes('/copilot_internal/user')) {
      return { ok: true, status: 200, json: async () => USAGE };
    }
    if (String(url) === 'https://api.github.com/user') {
      return { ok: true, status: 200, json: async () => IDENTITIES.get(token) || { login: '', id: 0 } };
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
  const api = createCopilotProfiles({
    getSettings: () => settings,
    saveSettings: () => {
      if (saveFails) throw new Error('save failed');
      return true;
    },
    probeDeps: () => ({ fetch, now: () => Date.parse('2026-01-01T00:00:00.000Z') }),
    env: {},
    changed: (login, reason, options) => changes.push({ login, reason, options })
  });
  return {
    api,
    settings: () => settings,
    changes,
    failSaves(value) { saveFails = value; }
  };
}

test('Copilot manual profile saves use the probed login as the profile key', async () => {
  const f = fixture();
  const result = await f.api.saveProfile('gho-a');

  assert.deepEqual(result, { ok: true, login: 'octocat' });
  assert.deepEqual(f.settings().copilotProfiles, {
    octocat: { apiToken: 'gho-a', enabled: true }
  });
  assert.deepEqual(f.changes.at(-1), { login: 'octocat', reason: 'profile-save', options: {} });
});

test('Copilot manual profile saves update the same login instead of adding a second row', async () => {
  const f = fixture({
    copilotProfiles: { octocat: { apiToken: 'old-token', enabled: false } }
  });
  const result = await f.api.saveProfile('gho-a');

  assert.equal(result.ok, true);
  assert.equal(Object.keys(f.settings().copilotProfiles).length, 1);
  assert.deepEqual(f.settings().copilotProfiles.octocat, {
    apiToken: 'gho-a',
    enabled: true
  });
});

test('Copilot manual profile saves refuse the token already tracked by the auto lane', async () => {
  const f = fixture({ copilotApiToken: 'gho-a' });
  const result = await f.api.saveProfile('gho-a');

  assert.deepEqual(result, { ok: false, errorCode: 'alreadyConnected' });
  assert.equal(f.settings().copilotProfiles, undefined);
  assert.equal(f.changes.length, 0);
});

test('Copilot manual profile saves reject a rejected token and an unavailable probe', async () => {
  const f = fixture();

  assert.deepEqual(await f.api.saveProfile('bad'), { ok: false, errorCode: 'invalidToken' });
  assert.deepEqual(await f.api.saveProfile('down'), { ok: false, errorCode: 'unavailable' });
  assert.deepEqual(await f.api.saveProfile(''), { ok: false, errorCode: 'missingToken' });
  assert.equal(f.settings().copilotProfiles, undefined);
  assert.equal(f.changes.length, 0);
});

test('Copilot manual profile saves reject a probe whose identity has no login', async () => {
  const f = fixture();
  const result = await f.api.saveProfile('gho-noid');

  assert.deepEqual(result, { ok: false, errorCode: 'invalidIdentity' });
  assert.equal(f.settings().copilotProfiles, undefined);
});

test('Copilot manual profile saves report a failed settings write', async () => {
  const f = fixture();
  f.failSaves(true);
  const result = await f.api.saveProfile('gho-a');

  assert.deepEqual(result, { ok: false, errorCode: 'credentialStorageUnavailable' });
  assert.equal(f.changes.length, 0);
});

test('Copilot manual profile removal clears only that account', () => {
  const f = fixture({
    copilotProfiles: {
      octocat: { apiToken: 'gho-a', enabled: true },
      hubot: { apiToken: 'gho-b', enabled: true }
    }
  });
  const result = f.api.removeProfile('octocat');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(f.settings().copilotProfiles, {
    hubot: { apiToken: 'gho-b', enabled: true }
  });
  assert.deepEqual(f.changes.at(-1), {
    login: 'octocat',
    reason: 'profile-delete',
    options: { clear: true, refresh: false }
  });
  assert.deepEqual(f.api.removeProfile('missing'), { ok: false, errorCode: 'notFound' });
});

test('Copilot manual profile enable state scopes the refresh', () => {
  const f = fixture({
    copilotProfiles: { octocat: { apiToken: 'gho-a', enabled: true } }
  });

  assert.deepEqual(f.api.setProfileEnabled('octocat', false), { ok: true });
  assert.equal(f.settings().copilotProfiles.octocat.enabled, false);
  assert.deepEqual(f.changes.at(-1), {
    login: 'octocat',
    reason: 'profile-state',
    options: { clear: true, refresh: false }
  });

  assert.deepEqual(f.api.setProfileEnabled('octocat', true), { ok: true });
  assert.equal(f.settings().copilotProfiles.octocat.enabled, true);
  assert.deepEqual(f.changes.at(-1), {
    login: 'octocat',
    reason: 'profile-state',
    options: { clear: false, refresh: true }
  });
  assert.deepEqual(f.api.setProfileEnabled('missing', true), { ok: false, errorCode: 'notFound' });
  assert.deepEqual(f.api.setProfileEnabled('octocat', 'yes'), { ok: false, errorCode: 'invalidEnabled' });
});
