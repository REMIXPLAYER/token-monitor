---
summary: MiniMax independent Code and API lanes, resource units and credential ownership
ids: [minimax]
read_when:
  - Changing MiniMax limits, credentials, account identity, source selection or display
---

## Sources and resource pools

MiniMax Code OAuth and API keys are independent readings. Each key's billing type selects the Token Plan reader (`token-plan`, the default) or API billing (`api`); `minimaxBillingMode` remains the legacy/environment setting. Code uses the current local login regardless of those choices. Key changes never select or sign out Code. Key prefixes do not override the selected billing type, and Token Plan and API billing never fall back to each other. `MINIMAX_CODING_API_KEY` remains the environment credential.

| Lane | Credential | Readings |
| --- | --- | --- |
| Token Plan | API key with `token-plan` selected | Quota authorized by that key, with the existing legacy Coding Plan fallback |
| API | API key with `api` selected | API wallet balance and optional server-reported cash Spend |
| Code | Current local MiniMax Code OAuth login | Code points and applicable Code plan quotas |

M Plan and retained Token Plan subscriptions have distinct benefits; retaining Token Plan or upgrading to M Plan is a server-side subscription choice. Their keys use the subscription quota reader, but a shared endpoint does not prove that keys are interchangeable, that an old key survives an upgrade, or that one key can observe two subscriptions. The compatibility setting `token-plan` selects the supplied subscription key's quota reader, not a product generation or a combined allowance. The `5h` and `Weekly` windows constrain the credential's current subscription; endpoint paths containing `token_plan`, the authentication source and the mere presence of those windows do not identify its generation or prove separate pools. Use the matched current subscription's type/title for that distinction, never the catalog's new-plan availability flag. Do not create an additional M Plan lane or add overlapping observations as extra allowance.

The producer of a request, the credential used to observe it, and the resource paying for it are different facts. Never assign cost from the client name, login method or token count. A Code action may consume quota, points, vouchers or cash; use the relevant server reading.

Code points use `CREDITS`, never CNY/USD. Membership's `op_credit_summary.total_remaining_amount` already combines purchased and gifted points: component balances must not be added again or emitted as independent balances. Purchased points are shared between Code and Open Platform; gifted check-in points are Code-only. Plan quotas and the pay-as-you-go cash wallet remain separate pools. Eligible Code points can cover usage after a plan limit when the user's fallback setting allows it; grants are consumed by expiry order, not an assumed paid-first or gifted-first rule.

## API keys

Add each API key with its billing type; no user-defined account name is needed. New keys use Auto region discovery. Readding the same key updates its entry instead of collecting it twice. Removing a saved key never signs out Code. Environment credentials are read-only in settings. Different credentials may observe the same wallet; never sum their balances or allowances.

The settings list labels each saved key `Account N` in saved order and the environment credential `Environment`. These are display labels; limits surfaces still group readings by confirmed GroupId.

Existing `minimaxApiKey`, billing and region settings remain readable without a startup migration. An explicit key change imports the legacy key into the shared credential store, preserving its billing type and region, including an unset region that follows the environment. Previously saved key entries and disabled flags remain readable; explicitly readding a disabled key enables it. Raw keys never return to the renderer.

An explicit legacy key continues to override the environment key. With multiple saved keys, a distinct environment key is an additional source. Identical credentials are collected once; a disabled saved key blocks that credential from returning through legacy or environment fallback. Removing its saved entry releases the fallback.

Saving a key selects MiniMax and enables limits, following shared credential-save behavior. Removing a key preserves the provider selection and global limits switch. Save-time probes validate only the supplied API key, without Code or Spend. Invalid credentials are rejected; an indeterminate response follows the shared save policy. Code discovery runs once, independently of the number of API keys. Refresh and region memory belong to each credential.

## Wallet and Spend

API wallet balance comes from `/account/query_balance.available_amount`, including usable vouchers, rather than `cash_balance` alone. It is one `credits` window in CNY for China or USD for International. Zero and negative balances are valid; a missing or nonnumeric amount is unavailable. Balance and cash Spend measure different things and must not be subtracted to reconstruct transactions.

| Spend field | Server source |
| --- | --- |
| Today | `/account/amount`, dated `aggregate=true`, `consume_cash_sum` |
| Week | The same aggregate over seven calendar dates including today |
| Month | The same aggregate from the first calendar date of the month |
| All time | `/account/amount`, undated `aggregate=true`, `consume_cash_sum` |

Periods use the console's calendar-date filters. Bills refresh daily and can lag the current wallet. Every Spend figure is `consume_cash_sum`, the pre-voucher total. All time is that field with no dates. It is not `cash_total_usage` from the recharge query and not a sum of page rows. Voucher summary counters are not consumption totals for the selected issuance dates.

Spend values are replacement snapshots, not increments or estimates from balance changes. They use the balance reading's key, resolved region and injected transport. A failed, denied or malformed optional result leaves that figure unknown without invalidating the balance, changing region or selecting another credential.

