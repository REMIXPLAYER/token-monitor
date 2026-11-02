'use strict';

// Account declarations must remain require-free for renderer-safe projection.
module.exports = {
  id: 'minimax',
  fetch: 'fetchMinimaxLimits',
  fields: [
    { key: 'minimaxApiProfiles', kind: 'profiles', invalidationSource: 'api',
      storePath: ['providers', 'minimax', 'profiles'], configDefault: {}, persist: 'never', project: 'redact' },
    {
      key: 'minimaxApiKey',
      kind: 'credential',
      invalidationSource: 'api',
      storePath: ['providers', 'minimax', 'apiKey'],
      resolve: 'minimaxToken',
      resolveStyle: 'explicit'
    },
    {
      key: 'minimaxApiRegion',
      kind: 'setting',
      invalidationSource: 'api',
      normalize: { fn: 'normalizeMinimaxRegionSetting', style: 'value' },
      envFallback: ['TOKEN_MONITOR_MINIMAX_API_REGION', 'MINIMAX_API_REGION', 'MINIMAX_API_HOST'],
      configDefault: 'auto',
      // An unrelated save must not turn an implicit region into a stored pin.
      initial: '',
      persist: 'renormalize',
      persistFallback: '',
      project: (value, limits, env) => limits.minimaxRegion({ minimaxApiRegion: value }, env)
    },
    {
      key: 'minimaxBillingMode',
      kind: 'setting',
      invalidationSource: 'api',
      normalize: { fn: 'normalizeMinimaxBillingMode', style: 'value' },
      configDefault: 'token-plan',
      initial: 'token-plan',
      persist: 'renormalize',
      persistFallback: 'token-plan',
      project: (value, limits) => limits.normalizeMinimaxBillingMode(value)
    }
  ],
  envProbe: { key: 'minimaxEnvRegion', fn: (env, limits) => limits.minimaxRegion({}, env) },
  status: {
    credential: 'minimaxApiKey',
    configuredKey: 'minimaxApiKeyConfigured',
    sourceKey: 'minimaxApiKeySource',
    pendingKey: 'minimaxPendingCheckSince'
  },
  form: {
    kind: 'custom',
    fields: [
      { key: 'minimaxApiKey', required: true },
      { key: 'minimaxBillingMode', secret: false, submitWithCredential: false },
      { key: 'minimaxApiRegion', secret: false, submitWithCredential: false }
    ]
  },
  urlPolicy: [
    { hosts: ['platform.minimaxi.com'] },
    { hosts: ['platform.minimax.io'] }
  ]
};
