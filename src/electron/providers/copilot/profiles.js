'use strict';

// Manual GitHub Copilot profiles. The device-flow token stays the provider's
// auto lane; this service owns only the user-added tokens and their metadata.

const limits = require('../../../shared/providers/copilot/limits');

const LOGIN_PATTERN = /^[A-Za-z0-9-]+$/;

function createCopilotProfiles({ getSettings, saveSettings, probeDeps, changed, env = process.env }) {
  function profiles() {
    return { ...(getSettings().copilotProfiles || {}) };
  }

  function enterpriseHost() {
    return getSettings().copilotEnterpriseHost
      || env.COPILOT_ENTERPRISE_HOST
      || env.GITHUB_ENTERPRISE_HOST
      || '';
  }

  function commit(next, login, reason, options = {}) {
    const settings = getSettings();
    settings.copilotProfiles = next;
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      return { ok: false, errorCode: 'credentialStorageUnavailable' };
    }
    try {
      changed?.(login, reason, options);
    } catch (_) {}
    return { ok: true };
  }

  async function saveProfile(rawToken) {
    const token = limits.copilotToken({}, { copilotApiToken: rawToken });
    if (!token) return { ok: false, errorCode: 'missingToken' };

    const activeAuto = limits.copilotToken(env, { copilotApiToken: getSettings().copilotApiToken });
    if (token === activeAuto) return { ok: false, errorCode: 'alreadyConnected' };

    let provider;
    try {
      provider = await limits.fetchCopilotLimits(
        { copilotApiToken: token, copilotEnterpriseHost: enterpriseHost() },
        { ...probeDeps(), env: {}, probe: true }
      );
    } catch (_) {
      return { ok: false, errorCode: 'unavailable' };
    }

    if (provider?.status !== 'ok') {
      return {
        ok: false,
        errorCode: provider?.status === 'unauthorized' ? 'invalidToken' : 'unavailable'
      };
    }

    const login = String(provider.accountName || '').trim();
    if (!LOGIN_PATTERN.test(login)) return { ok: false, errorCode: 'invalidIdentity' };

    const next = profiles();
    next[login] = { apiToken: token, enabled: true };
    return commit(next, login, 'profile-save');
  }

  function removeProfile(rawLogin) {
    const login = String(rawLogin || '').trim();
    const next = profiles();
    if (!Object.hasOwn(next, login)) return { ok: false, errorCode: 'notFound' };
    delete next[login];
    return commit(next, login, 'profile-delete', { clear: true, refresh: false });
  }

  function setProfileEnabled(rawLogin, enabled) {
    if (typeof enabled !== 'boolean') return { ok: false, errorCode: 'invalidEnabled' };
    const login = String(rawLogin || '').trim();
    const next = profiles();
    if (!Object.hasOwn(next, login)) return { ok: false, errorCode: 'notFound' };
    next[login] = { ...next[login], enabled };
    return commit(next, login, 'profile-state', { clear: !enabled, refresh: enabled });
  }

  return { saveProfile, removeProfile, setProfileEnabled };
}

module.exports = { createCopilotProfiles };
