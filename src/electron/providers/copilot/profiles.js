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

  function notify(login, reason, options = {}) {
    try {
      changed?.(login, reason, options);
    } catch (_) {}
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
    const settings = getSettings();
    settings.copilotProfiles = next;
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      return { ok: false, errorCode: 'credentialStorageUnavailable' };
    }

    notify(login, 'profile-save');
    return { ok: true, login };
  }

  function removeProfile(rawLogin) {
    const login = String(rawLogin || '').trim();
    const next = profiles();
    if (!Object.hasOwn(next, login)) return { ok: false, errorCode: 'notFound' };
    delete next[login];
    const settings = getSettings();
    settings.copilotProfiles = next;
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      return { ok: false, errorCode: 'credentialStorageUnavailable' };
    }
    notify(login, 'profile-delete', { clear: true, refresh: false });
    return { ok: true };
  }

  function setProfileEnabled(rawLogin, enabled) {
    if (typeof enabled !== 'boolean') return { ok: false, errorCode: 'invalidEnabled' };
    const login = String(rawLogin || '').trim();
    const next = profiles();
    if (!Object.hasOwn(next, login)) return { ok: false, errorCode: 'notFound' };
    next[login] = { ...next[login], enabled };
    const settings = getSettings();
    settings.copilotProfiles = next;
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      return { ok: false, errorCode: 'credentialStorageUnavailable' };
    }
    notify(login, 'profile-state', { clear: !enabled, refresh: enabled });
    return { ok: true };
  }

  return { saveProfile, removeProfile, setProfileEnabled };
}

module.exports = { createCopilotProfiles };
