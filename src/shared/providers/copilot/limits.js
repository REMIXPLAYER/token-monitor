'use strict';

// GitHub Copilot quota lookup via the Copilot internal usage API.
// The GitHub OAuth token from device flow is used directly here, matching the
// CodexBar implementation this feature was based on.

const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  errorWithStatus
} = require('../../limits/providerHelpers');
const { hashKey } = require('../../hashKey');

const COPILOT_DEFAULT_HOST = 'github.com';
const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.26.7';
const COPILOT_TOKEN_NAMES = ['COPILOT_API_TOKEN', 'GITHUB_COPILOT_TOKEN'];

function copilotToken(env = process.env, options = {}) {
  const explicit = cleanSecret(options.copilotApiToken || options.copilotToken || '');
  if (explicit) return explicit;
  for (const name of COPILOT_TOKEN_NAMES) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function normalizedEnterpriseHost(raw) {
  let host = String(raw || '').trim();
  if (!host) return COPILOT_DEFAULT_HOST;
  const withScheme = host.includes('://') ? host : `https://${host}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname) return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch (_) {}
  host = host.replace(/^https?:\/\//i, '').split('/')[0] || host;
  return host.replace(/^\.+|\.+$/g, '').toLowerCase() || COPILOT_DEFAULT_HOST;
}

function copilotApiHost(enterpriseHost) {
  const host = normalizedEnterpriseHost(enterpriseHost);
  if (host === COPILOT_DEFAULT_HOST) return 'api.github.com';
  if (host.startsWith('api.')) return host;
  return `api.${host}`;
}

function copilotUsageUrl(enterpriseHost) {
  return `https://${copilotApiHost(enterpriseHost)}/copilot_internal/user`;
}

function decodeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseQuotaSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const decodedEntitlement = decodeNumber(raw.entitlement);
  const decodedRemaining = decodeNumber(raw.remaining);
  const entitlement = decodedEntitlement ?? 0;
  const remaining = decodedRemaining ?? 0;
  const unlimited = raw.unlimited === true;
  let percentRemaining = 0;
  let hasPercentRemaining = false;
  const decodedPercent = decodeNumber(raw.percent_remaining ?? raw.percentRemaining);
  if (unlimited) {
    percentRemaining = 100;
    hasPercentRemaining = true;
  } else if (decodedPercent !== null) {
    percentRemaining = decodedPercent;
    hasPercentRemaining = true;
  } else if (decodedEntitlement !== null && decodedEntitlement > 0 && decodedRemaining !== null) {
    percentRemaining = (remaining / entitlement) * 100;
    hasPercentRemaining = true;
  }
  return {
    entitlement,
    remaining,
    percentRemaining,
    quotaId: String(raw.quota_id || raw.quotaId || '').trim(),
    hasPercentRemaining,
    unlimited,
    entitlementWasDecoded: decodedEntitlement !== null,
    remainingWasDecoded: decodedRemaining !== null
  };
}

function isPlaceholder(snapshot) {
  if (!snapshot) return true;
  if (snapshot.unlimited) return false;
  if (
    snapshot.entitlement === 0 &&
    snapshot.remaining === 0 &&
    snapshot.percentRemaining === 0 &&
    !snapshot.hasPercentRemaining
  ) return true;
  return snapshot.entitlementWasDecoded &&
    snapshot.remainingWasDecoded &&
    snapshot.entitlement === 0 &&
    snapshot.remaining === 0;
}

function usableQuotaSnapshot(snapshot) {
  if (!snapshot || isPlaceholder(snapshot) || !snapshot.hasPercentRemaining) return null;
  return snapshot;
}

function parseQuotaCounts(raw) {
  if (!raw || typeof raw !== 'object') return { chat: null, completions: null };
  return {
    chat: decodeNumber(raw.chat),
    completions: decodeNumber(raw.completions)
  };
}

function makeQuotaSnapshotFromCounts(monthly, limited, quotaId) {
  if (monthly === null || limited === null) return null;
  const entitlement = Math.max(0, monthly);
  if (entitlement <= 0) return null;
  const remaining = Math.max(0, limited);
  return parseQuotaSnapshot({
    entitlement,
    remaining,
    percent_remaining: Math.max(0, Math.min(100, (remaining / entitlement) * 100)),
    quota_id: quotaId
  });
}

function classifyDynamicQuotaKey(key) {
  const name = String(key || '').toLowerCase();
  if (name.includes('chat')) return 'chat';
  if (name.includes('premium') || name.includes('completion') || name.includes('code')) return 'premium';
  return 'other';
}