Code OAuth does not query the API wallet or cash-billing endpoints and never borrows a saved API key. Its status and points are independent of API credential failures. A Code action's payment pool does not establish which API credential can observe it: same-group evidence alone does not prove complete cross-key or team coverage. Do not automatically merge these lane identities or assign API Spend to Code.

OAuth and a Token Plan key can observe the same subscription's quota. Those readings are separate observations, not additional allowances; do not add them together or infer common ownership merely because their limits match.

## OAuth ownership and interoperability

Discovery follows the [mcode data-directory rules](mcode.md), using `auth/prod/{cn,en}/mcode-public`. Code discovery checks China then International independently of the API region setting. Resource requests and delegated renewal use the discovered namespace’s region. Each namespace contains one current login, not a managed account list. Local record keys identify storage, not the user. Preserve unrelated records and reread credential/state files rather than retaining a stale lease. Only file-backed official credential/state formats are supported.

Select exactly one `workspace_type: 0` personal workspace through `POST /matrix/api/v1/user/get_user_extra_info`; workspace ID `0` is valid. Pass that workspace explicitly to membership. Missing or ambiguous personal workspaces are unavailable; never change the official client's default workspace. Identity prefers the workspace's `op_group_id`, then membership's. A malformed membership total falls through to the workspace balance, then the membership scalar. A present malformed workspace balance does not.

Plan requests require a group and a plan indicated by `has_token_plan` or `token_plan_tier`; `has_valid_subscription` is unreliable. Code uses the platform `remains_percent` endpoint with `X-Group-Id`: its percentages are used amounts, unlike the API-key endpoint's remaining percentages. Video uses that endpoint's `current_interval_used_count` and `current_interval_total_count`; the legacy endpoint's `current_interval_usage_count` has different semantics and must not be substituted. Status 3 means unlimited. `2062` omits an absent plan, while `1004` requires auth recovery. A transient plan failure keeps fresh points and uses shared partial-window retention rather than discarding the account.

Plan flags and tiers are entitlement hints, not evidence of payment, auto-renewal, trial status or expiry. A quota `2062` removes quota windows without establishing a different subscription name. A reported name without current quota is not proof of active paid service.

Code's `accountLabel` names the product, never the subscription. Its `planLabel` prefers workspace `token_plan_tier` over membership's. Textual tiers can name the plan; pure-digit tiers are combo IDs. The optional regional `/v1/api/openplatform/charge/combo/cycle_audio_resource_package` response uses the current group's header and `biz_line=2`, `cycle_type=3`, `resource_package_type=7`, `business=Agent`, `device_platform=desktop`. Only a matching `current_subscribe.curr_subscribe_combo_id` permits a name: prefer the matching `current_combo_card.title`, then `current_subscribe.current_subscribe_title`, ignoring empty or pure-digit titles. A catalog card alone never establishes the current subscription.

Names must not cross credential namespaces, regions, groups, login epochs or combo IDs. Ordinary token rotation preserves the login epoch. Missing epochs, failed lookups and unmatched catalog cards cannot establish a cached name. Name caching never changes quota, points or Spend freshness. Optional name failures leave the plan cell empty without invalidating quota or rotating credentials; cancellation still cancels collection.

API-key plan cells stay empty: the remains response supplies quota, not Code's current-subscription name. `Token Plan` and `Pay-as-you-go` are reader labels, not purchased tiers. Without a token plan, membership `plan_name` may name the Code membership; it does not establish a Token Plan subscription. Do not infer a subscription tier from `personal_plan_type` (Free/Basic/Pro/Ultra), quota size, point totals or a product label.

Token Monitor reads the official credential and auth-state files without modifying them. It does not exchange refresh tokens, acquire or remove official locks, publish refresh fences, retry credential writes or clear the official login.

When the selected lease has expired, or membership/plan rejects it with HTTP 401/403 or business code `1004`, Token Monitor may invoke the installed official CLI once with `provider list --json`, then reread that same namespace. Healthy, unexpired leases do not invoke the CLI proactively. Missing CLI installations fall back to read-only status until the official client renews the login; never install or update a CLI automatically. The command initializes the official runtime and may create or migrate its configuration/database and shell integration; delegation is not a side-effect-free status endpoint.

CLI lookup uses PATH, the official installer directory (`MCODE_INSTALL_DIR` or the platform default), and existing npm locations. POSIX installers expose `bin/mcode`; Windows installers expose `mcode.cmd` in the install root. A desktop App installation does not establish that the separate CLI exists. Launch Windows shims through cmd with fixed arguments and bound process-tree cleanup; use an isolated private working directory rather than a user's project. No credential is passed in arguments and command output is not published.

The delegated command must receive the selected data root through `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` and its `cn`/`en` region through `MAVIS_REGION`. Installation paths are not data paths. The official record account key hashes the absolute auth-home path spelling and client ID: a symlink or other spelling of the same physical directory need not select the same record. Select the exact official record key, allowing stale sibling records; do not switch roots or regions to recover a login. App-only custom data-directory preferences are not discovered automatically: configure the matching data root explicitly when it is outside the shared discovery roots.

