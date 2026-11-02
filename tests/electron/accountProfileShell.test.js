'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const accountShellApi = require('../../src/electron/renderer/limits/accountShell');
const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
const i18n = require('../../src/electron/renderer/i18n');
const t = (key, values) => i18n.translate('en', key, values);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function minimaxPanelHarness() {
  const element = () => {
    const node = { value: '', textContent: '', dataset: {}, attributes: {}, children: [], listeners: {},
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      setAttribute(key, value) { this.attributes[key] = value; }, focus() {}, select() {},
      click() { return this.listeners.click?.({ currentTarget: this }); } };
    let classes = new Set();
    Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: value => { classes = new Set(value.split(/\s+/)); } });
    node.classList = { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name) };
    return node;
  };
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="(minimax[^" ]+)"[^>]*>/g)) {
    const node = element();
    node.className = match[0].match(/class="([^"]*)"/)?.[1] || '';
    if (match[0].startsWith('<select')) node.value = html.slice(match.index).match(/<option value="([^"]*)"/)[1];
    elements.set(match[1], node);
  }
  const get = id => { assert.ok(elements.has(id), `${id} must exist in the real markup`); return elements.get(id); };
  const walk = node => [node, ...node.children.flatMap(walk)];
  const infos = () => walk(get('minimaxProfileList')).filter(node => node.dataset.managedProfileProvider === 'minimax');
  const saves = [], opened = [], refreshes = [];
  const state = { settings: { minimaxApiRegion: 'cn', minimaxEnvRegion: 'intl', minimaxBillingMode: 'token-plan' } };
  const api = { getProfiles: async () => ({ profiles: {}, hasEnvVar: false }), saveProfile: async () => ({ ok: true }) };
  let providers = [], enabled = true;
  const context = {
    state, accountShellApi, accountShellErrors: {}, accountProfileRequests: accountShellApi.createRequestGuard(),
    accountProfileSaves: accountShellApi.createBusyGuard(),
    limitProviderPresentationApi: require('../../src/electron/renderer/limits/providerPresentation'),
    t, isSettingsSurfaceVisible: () => true, renderSettingsSummaries() {}, refreshStats: async () => {},
    setExternalAccountExpanded: (_id, value) => { state.minimaxAccountExpanded = value; },
    refreshLimitProviderQuota: id => refreshes.push(id),
    localProviderStatuses: () => providers, limitProviderEnabled: () => enabled,
    document: { getElementById: get, createElement: element,
      querySelectorAll: () => infos().filter(node => Object.hasOwn(node.dataset, 'managedProfileName')),
      querySelector: () => infos().find(node => node.dataset.managedProfileEnvironment) },
    window: { tokenMonitor: { openExternal: url => opened.push(url), minimax: {
      ...api, getProfiles: () => api.getProfiles(), saveProfile: draft => { saves.push(draft); return api.saveProfile(draft); }
    } } }
  };
  const names = ['setAccountShellError', 'renderAccountShellError', 'minimaxBillingUrl', 'updateNamedApiProfilesStatus',
    'updateMinimaxProfilesStatus', 'minimaxProfileErrorText', 'appendNamedApiProfileRow', 'renderNamedApiProfiles', 'renderMinimaxProfiles'];
  const functions = names.map(name => {
    const start = app.indexOf(`function ${name}(`);
    return app.slice(start, app.indexOf('\n}\n', start) + 2);
  }).join('\n');
  const start = app.indexOf("  const minimaxToggle = document.getElementById('minimaxSettingsToggle');");
  vm.runInNewContext(`${functions}\n${app.slice(start, app.indexOf('\n  }\n', start) + 5)}`, context);
  return { get, api, saves, opened, refreshes, state, infos,
    links: () => walk(get('minimaxProfileList')).filter(node => node.className === 'profile-open'),
    render: async () => { context.renderMinimaxProfiles(); await settle(); },
    status: (rows, on = true) => { providers = rows; enabled = on; context.updateMinimaxProfilesStatus(); },
    draft: values => { for (const [id, value] of Object.entries(values)) get(id).value = value; } };
}