function parseDirectQuotaSnapshots(raw) {
  if (!raw || typeof raw !== 'object') return { premium: null, chat: null };
  let premium = usableQuotaSnapshot(parseQuotaSnapshot(raw.premium_interactions));
  let chat = usableQuotaSnapshot(parseQuotaSnapshot(raw.chat));
  if (premium || chat) return { premium, chat };

  let fallbackPremium = null;
  let fallbackChat = null;
  let firstUsable = null;
  for (const [key, value] of Object.entries(raw)) {
    const snapshot = usableQuotaSnapshot(parseQuotaSnapshot(value));
    if (!snapshot) continue;
    if (!firstUsable) firstUsable = snapshot;
    const kind = classifyDynamicQuotaKey(key);
    if (kind === 'chat' && !fallbackChat) fallbackChat = snapshot;
    if (kind === 'premium' && !fallbackPremium) fallbackPremium = snapshot;
  }
  return {
    premium: premium || fallbackPremium,
    chat: chat || fallbackChat || ((!premium && !fallbackPremium && !chat && !fallbackChat) ? firstUsable : null)
  };
}

function parseCopilotUsageResponse(data) {
  const source = data && typeof data === 'object' ? data : {};
  const direct = parseDirectQuotaSnapshots(source.quota_snapshots || source.quotaSnapshots);
  const monthly = parseQuotaCounts(source.monthly_quotas || source.monthlyQuotas);
  const limited = parseQuotaCounts(source.limited_user_quotas || source.limitedUserQuotas);
  return {
    premium: direct.premium || usableQuotaSnapshot(makeQuotaSnapshotFromCounts(monthly.completions, limited.completions, 'completions')),
    chat: direct.chat || usableQuotaSnapshot(makeQuotaSnapshotFromCounts(monthly.chat, limited.chat, 'chat')),
    copilotPlan: String(source.copilot_plan || source.copilotPlan || 'unknown').trim() || 'unknown',
    tokenBasedBilling: source.token_based_billing === true || source.tokenBasedBilling === true,
    quotaResetDate: source.quota_reset_date || source.quotaResetDate || null
  };
}

function parseQuotaResetDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const date = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function displayPlanLabel(plan) {
  const raw = String(plan || '').trim().toLowerCase();
  if (!raw || raw === 'unknown') return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function makeRateWindow(snapshot, resetsAt) {
  if (!snapshot) return null;
  const usedPercent = Math.max(0, 100 - snapshot.percentRemaining);
  return {
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, snapshot.percentRemaining)),
    resetsAt: snapshot.unlimited ? null : resetsAt,
    resetDescription: usedPercent > 100 ? `${Math.round(usedPercent)}% used` : '',
    showMeter: true
  };
}

function mapCopilotUsageToProvider(usage, meta = {}) {
  const resetsAt = parseQuotaResetDate(usage.quotaResetDate);
  const premium = makeRateWindow(usage.premium, resetsAt);
  const chat = makeRateWindow(usage.chat, resetsAt);
  const windows = [];
  if (premium) windows.push({ kind: 'billing', label: 'Premium', ...premium });
  if (chat) windows.push({ kind: 'billing', label: 'Chat', ...chat });
  return normalizeLimitProvider({
    provider: 'copilot',
    accountKey: meta.accountKey || '',
    accountLabel: meta.accountLabel || displayPlanLabel(usage.copilotPlan),
    accountName: meta.accountName || '',
    accountEmail: meta.accountEmail || '',
    source: meta.source || 'api',
    status: windows.length > 0 ? 'ok' : 'unavailable',
    updatedAt: meta.updatedAt,
    windows
  });
}

async function fetchJson(url, headers, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, { headers, ...(controller ? { signal: controller.signal } : {}) });
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429
          ? 'sourceRateLimited'
          : 'unavailable';
      throw errorWithStatus(status, `${url} returned ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', `${url} timed out`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function copilotRequestHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `token ${token}`,
    'Editor-Version': 'vscode/1.96.2',
    'Editor-Plugin-Version': 'copilot-chat/0.26.7',
    'User-Agent': COPILOT_USER_AGENT,
    'X-Github-Api-Version': '2025-04-01'
  };
}

async function fetchGitHubIdentity(token, deps = {}) {
  const enterpriseHost = deps.copilotEnterpriseHost;
  const url = enterpriseHost && normalizedEnterpriseHost(enterpriseHost) !== COPILOT_DEFAULT_HOST
    ? `https://${copilotApiHost(enterpriseHost)}/user`
    : 'https://api.github.com/user';
  const data = await fetchJson(url, {
    Accept: 'application/json',
    Authorization: `token ${token}`
  }, deps);
  const login = String(data?.login || '').trim();
  const id = data?.id;
  if (!login && id === undefined) throw errorWithStatus('unavailable', 'GitHub identity missing login');
  return { login, id };
}

async function fetchCopilotUsage(token, deps = {}) {
  const data = await fetchJson(copilotUsageUrl(deps.copilotEnterpriseHost), copilotRequestHeaders(token), deps);
  const usage = parseCopilotUsageResponse(data);
  if (!usage.premium && !usage.chat) {
    if (usage.tokenBasedBilling) return usage;
    throw errorWithStatus('unavailable', 'Copilot usage response missing usable quotas');
  }
  return usage;
}

