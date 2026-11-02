'use strict';

const { randomUUID } = require('node:crypto');
const limits = require('../../../shared/providers/minimax/limits');
const { hashKey } = require('../../../shared/hashKey');
const { createCredentialCommands, providerSelectionIncluding } = require('../../limits/credentialCommands');

function createMinimaxApiKeys({ getSettings, saveSettings, probeDeps, changed, env = process.env }) {
  const profiles = () => limits.minimaxApiProfiles(getSettings());
  function commit(next, key, reason) {
    const settings = getSettings();
    const before = new Set(limits.configuredMinimaxAccounts(settings, { env }).map(account => account.apiKey));
    settings.minimaxApiProfiles = next;
    settings.minimaxApiKey = '';
    saveSettings({ throwOnError: true });
    const after = limits.configuredMinimaxAccounts(settings, { env });
    for (const previous of before) {
      if (!after.some(account => account.apiKey === previous)) changed(hashKey('minimax', previous), false, reason);
    }
    for (const account of after) {
      if (account.apiKey === key || !before.has(account.apiKey)) changed(hashKey('minimax', account.apiKey), true, reason);
    }
  }
  const commands = createCredentialCommands({
    getSettings, env: {}, includeIndependentSettings: true,
    probeDeps: () => ({ ...probeDeps(), probe: true, providerRuntimeState: new Map() }),
    commitCredential: ({ candidate, values }) => {
      const next = profiles();
      const key = candidate.minimaxApiKey;
      const id = Object.keys(next).find(id => next[id].apiKey === key) || randomUUID();
      next[id] = { apiKey: key, enabled: true, billingMode: candidate.minimaxBillingMode, apiRegion: values.apiRegion };
      const settings = getSettings();
      settings.limitProviders = providerSelectionIncluding(settings.limitProviders, 'minimax');
      settings.limitsEnabled = true;
      commit(next, key, 'key-save');
    }
  });
  return {
    getKeys() {
      return Object.entries(profiles()).map(([id, profile]) => ({
        id, accountKey: hashKey('minimax', profile.apiKey), billingMode: profile.billingMode,
        apiRegion: limits.minimaxRegion({ minimaxApiRegion: profile.apiRegion }, env), enabled: profile.enabled !== false
      }));
    },
    async addKey(input = {}) {
      const key = limits.minimaxToken({}, input.apiKey);
      const previous = Object.values(profiles()).find(profile => profile.apiKey === key);
      const apiRegion = previous?.apiRegion ?? 'auto';
      const result = await commands.saveCredential('minimax', {
        apiRegion, minimaxApiKey: input.apiKey, minimaxBillingMode: input.billingMode,
        minimaxApiRegion: limits.minimaxRegion({ minimaxApiRegion: apiRegion }, env)
      });
      return { ok: result.saved, status: result.status, errorCode: result.errorCode || result.verdict };
    },
    removeKey(id) {
      commands.noteSettingsPatch({ minimaxApiKey: '' });
      const next = profiles();
      if (!Object.hasOwn(next, id)) return { ok: false, error: 'API key not found' };
      const key = next[id].apiKey;
      delete next[id];
      commit(next, key, 'key-remove');
      return { ok: true };
    },
    noteSettingsPatch(patch) {
      commands.noteSettingsPatch(Object.hasOwn(patch, 'minimaxApiProfiles') ? { minimaxApiKey: '' } : patch);
    }
  };
}

module.exports = { createMinimaxApiKeys };