test('MiniMax current form submits billing and region atomically, blocks duplicate saves and preserves newer drafts', async () => {
  const h = minimaxPanelHarness();
  h.draft({ minimaxProfileName: 'work', minimaxApiKeyInput: 'work-secret', minimaxBillingModeInput: 'api', minimaxApiRegionInput: 'cn' });
  const pending = deferred();
  h.api.saveProfile = () => pending.promise;
  const saving = h.get('minimaxProfileSubmit').click();
  assert.equal(h.get('minimaxProfileSubmit').disabled, true);
  await h.get('minimaxProfileSubmit').click();
  assert.equal(h.saves.length, 1);
  assert.deepEqual({ ...h.saves[0] }, { name: 'work', apiKey: 'work-secret', billingMode: 'api', apiRegion: 'cn' });
  h.draft({ minimaxProfileName: 'personal', minimaxApiKeyInput: 'personal-secret', minimaxApiRegionInput: 'intl' });
  await h.render();
  pending.resolve({ ok: true });
  await saving;
  assert.equal(h.get('minimaxProfileSubmit').disabled, false);
  assert.equal(h.get('minimaxProfileName').value, 'personal');
  assert.equal(h.get('minimaxApiKeyInput').value, 'personal-secret');
  assert.equal(h.get('minimaxApiRegionInput').value, 'intl');
  await h.get('minimaxProfileSubmit').click();
  assert.deepEqual({ ...h.saves[1] }, { name: 'personal', apiKey: 'personal-secret', billingMode: 'api', apiRegion: 'intl' });
  assert.equal(h.get('minimaxProfileName').value, '');
  assert.equal(h.get('minimaxApiKeyInput').value, '');
});

test('MiniMax current form retains a rejected draft and allows recovery', async () => {
  const h = minimaxPanelHarness();
  h.draft({ minimaxProfileName: 'work', minimaxApiKeyInput: 'bad-key', minimaxApiRegionInput: '' });
  for (const [result, message] of [
    [{ ok: false, status: 'required' }, 'settings.minimax.statusNotSet'],
    [{ ok: false, status: 'unauthorized' }, 'settings.minimax.invalidKey'],
    [{ ok: false, error: 'disk full' }, null]
  ]) {
    h.api.saveProfile = async () => result;
    await h.get('minimaxProfileSubmit').click();
    assert.equal(h.get('minimaxErrorMessage').textContent, message ? t(message) : 'disk full');
    assert.equal(h.get('minimaxProfileSubmit').disabled, false);
    assert.equal(h.get('minimaxApiKeyInput').value, 'bad-key');
    assert.equal(h.get('minimaxApiRegionInput').value, '');
    await h.render();
    assert.equal(h.get('minimaxErrorMessage').classList.contains('hidden'), false);
  }
  h.api.saveProfile = async () => ({ ok: true });
  await h.get('minimaxProfileSubmit').click();
  assert.equal(h.get('minimaxErrorMessage').textContent, '');
  assert.equal(h.get('minimaxApiKeyInput').value, '');
});

