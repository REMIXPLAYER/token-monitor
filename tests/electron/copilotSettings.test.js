'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return source.slice(start, end);
}

test('Copilot settings provide a manual account list beside the GitHub sign-in lane', () => {
  const html = read('src/electron/renderer/index.html');
  const app = read('src/electron/renderer/app.js');
  const preload = read('src/electron/preload.js');

  assert.match(html, /id="copilotAccountGroup"/);
  assert.match(html, /id="copilotProfileList" class="opencode-profile-list"/);
  assert.match(html, /id="copilotApiTokenInput"/);
  assert.match(html, /id="copilotApiTokenSubmit"/);

  assert.match(app, /function renderCopilotProfiles\(\)/);
  assert.match(app, /providerId: 'copilot'/);
  assert.match(app, /canRename: false/);
  assert.match(app, /function updateCopilotProfileRows\(\)/);
  assert.match(app, /function refreshCopilotProfileStatus\(\)/);
  assert.match(app, /window\.tokenMonitor\.copilot\.saveProfile\(input\.value\)/);
  assert.doesNotMatch(app, /saveSettings\(\{ copilotApiToken: input\.value \}\)/);

  assert.match(preload, /getProfiles: \(\) => ipcRenderer\.invoke\('copilot:getProfiles'\)/);
  assert.match(preload, /saveProfile: \(token\) => ipcRenderer\.invoke\('copilot:saveProfile', token\)/);
  assert.match(preload, /deleteProfile: \(login\) => ipcRenderer\.invoke\('copilot:deleteProfile', login\)/);
  assert.match(preload, /setProfileEnabled: \(login, enabled\) => ipcRenderer\.invoke\('copilot:setProfileEnabled', login, enabled\)/);
});

test('Copilot manual profile status settles when refreshed stats arrive', () => {
  const app = read('src/electron/renderer/app.js');
  const statsRender = app.slice(
    app.indexOf('function renderStatsUpdate()'),
    app.indexOf('const statsRenderScheduler =')
  );
  assert.match(statsRender, /updateCopilotProfileRows\(\)/);
  assert.match(statsRender, /renderCopilotStatus\(\)/);
});

test('Copilot account status counts the manual lane instead of reading it as unconfigured', () => {
  const app = read('src/electron/renderer/app.js');
  const renderBody = functionBody(app, 'renderCopilotStatus', 'renderOpenCodeProfiles');
  assert.match(renderBody, /const manualCount = state\.copilotProfileCount \|\| 0;/);
  assert.match(renderBody, /manualCount > 0/);
  assert.match(renderBody, /settings\.copilot\.connected/);
  assert.match(renderBody, /refreshBtn\.classList\.toggle\('hidden', total === 0/);
  assert.doesNotMatch(renderBody, /manualPanel\.classList\.toggle\('hidden'/);
});

test('Copilot manual profiles are redacted before they reach the renderer', () => {
  const { accountFieldProjection, redactCopilotProfilesForRenderer } = require('../../src/electron/limits/accountSettings');
  const redacted = redactCopilotProfilesForRenderer({
    octocat: { apiToken: 'private-token', enabled: true }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(redacted)), {
    octocat: { apiToken: 'set', enabled: true }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(accountFieldProjection({
    copilotProfiles: { octocat: { apiToken: 'private-token', enabled: true } }
  }).copilotProfiles)), { octocat: { apiToken: 'set', enabled: true } });
  assert.equal(JSON.stringify(accountFieldProjection({
    copilotProfiles: { octocat: { apiToken: 'private-token' } }
  })).includes('private-token'), false);
});

test('Copilot manual profile IPC uses the strict probe and never echoes raw tokens', () => {
  const main = read('src/electron/main.js');
  const handler = main.slice(
    main.indexOf("ipcMain.handle('copilot:saveProfile'"),
    main.indexOf("ipcMain.handle('copilot:deleteProfile'")
  );
  const profiles = read('src/electron/providers/copilot/profiles.js');

  assert.match(main, /redactCopilotProfilesForRenderer/);
  assert.match(main, /hasEnvVar: false/);
  assert.match(main, /copilot:getProfiles/);
  assert.match(main, /copilot:deleteProfile/);
  assert.match(main, /copilot:setProfileEnabled/);
  assert.match(profiles, /provider\?\.status !== 'ok'/);
  assert.match(profiles, /env: \{\}, probe: true/);
  assert.match(profiles, /errorCode: provider\?\.status === 'unauthorized' \? 'invalidToken' : 'unavailable'/);
  assert.doesNotMatch(handler, /apiToken/);
});
