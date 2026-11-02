'use strict';

const limits = require('../../../shared/providers/minimax/limits');
const { hashKey } = require('../../../shared/hashKey');
const { createCredentialCommands, providerSelectionIncluding } = require('../../limits/credentialCommands');
const { redactMinimaxProfilesForRenderer } = require('../../limits/accountSettings');

function createMinimaxProfiles({ getSettings, saveSettings, probeDeps, changed, env = process.env }) {
  const profiles = () => limits.minimaxApiProfiles(getSettings());
  function commit(next, before, after, reason) {
    const settings = getSettings();
    const previousAccounts = new Map(limits.configuredMinimaxAccounts(settings, { env }).map(account => [account.apiKey, account.name]));
    settings.minimaxApiProfiles = next;
    settings.minimaxApiKey = '';
    saveSettings({ throwOnError: true });
    if (before && (!after || before.apiKey !== after.apiKey || after.enabled === false)) {
      changed(hashKey('minimax', before.apiKey), false, reason);
    }
    for (const account of limits.configuredMinimaxAccounts(settings, { env })) {
      if (account.apiKey === after?.apiKey || previousAccounts.get(account.apiKey) !== account.name) {
        changed(hashKey('minimax', account.apiKey), true, reason);
      }
    }
  }
  const commands = createCredentialCommands({
    getSettings, env: {}, includeIndependentSettings: true, probeDeps: () => ({ ...probeDeps(), probe: true, providerRuntimeState: new Map() }),
    commitCredential: ({ candidate, values }) => {
      const next = profiles();
      if (Object.entries(next).some(([name, profile]) => name !== values.profileName && profile.apiKey === candidate.minimaxApiKey)) {
        throw new Error('This API key already has a profile');
      }
      const before = next[values.profileName];
      const after = { apiKey: candidate.minimaxApiKey, enabled: before?.enabled !== false,
        billingMode: candidate.minimaxBillingMode, apiRegion: values.profileRegion };
      next[values.profileName] = after;
      const settings = getSettings();
      settings.limitProviders = providerSelectionIncluding(settings.limitProviders, 'minimax');
      settings.limitsEnabled = true;
      commit(next, before, after, 'profile-save');
    }
  });
  function mutate(name, update, reason = 'profile-state') {
    commands.noteSettingsPatch({ minimaxApiKey: '' });
    const next = profiles();
    if (!Object.hasOwn(next, name)) return { ok: false, error: 'Profile not found' };
    const before = next[name];
    const after = update(next, before);
    commit(next, before, after, reason);
    return { ok: true };
  }
  return {
    getProfiles() {
      return { profiles: redactMinimaxProfilesForRenderer(profiles()),
        hasEnvVar: limits.configuredMinimaxAccounts(getSettings(), { env }).some(account => account.name === 'environment') };
    },
    async saveProfile(input = {}) {
      const name = limits.minimaxProfileName(input.name);
      if (!name) return { ok: false, errorCode: 'invalidName' };
      const profileRegion = limits.normalizeMinimaxRegionSetting(input.apiRegion ?? 'auto');
      const result = await commands.saveCredential('minimax', {
        profileName: name, profileRegion,
        minimaxApiKey: input.apiKey,
        minimaxBillingMode: input.billingMode,
        minimaxApiRegion: limits.minimaxRegion({ minimaxApiRegion: profileRegion }, env)
      });
      return { ok: result.saved, status: result.status, errorCode: result.errorCode || result.verdict };
    },
    deleteProfile(name) {
      return mutate(name, next => { delete next[name]; }, 'profile-delete');
    },
    renameProfile(name, rawName) {
      const renamed = limits.minimaxProfileName(rawName);
      if (!renamed || renamed === name) return { ok: false, errorCode: 'invalidName' };
      if (Object.hasOwn(profiles(), renamed)) return { ok: false, error: 'Profile name already exists' };
      return mutate(name, (next, before) => { next[renamed] = before; delete next[name]; return before; }, 'profile-rename');
    },
    setProfileEnabled(name, enabled) {
      return mutate(name, (next, before) => (next[name] = { ...before, enabled: Boolean(enabled) }));
    },
    noteSettingsPatch(patch) {
      commands.noteSettingsPatch(Object.hasOwn(patch, 'minimaxApiProfiles') ? { minimaxApiKey: '' } : patch);
    }
  };
}

module.exports = { createMinimaxProfiles };