test('MiniMax profile status and billing links use API rows independently of Code and the account draft', async () => {
  const h = minimaxPanelHarness();
  const profiles = { work: { enabled: true, apiRegion: 'auto', billingMode: 'api' },
    personal: { enabled: false, apiRegion: 'cn', billingMode: 'token-plan' } };
  h.api.getProfiles = async () => ({ profiles, hasEnvVar: true });
  await h.render();
  const info = name => h.infos().find(node => node.dataset.managedProfileName === name);
  for (const [status, message] of [['ok', '✓'], ['unauthorized', t('settings.minimax.invalidKey')], ['unavailable', t('settings.minimax.unavailable')]]) {
    h.status([{ source: 'oauth', status: 'ok', accountName: 'work' }, { source: 'api', accountName: 'work', region: 'en', status }]);
    assert.equal(info('work').textContent, message);
    assert.equal(info('personal').textContent, t('settings.profiles.disabled'));
  }
  h.status([{ source: 'oauth', status: 'ok', accountName: 'work' }]);
  assert.equal(info('work').textContent, t('settings.minimax.checking'));
  assert.equal(h.get('minimaxStatus').textContent, t('settings.minimax.connected', { linked: 0, total: 3 }));
  h.status([], false);
  assert.equal(info('work').textContent, '');
  assert.equal(h.get('minimaxStatus').textContent, t('settings.minimax.nAccounts', { count: 3 }));
  const buttons = h.links();
  h.status([{ source: 'api', accountName: 'work', region: 'en', status: 'ok' }]);
  assert.equal(h.get('minimaxStatus').textContent, t('settings.minimax.connected', { linked: 1, total: 3 }));
  buttons[0].click(); buttons[1].click(); buttons[2].click();
  assert.deepEqual(h.opened, ['https://platform.minimax.io/user-center/payment/balance',
    'https://platform.minimaxi.com/user-center/payment/token-plan', 'https://platform.minimaxi.com/user-center/payment/token-plan']);
  h.get('minimaxAddToggle').click();
  for (const [region, expected] of [['intl', 'minimax.io'], ['cn', 'minimaxi.com'], ['', 'minimax.io'], ['auto', 'minimax.io']]) {
    h.draft({ minimaxProfileName: 'work', minimaxApiRegionInput: region, minimaxBillingModeInput: 'api' });
    h.get('minimaxOpenBrowser').click();
    assert.equal(h.opened.at(-1), `https://platform.${expected}/user-center/payment/balance`);
  }
  h.get('minimaxRefreshButton').click();
  assert.deepEqual(h.refreshes, ['minimax']);
  h.api.getProfiles = async () => ({ profiles: { personal: profiles.personal }, hasEnvVar: false });
  await h.render();
  h.get('minimaxAddToggle').click();
  h.get('minimaxProfileName').value = '';
  h.get('minimaxOpenBrowser').click();
  assert.equal(h.opened.at(-1), 'https://platform.minimaxi.com/user-center/payment/token-plan');
  h.api.getProfiles = async () => ({ profiles: {}, hasEnvVar: false });
  await h.render();
  assert.equal(h.get('minimaxStatus').textContent, t('settings.minimax.statusNotSet'));
});

