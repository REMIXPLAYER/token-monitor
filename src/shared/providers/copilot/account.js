'use strict';

// GitHub Copilot limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'copilot',
  fetch: 'fetchCopilotLimits',
  // fetchCopilotLimits returns only the requested account's row when a
  // limitRefreshScope names it, so a quota row can refresh itself.
  accountRefresh: true,
  fields: [
    {
      key: 'copilotApiToken',
      kind: 'credential',
      storePath: ['providers', 'copilot', 'apiToken'],
      resolve: 'copilotToken'
    },
    {
      key: 'copilotEnterpriseHost',
      kind: 'setting',
      normalize: (value) => String(value || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()
    },
    {
      key: 'copilotProfiles',
      kind: 'profiles',
      storePath: ['providers', 'copilot', 'profiles'],
      configDefault: {},
      persist: 'never',
      project: 'redact'
    }
  ],
  // Copilot's sign-in flow owns its pending state, so there is no pendingKey.
  status: {
    credential: 'copilotApiToken',
    configuredKey: 'copilotApiTokenConfigured',
    sourceKey: 'copilotApiTokenSource'
  }
};
