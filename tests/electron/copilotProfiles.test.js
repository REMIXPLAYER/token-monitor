'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCopilotProfiles } = require('../../src/electron/providers/copilot/profiles');

const USAGE = {
  copilot_plan: 'pro',
  quota_snapshots: {
    premium_interactions: {
      entitlement: 100,
      remaining: 90,
      percent_remaining: 90,
      quota_id: 'premium_interactions'
    }
  }
};

const IDENTITIES = {
  'gho-a': { login: 'octocat', id: 42 },
  'gho-b': { login: 'hubot', id: 7 },
  'gho-noid': { id: 99 }
};

function fixture(initial = {}) {
  let settings = structuredClone(initial);
  let persisted = structuredClone(initial);
  let saveFails = false;
  const changes = [];
  const fetch = async (url, init) => {
    const token = String(init.headers.Authorization || '').replace(/^token\s+/, '');
    if (token === 'bad') return { ok: false, status: 401, json: async () => ({}) };
    if (token === 'down') return { ok: false, status: 500, json: async () => ({}) };
    if (String(url).includes('/copilot_internal/user')) {
      return { ok: true, status: 200, json: async () => USAGE };
    }
    return { ok: true, status: 200, json: async () => IDENTITIES[token] || { login: '', id: 0 } };
  };
  const api = createCopilotProfiles({
    getSettings: () => settings,
    saveSettings: () => {
      if (saveFails) {
        settings = structuredClone(persisted);
        throw new Error('save failed');
      }
      persisted = structuredClone(settings);
      return true;
    },
    probeDeps: () => ({ fetch, now: () => Date.parse('2026-01-01T00:00:00.000Z') }),
    env: {},
    changed: (login, reason, options) => changes.push({ login, reason, options })
  });
  return {
    api,
    changes,
    settings: () => settings,
    failSaves(value) { saveFails = value; }
  };
}

test('Copilot profiles save by probed login and update rather than duplicate', async () => {
  const f = fixture({
    copilotProfiles: { octocat: { apiToken: 'old-token', enabled: false } }
  });
  assert.deepEqual(await f.api.saveProfile('gho-a'), { ok: true });
  assert.deepEqual(f.settings().copilotProfiles, {
    octocat: { apiToken: 'gho-a', enabled: true }
  });
  assert.deepEqual(f.changes.at(-1), { login: 'octocat', reason: 'profile-save', options: {} });
});

test('Copilot profiles reject tokens that cannot become separate accounts', async () => {
  const auto = fixture({ copilotApiToken: 'gho-a' });
  assert.deepEqual(await auto.api.saveProfile('gho-a'), { ok: false, errorCode: 'alreadyConnected' });

  const f = fixture();
  assert.deepEqual(await f.api.saveProfile('bad'), { ok: false, errorCode: 'invalidToken' });
  assert.deepEqual(await f.api.saveProfile('down'), { ok: false, errorCode: 'unavailable' });
  assert.deepEqual(await f.api.saveProfile(''), { ok: false, errorCode: 'missingToken' });
  assert.deepEqual(await f.api.saveProfile('gho-noid'), { ok: false, errorCode: 'invalidIdentity' });
  f.failSaves(true);
  assert.deepEqual(await f.api.saveProfile('gho-a'), {
    ok: false,
    errorCode: 'credentialStorageUnavailable'
  });
  assert.equal(f.settings().copilotProfiles, undefined);
  assert.equal(auto.changes.length + f.changes.length, 0);
});

test('Copilot profiles remove and enable only their own account and refresh scope', () => {
  const f = fixture({
    copilotProfiles: {
      octocat: { apiToken: 'gho-a', enabled: true },
      hubot: { apiToken: 'gho-b', enabled: true }
    }
  });

  assert.deepEqual(f.api.removeProfile('octocat'), { ok: true });
  assert.deepEqual(f.settings().copilotProfiles, { hubot: { apiToken: 'gho-b', enabled: true } });
  assert.deepEqual(f.changes.at(-1), {
    login: 'octocat',
    reason: 'profile-delete',
    options: { clear: true, refresh: false }
  });

  assert.deepEqual(f.api.setProfileEnabled('hubot', false), { ok: true });
  assert.deepEqual(f.changes.at(-1), {
    login: 'hubot',
    reason: 'profile-state',
    options: { clear: true, refresh: false }
  });
  assert.deepEqual(f.api.setProfileEnabled('hubot', true), { ok: true });
  assert.deepEqual(f.api.removeProfile('missing'), { ok: false, errorCode: 'notFound' });
  assert.deepEqual(f.api.setProfileEnabled('hubot', 'yes'), { ok: false, errorCode: 'invalidEnabled' });
});