test('MiniMax key hints cover both key types and Spend scope remains outside the add form', () => {
  const placeholder = html.match(/id="minimaxApiKeyInput"[^>]*data-i18n-placeholder="([^"]+)"/)[1];
  for (const locale of Object.keys(i18n.MESSAGES)) {
    assert.match(i18n.translate(locale, placeholder), /sk-cp-/);
    assert.match(i18n.translate(locale, placeholder), /sk-api-/);
    assert.notEqual(i18n.translate(locale, 'settings.minimax.spendNote'), 'settings.minimax.spendNote');
  }
  assert.ok(html.indexOf('data-i18n="settings.minimax.spendNote"') < html.indexOf('id="minimaxAddForm"'));
});

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function namedProfilesHarness() {
  const source = app.slice(app.indexOf('function renderNamedApiProfiles('), app.indexOf('function renderOpenRouterProfiles('));
  const lists = new Map(['openrouter', 'thirdparty'].map((id) => [id, {
    children: [],
    replaceChildren() { this.children = []; },
    append(node) { this.children.push(node); }
  }]));
  const statuses = new Map(['openrouter', 'thirdparty'].map((id) => [id, { textContent: '' }]));
  const errors = new Map(['openrouter', 'thirdparty'].map((id) => [id, { textContent: '', classList: { toggle() {} } }]));
  const requests = { openrouter: [], thirdparty: [] };
  const state = { settings: {}, openrouterProfileCount: -1, thirdpartyProfileCount: -1 };
  let visible = true;
  let summaryRenders = 0;
  const context = {
    state,
    accountProfileRequests: accountShellApi.createRequestGuard(),
    accountShellApi,
    accountShellErrors: { openrouter: 'Failed to rename' },
    isSettingsSurfaceVisible: () => visible,
    renderSettingsSummaries: () => { summaryRenders += 1; },
    t: (key) => key,
    document: {
      getElementById(id) {
        for (const [provider, list] of lists) {
          if (id === `${provider}ProfileList`) return list;
          if (id === `${provider}Status`) return statuses.get(provider);
          if (id === `${provider}ErrorMessage`) return errors.get(provider);
        }
        return null;
      },
      createElement() { return { className: '', textContent: '' }; }
    }
  };
  const shellErrorSource = app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const { clientColors, fallbackModelColors'));
  vm.runInNewContext(`${shellErrorSource}\n${source}\nthis.renderNamedApiProfiles = renderNamedApiProfiles;`, context);
  const render = (providerId) => context.renderNamedApiProfiles({
    providerId,
    profileSettingsKey: `${providerId}Profiles`,
    envConfiguredKey: `${providerId}EnvConfigured`,
    profileCountStateKey: `${providerId}ProfileCount`,
    api: { getProfiles: () => {
      const request = deferred();
      requests[providerId].push(request);
      return request.promise;
    } },
    updateStatus() {}
  });
  return {
    render, requests, lists, statuses, errors, state,
    setError: (providerId, message) => context.setAccountShellError(providerId, message),
    setVisible: (value) => { visible = value; },
    summaries: () => summaryRenders
  };
}

test('profile list ignores older responses and preserves shell errors across settings redraws', async () => {
  const harness = namedProfilesHarness();
  harness.render('openrouter');
  harness.render('openrouter');
  harness.requests.openrouter[1].resolve({ profiles: {}, hasEnvVar: false });
  await settle();
  assert.equal(harness.state.openrouterProfileCount, 0);
  assert.equal(harness.lists.get('openrouter').children.length, 1);
  assert.equal(harness.errors.get('openrouter').textContent, 'Failed to rename');
  harness.setError('openrouter', 'Save failed');
  assert.equal(harness.errors.get('openrouter').textContent, 'Save failed');
  harness.requests.openrouter[0].resolve({ profiles: { stale: {} }, hasEnvVar: true });
  await settle();
  assert.equal(harness.state.openrouterProfileCount, 0);
  assert.equal(harness.summaries(), 1);
  harness.render('openrouter');
  assert.equal(harness.errors.get('openrouter').textContent, 'Save failed');
  harness.requests.openrouter[2].resolve({ profiles: {}, hasEnvVar: false });
  await settle();
});

test('profile list isolates providers and ignores stale failures and hidden responses', async () => {
  const harness = namedProfilesHarness();
  harness.render('openrouter');
  harness.render('thirdparty');
  harness.render('openrouter');
  harness.requests.openrouter[0].reject(new Error('stale'));
  harness.requests.thirdparty[0].resolve({ profiles: {}, hasEnvVar: false });
  await settle();
  assert.equal(harness.state.thirdpartyProfileCount, 0);
  assert.equal(harness.statuses.get('openrouter').textContent, '');
  harness.setVisible(false);
  harness.requests.openrouter[1].resolve({ profiles: {}, hasEnvVar: false });
  await settle();
  assert.equal(harness.state.openrouterProfileCount, -1);
});

test('Cursor retires a failed manual login message when status is refreshed', async () => {
  const errors = { textContent: '', classList: { toggle(name, hidden) { this.hidden = hidden; } } };
  const statusPill = { textContent: '', title: '' };
  const accountList = { children: [], replaceChildren() { this.children = []; }, append(node) { this.children.push(node); } };
  const manualInput = { value: 'bad session' };
  const manualSubmit = { addEventListener(type, handler) { if (type === 'click') this.click = handler; } };
  const elements = {
    cursorErrorMessage: errors,
    cursorAccountStatus: statusPill,
    cursorAccountList: accountList,
    cursorManualSubmit: manualSubmit,
    cursorManualInput: manualInput
  };
  const statusRequest = deferred();
  const state = { cursorAccount: { status: null, error: '', busy: false } };
  const context = {
    state,
    accountShellApi,
    accountShellErrors: Object.create(null),
    accountProfileSaves: accountShellApi.createBusyGuard(),
    isSettingsSurfaceVisible: () => true,
    setCursorStatusText: (element, value) => { element.textContent = value; element.title = value; },
    setCursorCheckboxesEnabled() {},
    renderSettingsSummaries() {},
    t: (key, values) => values?.message ? `${key}: ${values.message}` : key,
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: () => ({ className: '', textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, append() {} })
    },
    window: { tokenMonitor: { cursor: {
      loginManual: async () => ({ ok: false, error: 'Invalid session' }),
      status: () => statusRequest.promise
    } } }
  };
  const shellErrorSource = app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const { clientColors, fallbackModelColors'));
  const renderSource = app.slice(app.indexOf('function renderCursorStatus('), app.indexOf('function setCursorCheckboxesEnabled('));
  const submitSource = app.slice(app.indexOf('  const cursorManualSubmit ='), app.indexOf('  refreshCursorStatus({ discover: true });', app.indexOf('  const cursorManualSubmit =')));
  vm.runInNewContext(`${shellErrorSource}\n${renderSource}\n${submitSource}\nthis.refreshCursorStatus = refreshCursorStatus; this.renderCursorStatus = renderCursorStatus;`, context);

  await manualSubmit.click();
  assert.equal(errors.textContent, 'settings.cursor.loginFailed: Invalid session');
  context.renderCursorStatus();
  assert.equal(errors.textContent, 'settings.cursor.loginFailed: Invalid session');

  const refresh = context.refreshCursorStatus({ discover: true });
  assert.equal(errors.textContent, '');
  statusRequest.resolve({ accounts: [{ id: 'manual', email: 'user@example.com', enabled: true }], linkedCount: 1 });
  await refresh;
  assert.equal(statusPill.textContent, 'settings.cursor.connected');
  assert.equal(errors.textContent, '');
  assert.equal(errors.classList.hidden, true);
});

test('OpenCode status ignores an older probe after a newer status resolves', async () => {
  const source = app.slice(app.indexOf('async function updateOpenCodeProfilesStatus('), app.indexOf('function renderOpenCodeProfilesStatusSummary('));
  const requests = [];
  const info = { textContent: '' };
  const summaries = [];
  const context = {
    accountProfileStatuses: accountShellApi.createRequestGuard(),
    isSettingsSurfaceVisible: () => true,
    window: { tokenMonitor: { opencode: { status() {
      const request = deferred();
      requests.push(request);
      return request.promise;
    } } } },
    opencodeRowId: (prefix, name) => `${prefix}${name}`,
    document: { getElementById: (id) => id === 'opencode-info-main' ? info : null },
    t: (key) => key,
    renderOpenCodeProfilesStatusSummary: (profiles) => summaries.push(profiles)
  };
  vm.runInNewContext(`${source}\nthis.updateOpenCodeProfilesStatus = updateOpenCodeProfilesStatus;`, context);
  const older = context.updateOpenCodeProfilesStatus();
  const newer = context.updateOpenCodeProfilesStatus();
  requests[1].resolve({ profiles: { main: { expired: true } } });
  await newer;
  assert.equal(info.textContent, 'settings.opencode.statusExpired');
  requests[0].resolve({ profiles: { main: { disabled: true } } });
  await older;
  assert.equal(info.textContent, 'settings.opencode.statusExpired');
  assert.equal(summaries.length, 1);
});