A zero exit code or printed provider list does not establish renewal. Require a changed access token, authenticated matching-generation state, an unexpired lease and the same nonempty login epoch after rereading; a replaced login waits for a later normal collection. Legacy records without a login epoch remain readable while healthy but cannot establish delegated recovery ownership. A newer valid lease already published by the official client needs no CLI call. An unchanged, expired token after delegation is unauthorized; normal polling can retry it without a transient-failure retry loop. `provider list` does not force renewal of every unexpired token rejected by a resource, so an unchanged unexpired credential remains unavailable without repeated attempts in that collection.

Once a delegated command starts, quota cancellation does not interrupt its official rotation. Bound it independently, then honour cancellation before requesting quota. A timeout may leave official recovery pending; never repair its files or remove its locks. Membership and plan share at most one recovery and one resource retry. Missing, malformed or transitional auth state remains unavailable; logout state retains the shared sign-in status. Custom `MCODE_OAUTH_*_ENDPOINT` overrides remain unsupported.

## Account identity and aggregation

Code identity hashes the server's regional group. API-key identity retains its existing key hash. Matching readings select one observation through shared aggregation; amounts are never added across devices. Different keys or groups reported by other devices keep their own last-good readings. Group confirmation never changes either identity or its saved cost binding. One current Code login can coexist with multiple API keys; multiple managed Code logins are unsupported. Product labels do not replace subscription names in the plan cell.

Each CN pay-as-you-go key can independently confirm affiliation with the current CN Code group through `GroupId`. A confirmed pair shares an account heading while retaining independent readings, identities and saved costs; changing the billing type preserves that evidence. Confirmed keys appear under the same account heading as Code even when other keys are configured. Unconfirmed keys keep separate account rows. Affiliation never adds amounts or assigns API Spend to Code. Its peer hash is display-only and is stripped from public stats.

An identified successful Code reading may retire the prior local OAuth identity through shared removal markers. A failed or unidentified read cannot prove logout or create a replacement account. Scoped work for a retired account must not adopt a newly logged-in account. Use the shared runtime's cancellation/revision checks; removal markers never enter the wire payload.

Subscriptions and top-ups use the shared account matcher: an exact saved account key wins, then the account email, then the sole remaining account. Keep saved-only accounts available to the shared settings picker while their live reading is unavailable.

Provider subscription metadata is separate from saved cost records in `settings.subscriptions`. A detected plan name may prefill the editable cost form, but never creates an expense record, supplies its price or establishes its renewal schedule. Those records still require the user's form submission.

## Regions, settings and shared display

New keys added in settings use Auto; existing stored `apiRegion` pins remain supported. For the legacy/environment lane, `minimaxApiRegion` wins over legacy `minimaxApiHost`, then `TOKEN_MONITOR_MINIMAX_API_REGION`, `MINIMAX_API_REGION` and `MINIMAX_API_HOST`. An unset stored region follows the environment; explicit Auto ignores those pins. Credential probes and billing links must use the effective region without replacing the stored inheritance choice. Aliases are exact. The wire keeps `cn`/`en`, distinct from settings' `intl`/`auto`.

For API-key sources, Auto first tries the runtime's last region that returned quota windows, or International when none is remembered. A pinned region never crosses regions. HTTP 401/403, business `1004` (including its HTTP 400 form), and transport failures may drive the existing fallback; ordinary 400 errors, 5xx, 429 and JSON errors do not. After a transport failure followed by an auth rejection, report unavailable rather than invalidating a potentially valid key. Remember a region only after a usable reading.

Credentials stay in main and calls use the injected transport. Key saves commit the credential and billing type together. Legacy credential IPC preserves independently saved billing/region choices. Removing a key retires its old local API reading without retiring Code; an available environment fallback keeps its own reading. A completed save must leave newer form edits intact. Each key's browser link follows its billing type and pinned or last-successful region through the declared URL policy.

The automatic Code connection explanation is separate from API key controls. A healthy Code or API reading keeps the provider summary live; API key status never inherits Code's health. Both Code points and the API wallet use `metric: 'credits'` with their own units. The `billing` window kind does not make points currency.

Code points use the shared display-only balance meter without querying grant history. When no real percentage or same-unit monthly spend is available, a positive balance displays a full bar and zero displays an empty bar; this is a balance indication, not a subscription allowance percentage. API cash Spend never supplies the denominator for Code points. Neither Code nor API display estimates enter the wire as quota percentages. Team collection and simultaneous managed Code logins are unsupported.

## Verification

Run `node --test tests/shared/minimaxLimits.test.js tests/electron/minimaxApiKeys.test.js tests/electron/accountProfileShell.test.js` for focused coverage and `npm run verify` for the full suite. Live quota or balance verification requires a key of the selected billing type in the selected region; Code checks require the official local login. Mock responses do not establish current endpoint or billing semantics.
