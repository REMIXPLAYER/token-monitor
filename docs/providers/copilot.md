---
summary: GitHub Copilot auto and manual account lanes, identity and credentials
ids: [copilot]
read_when:
  - Changing Copilot limits, credentials, account identity or display
---

# GitHub Copilot

## Identity and lanes

Copilot has two independent credentials lanes:

- The **auto lane**: one GitHub device-flow token stored as `copilotApiToken`, or the environment fallback when no token is stored. This lane is a single account and its sign-in flow is unchanged.
- The **manual lane**: user-added tokens in `copilotProfiles`, keyed by the GitHub login the token resolves to. Each entry is `{ apiToken, enabled }`.

The manual lane follows the named-profile pattern shared with OpenRouter and ThirdParty. A profile's key is the server-issued login; it is also the account's display name. The key is hashed into the portable `accountKey`, which is the row identity and the scoped-refresh address. Profiles are not renamed, because the server owns that identity while the key is the map key.

`accountKey` hashes the GitHub login. It is the same on every device, so the same account merges across devices while two logins remain two rows.

## Credentials and saving

Both lanes live in `credentials.json` through their declared `storePath`s; the renderer only receives a redacted profile map and never a raw token. Adding a manual token probes the provider with that token alone and stores it only when the probe answers `ok` with a usable login. A rejected token is `invalidToken`; a failed or unreachable probe is `unavailable`; a token already in the auto lane is `alreadyConnected`. The probe's `ok` status covers both the usage endpoint and `/user`, so a token with no Copilot entitlement cannot be added.

`COPILOT_API_TOKEN` and `GITHUB_COPILOT_TOKEN` remain environment fallbacks for the auto lane. Manual profiles do not suppress them; the fetcher merges both lanes and de-duplicates by token, then by `accountKey` with the auto lane first.

## Endpoints and host

The global `copilotEnterpriseHost` setting stays global: identity, quota and device-flow URLs all derive from it, and manual profiles use the same host. Per-account hosts (github.com plus a GHES host at the same time) are not supported.

## Refresh and invalidation

Adding, removing or enabling a manual profile invalidates only that account's keyed identity. The provider declares `accountRefresh: true`, so a quota row's refresh button probes only the account it names: a manual profile matches by its `accountKey`, while an unmatched key is treated as the auto lane whose key is only known after `/user`. Sign-in and sign-out stay provider-wide.

## Known gap

When the desktop widget and a headless agent upload for the same device and the agent reports no Copilot token, the merged device record retains only one account. Multi-account GUI-secret providers share this merge behavior (MiniMax does too); it is tracked separately from the manual-profile work.

## Verification

- `tests/shared/copilotLimits.test.js`
- `tests/electron/copilotProfiles.test.js`
- `tests/electron/copilotSettings.test.js`
- `node --test tests/shared/limits.test.js` (aggregation)