function providerStatusFromError(error) {
  const status = error && error.status;
  if (['disabled', 'notConfigured', 'unauthorized', 'rateLimited', 'sourceRateLimited', 'unavailable', 'error'].includes(status)) {
    return status;
  }
  return 'unavailable';
}

function configuredCopilotAccounts(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const accounts = [];
  const seenTokens = new Set();
  const autoToken = copilotToken(env, options);
  if (autoToken) {
    accounts.push({ token: autoToken, source: 'auto' });
    seenTokens.add(autoToken);
  }
  for (const [login, profile] of Object.entries(options.copilotProfiles || {})) {
    const name = String(login || '').trim();
    const token = cleanSecret(profile?.apiToken);
    if (!name || !token || profile?.enabled === false || seenTokens.has(token)) continue;
    seenTokens.add(token);
    accounts.push({ name, token, source: 'profile' });
  }
  return accounts;
}

function copilotScopeAccounts(accounts, scope) {
  const profiles = accounts.filter((account) => account.source === 'profile');
  const accountKey = String(scope.accountKey || '').trim();
  if (accountKey) {
    const matched = profiles.filter((account) => hashKey('copilot', account.name) === accountKey);
    // An unmatched key is the auto lane, whose key is only known after /user;
    // manual keys are known up front and must match exactly.
    return matched.length > 0 ? matched : accounts.filter((account) => account.source === 'auto');
  }
  const accountName = String(scope.accountName || scope.accountLabel || '').trim();
  if (accountName) return profiles.filter((account) => account.name === accountName);
  return accounts;
}

async function fetchCopilotAccount(account, requestDeps, updatedAt) {
  const { token, name = '', source } = account;
  const keySeed = source === 'profile' ? name : '';
  try {
    const [usage, identity] = await Promise.all([
      fetchCopilotUsage(token, requestDeps),
      fetchGitHubIdentity(token, requestDeps).catch(() => ({ login: '', id: null }))
    ]);
    const login = String(name || identity.login || '').trim();
    const accountSeed = keySeed || login || (identity.id != null ? String(identity.id) : '');
    return mapCopilotUsageToProvider(usage, {
      accountKey: hashKey('copilot', accountSeed || token.slice(0, 8)),
      accountLabel: displayPlanLabel(usage.copilotPlan),
      accountName: login,
      accountEmail: '',
      updatedAt,
      source: 'api'
    });
  } catch (error) {
    const accountSeed = keySeed || token.slice(0, 8);
    return normalizeLimitProvider({
      provider: 'copilot',
      accountKey: hashKey('copilot', accountSeed),
      // Keep the login on failure so the row is still labelled.
      accountName: name || '',
      source: 'api',
      status: providerStatusFromError(error),
      updatedAt,
      windows: []
    });
  }
}

async function fetchCopilotLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const nowMs = (deps.now || Date.now)();
  const updatedAt = new Date(nowMs).toISOString();
  const enterpriseHost = options.copilotEnterpriseHost || env.COPILOT_ENTERPRISE_HOST || env.GITHUB_ENTERPRISE_HOST || '';
  const requestDeps = { ...deps, copilotEnterpriseHost: enterpriseHost };

  const notConfigured = () => normalizeLimitProvider({
    provider: 'copilot',
    source: 'api',
    status: 'notConfigured',
    updatedAt,
    windows: []
  });

  if (deps.probe) {
    const token = copilotToken({}, options);
    if (!token) return notConfigured();
    return fetchCopilotAccount({ token, source: 'auto' }, requestDeps, updatedAt);
  }

  const accounts = configuredCopilotAccounts(options, deps);
  if (!accounts.length) return notConfigured();

  const scope = options.limitRefreshScope?.provider === 'copilot' ? options.limitRefreshScope : null;
  const selected = scope ? copilotScopeAccounts(accounts, scope) : accounts;
  if (!selected.length) return notConfigured();

  const rows = (await Promise.all(
    selected.map((account) => fetchCopilotAccount(account, requestDeps, updatedAt))
  )).filter(Boolean);

  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    if (row.accountKey && seen.has(row.accountKey)) continue;
    if (row.accountKey) seen.add(row.accountKey);
    deduped.push(row);
  }
  // Keep the historical single-object return when one account answers, so
  // existing callers and tests do not need to treat one row as an array.
  return deduped.length === 1 ? deduped[0] : deduped;
}

module.exports = {
  COPILOT_DEFAULT_HOST,
  copilotToken,
  normalizedEnterpriseHost,
  copilotApiHost,
  copilotUsageUrl,
  parseQuotaSnapshot,
  isPlaceholder,
  parseCopilotUsageResponse,
  parseQuotaResetDate,
  mapCopilotUsageToProvider,
  fetchCopilotUsage,
  fetchCopilotLimits
};
