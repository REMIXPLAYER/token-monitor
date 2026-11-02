'use strict';

// Legacy declarative-form contract fixture; credentials are never included.
const declarations = require('../../src/shared/providers/minimax/account');
const regionUrls = {
  cn: 'https://platform.minimaxi.com/user-center/payment/token-plan',
  intl: 'https://platform.minimax.io/user-center/payment/token-plan'
};
module.exports = {
  id: 'minimax', kind: 'credential', status: declarations.status,
  titleKey: 'settings.minimax.title', openKey: 'settings.minimax.openBrowser',
  clearKey: 'settings.minimax.clearApiKey', saveKey: 'settings.minimax.saveApiKey',
  emptyKey: 'settings.minimax.statusNotSet', failedKey: 'settings.minimax.saveFailed',
  fields: [
    { key: 'minimaxBillingMode', input: 'select', secret: false, labelKey: 'settings.minimax.billingMode',
      saveOnChange: true, submitWithCredential: false, options: [
        { value: 'token-plan', labelKey: 'settings.minimax.billingTokenPlan' },
        { value: 'api', labelKey: 'settings.minimax.billingApi' }
      ] },
    { key: 'minimaxApiRegion', input: 'select', secret: false, labelKey: 'settings.minimax.apiRegion',
      saveOnChange: true, submitWithCredential: false, options: [
        { value: 'auto', labelKey: 'settings.minimax.regionAuto' },
        { value: 'cn', labelKey: 'settings.minimax.regionCn' },
        { value: 'intl', labelKey: 'settings.minimax.regionIntl' }
      ] },
    { key: 'minimaxApiKey', input: 'password', secret: true, required: true, placeholderKey: 'settings.minimax.apiKeyPlaceholder' }
  ],
  top: [{ field: 'minimaxBillingMode' }, { field: 'minimaxApiRegion' },
    { note: 'settings.minimax.spendNote', when: { field: 'minimaxBillingMode', values: ['api'] } }],
  manual: [{ note: 'settings.minimax.note' }, { field: 'minimaxApiKey' }],
  openUrl: { byField: 'minimaxApiRegion', urls: regionUrls, default: regionUrls.cn,
    byStatus: 'region', statusUrls: { cn: regionUrls.cn, en: regionUrls.intl },
    pathByField: { byField: 'minimaxBillingMode',
      values: { 'token-plan': '/user-center/payment/token-plan', api: '/user-center/payment/balance' } } }
};
