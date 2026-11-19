# Intelligence Cloud SDK for TypeScript

`@intelligence-cloud/sdk` 0.1.0. The partner API for Node.js 20+ and Next.js server code (route handlers, server actions).

- **Customer lifecycle** (admin credentials): companies, locations, users, products, connectors, First Alert rules, Insights Hub, plus the Base Intelligence Seat workflows.
- **Conversation intelligence** (frontline credentials): calls, transcripts, recording links, alerts, tasks, insights, and the After Call webhook.

Zero runtime dependencies (uses the global `fetch`). ESM and CommonJS builds with full types.

The API reference is at https://docs.intelligence.cloud/reference.html; the source of truth is https://docs.intelligence.cloud/openapi.yaml.

## Install

```bash
npm install @intelligence-cloud/sdk
```

The package holds only the compiled SDK and pulls in no dependencies.

Alternative, from the source download: it includes a packed build, `intelligence-cloud-sdk-0.1.0.tgz`.

```bash
unzip typescript.zip -d vendor-src          # creates vendor-src/typescript
npm install ./vendor-src/typescript/intelligence-cloud-sdk-0.1.0.tgz    # from your project
```

```ts
import { Client } from "@intelligence-cloud/sdk";        // ESM
const { Client } = require("@intelligence-cloud/sdk");   // CommonJS
```

To rebuild from source: `npm install && npm run build && npm pack` in the SDK folder (the dev tools stay in that folder). `npm run generate` regenerates the types and operation table from `openapi.yaml` (download it from https://docs.intelligence.cloud/openapi.yaml and pass its path: `node scripts/generate.mjs openapi.yaml`).

## Credentials

Today every integration signs in with the email and password of a **dedicated integration user**. Turn MFA off for that user's company (`mfa_enforced: false`). **API keys arrive in December 2026.**

Use one client per credential:

| Client | Login | For |
|---|---|---|
| Admin (`IC_ADMIN_EMAIL`, `IC_ADMIN_PASSWORD` in the examples) | a reseller admin integration user | customer lifecycle |
| Data (`IC_DATA_EMAIL`, `IC_DATA_PASSWORD` in the examples) | a frontline integration user mapped to the lines you need | calls, alerts, tasks, insights |

Admin logins get empty lists from the conversation-data endpoints by design. The intelligence helpers check the role once and throw `FrontlineRequiredError` instead of returning nothing.

```ts
const ic = new Client({
  email: process.env.IC_DATA_EMAIL!,
  password: process.env.IC_DATA_PASSWORD!,
  // baseUrl: "https://app.intelligence.cloud/api/v1",  (default; https only, plain http for localhost only)
  // timeout: 30,                                        (seconds)
  // tokenStore: new FileTokenStore("/var/lib/my-app/ic-tokens.json"),   (default: memory)
  // loginRateLimitWait: 60,                             (seconds to wait once on a sign-in 429; 0 throws at once)
  // keepUnknownFields: false,                           (true keeps fields the reference doesn't list yet)
  // userAgent: "riverbend-bi-sync/1.0",
});
```

If you pass your own `fetch`, keep certificate verification on.

`keepUnknownFields: true` passes on response fields the reference doesn't list yet, so you can use a new field before you update the SDK. It applies to the customer-lifecycle (admin) reads: `/me`, sign-in and every conversation-data read (calls, transcripts, alerts, tasks, insights) always keep only the documented fields, and the one-time sign-in link is never passed on.

### How the client signs in

- It signs in on the first call and keeps the access and refresh tokens in its token store.
- It renews the access token before it expires and once after a 401. Refresh tokens are **single use**: the SDK marks the old one spent before sending it and stores the new pair before using it. Renewals are serialised, so concurrent calls share one refresh.
- Sign-in is rate limited. On a 429 at sign-in the client waits `loginRateLimitWait` seconds (60) once; set it to 0 inside a web request to fail at once.
- A rate-limited renewal (429) waits and retries the same refresh token; it never falls back to a sign-in. Any `Retry-After` over 60 seconds is not waited on: the client throws `RateLimitError` (`retryAfter` in seconds).
- An integration user with MFA on gets `MfaRequiredError`: "Integration users need MFA off for their company. API keys arrive in December 2026."
- A sign-in with an expired password throws `PasswordExpiredError`: a person must set a new password for the integration user in the app; then update your secret store.

### Several workers or serverless

Use one integration user per worker, or share one user's tokens through a store that **locks**. Without a lock, two processes can renew with the same refresh token, and the second renewal signs the user out everywhere. Never create a client per request: each one signs in.

```ts
interface TokenStore {
  get(): Tokens | null | Promise<Tokens | null>;
  set(tokens: Tokens | null): void | Promise<void>;   // { accessToken, refreshToken, expiresAt }
  withLock?<T>(fn: () => Promise<T>): Promise<T>;      // held by every process sharing the store
}
```

The client signs in and renews inside `withLock`, and re-reads the store first, so a pair another process just renewed is reused. `FileTokenStore(path)` does this for every process on one machine (a `.lock` file beside the token file, mode 0600). For several machines, implement `withLock` over your shared cache (for example a lock key with an expiry).

`client.close()` forgets the tokens. `client.logout()` **ends every session of that user**, the web app and other jobs included; the SDK never calls it on its own, and most integrations never need it.

## Quick start: conversation intelligence

```ts
import { Client } from "@intelligence-cloud/sdk";

const ic = new Client({ email: process.env.IC_DATA_EMAIL!, password: process.env.IC_DATA_PASSWORD! });
await ic.requireFrontline();

const since = new Date(Date.now() - 24 * 3600 * 1000);

// one page, with totals for the whole filter
const page = await ic.searchCalls({ dateFrom: since, sentiment: "negative" });
console.log(page.summary.total_calls, page.items.length, page.nextCursor);

// every match, following cursors 100 at a time
for await (const call of ic.iterCalls({ dateFrom: since, phone: "555-0142" })) {
  const detail = await ic.getCall(call.id!);
  const lines = await ic.getTranscript(call.id!);
}

// the recording: a signed WAV link, valid 120 minutes
const { url, expiresAt } = await ic.getRecordingUrl(callId);

// alerts for one rule, one alert with its call
const alerts = await ic.searchAlerts({ alertName: "Upset Customer", dateFrom: since });
const alert = await ic.getAlert(alertId, { withCall: true });   // null when not visible
```

The same helpers are on `ic.intelligence` (`ic.intelligence.searchCalls(…)`).

### Calls

| Method | Does |
|---|---|
| `searchCalls(filters)` | One page: `items`, `summary` (totals for all pages), `total`, `nextCursor`, `hasMore` |
| `iterCalls(filters)` | Every match, newest first (`maxItems` stops early) |
| `getCall(callId)` | Full detail: analysis, tasks, recording fields. `NotFoundError` when outside the login's view |
| `getTranscript(callId)` | Lines in order: `time`, `speaker` ("Speaker 1" … "Speaker N"), `name`, `text` |
| `getRecordingUrl(callId)` | `{ url, expiresAt }` only |

Call filters:

| Filter | Notes |
|---|---|
| `phone` | A number or extension in any format; partial digits match. Sent as the API's `search` |
| `text` | Names (typo-tolerant), summary, key points, transcript. Sent as `search`. At least 2 characters. Give `phone` **or** `text` |
| `dateFrom`, `dateTo` | `Date` or full RFC 3339 timestamp; sent as UTC. Date-only strings are refused. Default window: 00:00 UTC seven days ago until now. At most 366 days when both are given |
| `status` | `completed`, `missed`, `voicemail`, `failed`, `cancelled` |
| `sentiment` | `crisis`, `very_negative`, `negative`, `mildly_negative`, `below_neutral`, `neutral`, `positive`, `none` |
| `hasOpenTasks` | `true` only |
| `multiLeg` | `true`: more than one leg; `false`: single leg |
| `locationIds` | Up to 50 location ids |
| `companyId` | One company |
| `limit`, `cursor` | Page size 1–100 (default 10) and the next-page cursor |

**Recording links** are signed HTTPS links to the WAV audio. Fetch with a plain `GET` and no `Authorization` header; `Range` requests work. They expire 120 minutes after issue. Treat them as secrets: never log or store them; call `getRecordingUrl` again for a fresh link.

### Alerts

| Method | Does |
|---|---|
| `searchAlerts(filters)` | One page of First Alert hits; `total` counts every match |
| `iterAlerts(filters)` | Every match |
| `getAlert(alertId, { withCall })` | One alert by id (searched by id, no date window), with the call when asked; `null` when not visible |
| `getAlertsDashboard({ dateFrom, dateTo, locationIds, companyId })` | `kpis`, `top_triggered`, `recent_alerts` |

Alert filters: `alertName` (exact, case-sensitive rule name), `numbers` (up to 25; formatting is stripped to digits; substring match on caller or callee), `text` (names, numbers, summary, or an alert id), `sentiment`, `dateFrom`, `dateTo`, `locationIds`, `topic` (exact topic slug), `companyId`, `limit`, `cursor`.

Use these for look-ups. Alerts as they fire arrive on the [First Alert webhook](#receiving-the-first-alert-webhook); calls arrive on the After Call webhook. Don't poll the API for new data: read it when a person asks for something or when a webhook tells you to fetch details, and run scheduled jobs (exports, digests) at most once a day over a bounded date window.

### Tasks and insights

| Method | Filters |
|---|---|
| `listTasks(filters)` / `iterTasks` | `status` (`pending`, `in_progress`, `done`, `overdue`, `open`), `todayStart`, `callId`, `taskId`, `dueOn` (`YYYY-MM-DD` or Date), `dateFrom`, `dateTo` (creation time; no default window), `search`, `locationIds`, `companyId`, `limit`, `cursor`. `summary` counts by display status |
| `getInsightsDashboard({ start, end, trendingLimit, locationIds, companyId })` | `start` and `end` required, at most 366 days apart |
| `listTopicCalls(slug, filters)` / `iterTopicCalls` | `dateFrom`, `dateTo`, `sentiment` (`positive`, `neutral`, `negative`), `outcome` (`completed`, `missed`, `pending`), `search`, `locationIds`, `companyId`, `limit`, `cursor` |

### Webhook configuration

| Method | Credential | Does |
|---|---|---|
| `getAfterCallWebhook(locationId)` | any | The location's After Call webhook, or `null` |
| `setAfterCallWebhook(locationId, url, enabled = true)` | admin | One HTTPS URL per location. `enabled: false` pauses it (there is no delete) |
| `testAfterCallWebhook(locationId)` | admin | Sends the test event to the saved URL. Returns `{ success, http_status }` |
| `getFirstAlertWebhook(locationId)` | admin | The location alert webhook URL, or `null` |
| `setFirstAlertWebhook(locationId, url \| null)` | admin | Read → merge → write, so monitored numbers are kept |
| `testFirstAlertWebhook(locationId, url?)` | admin | Returns `{ success, http_status }` |

## Receiving the After Call webhook

Each processed call at the location is POSTed to the URL (`type: "end_of_call_summary"`). The webhook covers **every call at the location**, whatever users' number mappings say.

- Use HTTPS and a token of at least 32 random characters in the URL **path** (never a query string), one per location. Compare it in constant time (`crypto.timingSafeEqual`). Deliveries are not signed: the URL is the secret. Keep the path out of your proxy, CDN and APM logs.
- Answer 2xx within 2 seconds and do the work after responding. Redirects count as failures.
- Answer 2xx to event types you don't handle (`isUnknownEvent`) and ignore them. Answer 400 only for a body that isn't JSON, 413 for a body over 256 KB, 404 for a wrong token.
- Treat the event as a notification: read the call with `getCall(event.call.id)` before you write anything from it into another system. A 404 means drop it.
- Three attempts in all, then the delivery is dropped. Expect duplicates (retries, calls with several legs): upsert on `call.id`.

```ts
import { Deduplicator, isUnknownEvent, parseAfterCallEvent } from "@intelligence-cloud/sdk";

const dedup = new Deduplicator();             // in-memory LRU; pass { store } for a shared store (a database or cache)

const event = parseAfterCallEvent(rawBody);   // WebhookPayloadError (400) / PayloadTooLargeError (413)
if (isUnknownEvent(event)) return;            // a type you don't handle: answer 2xx
if (!event.is_test && !(await dedup.isDuplicate(event.call.id))) {
  queue.push(event.call.id);                  // read the call later with getCall(event.call.id)
}
```

`parseAfterCallEvent(body, { maxBytes })` refuses bodies over `MAX_EVENT_BYTES` (262144). `Deduplicator.isDuplicate(id)` is true for a repeat (the same name and meaning in the Python and PHP SDKs; the older `seen` still works). `examples/after-call-sample.json` is a sample event: post it to your receiver locally, e.g. `curl -X POST http://localhost:3000/api/ic-webhook/$IC_WEBHOOK_TOKEN -H 'Content-Type: application/json' -d @examples/after-call-sample.json`.

The Next.js route handler in `examples/nextjs/app/api/ic-webhook/[token]/route.ts` shows the whole receiver: path token, size cap, parse, de-duplicate, respond, then read the call with `after()`.

## Receiving the First Alert webhook

Webhooks are how your integration hears about new calls and alerts: the After Call webhook for every call, the First Alert webhook for each alert as it fires. Subscribe to them; don't poll the API for new data.

The First Alert webhook posts the alert that fired: the alert id, the rule, the location, the call and the time. Read only the alert id, answer 2xx at once, then fetch the alert and its call with a frontline integration user in Manager Alerts:

```ts
const alertId = alertIdFrom(await request.text());   // see examples/nextjs/app/api/ic-alert-webhook/[token]/route.ts
if (alertId && !(await alertDedup.isDuplicate(alertId))) {  // a second Deduplicator, keyed on the alert id
  after(async () => {
    const alert = await ic.getAlert(alertId, { withCall: true });   // null when this login can't see it
    if (alert?.id && alert.call_id) await pageOnCallManager(alert.id, alert.call_id);   // ids only
  });
}
```

If your receiver was unavailable, read the window you missed once and skip alerts you have already handled. Alerts are dated by their call, so start the window 30 minutes before the receiver went down:

```ts
for await (const a of ic.iterAlerts({ dateFrom: new Date(wentDown.getTime() - 30 * 60_000), dateTo: cameBack })) {
  if (a.id && !(await alertDedup.isDuplicate(a.id))) await handleAlert(a.id);
}
```

## Quick start: Base Intelligence Seat (admin credentials)

```ts
const admin = new Client({ email: process.env.IC_ADMIN_EMAIL!, password: process.env.IC_ADMIN_PASSWORD! });

const customer = await admin.provisionSeatCustomer({
  // companyId: storedCompanyId,       pass the id from the first run on every re-run
  companyName: "Northgate Dental",
  primaryAdmin: { name: "Avery Chen", email: "avery.chen@example.com", phone: "+15555550150" },
  location: { name: "Northgate Dental - Main", street: "12 Elm St", city: "Springfield", state: "IL", country: "United States", zipcode: "62704" },
  threatPhrases,                       // provided by your Tresic contact
  connector: { apiUrl: "https://pbx.example.com/ns-api/v2", domain: "northgate.example", apiKey: phoneSystemKey },
  // mfaOff: true,                     only for a company that holds an integration user
  // sso: { domain: "northgate.example.com" },   returns the DNS TXT record to publish
});

// End users first: each line is mapped, then the invitation is emailed.
await admin.addFrontlineUser(customer, { email: "front.desk@example.com", firstName: "Alex", lastName: "Kim" }, "2101");
// The first manager switches the two alerts on, then gets the invitation.
await admin.addManager(customer, { email: "office.manager@example.com", firstName: "Sam", lastName: "Ortiz" });
```

- Both alert rules are created **switched off**. `addManager` switches them on once the manager is set up (`activateAlerts: true`, the default). To switch them on yourself, pass `{ activateAlerts: false }` and call `activateSeatAlerts(customer)` when you are ready. Re-running `provisionSeatCustomer` never switches a rule off.
- **Store the returned `companyId` and pass it on every re-run.** Without it, an existing company is reused only when both its name and its primary contact email match. A same-named company with another contact throws `ConflictError` (`code: "company_name_conflict"`) before anything is written: company names are not unique, and a new customer's users must never land in another customer's company.
- Users are created **without** an invitation. The workflow maps their lines and sets their products and groups, and only then emails the invitation. If a mapping is refused, `ExtensionMappingError` is thrown and no invitation has been sent. Pass `sendInvitation: false` to invite later with `admin.users.resendInvitation(companyId, userId)`.

The workflows are also on `admin.workflows`.

| Workflow | Does |
|---|---|
| `provisionSeatCustomer(spec)` | Creates the company (MFA off only with `mfaOff`, read back to verify), turns on After Call, First Alert and Insights Hub, creates the single location, the groups "Manager Alerts" and "Insights Hub Access", the rules "Upset Customer" (sentiment below −40) and "Customer Threat" (threat phrases and sentiment below −20) routed to Manager Alerts, and Insights Hub access for the group. Optional connector and single sign-on domain claim. **Idempotent**: re-running finds the company by `companyId` (or by name and contact email), the location, groups and rules by name, and the connector by its phone-system domain (or name); it only creates what is missing, and brings existing rules back in line (Manager Alerts routing, current phrases). A connector found in `error`, `inactive` or with other settings gets the new settings and key, and is restarted. Both rules are created switched off and left off (see `addManager` and `activateSeatAlerts`). A connector that ends in `error` is recorded on the result (`connectorStatus`, `connectorStateReason`), not thrown. A deactivated company or location is an error unless `reactivate: true`. Returns every id, `created[]` and `existing[]` (`connector:updated` when the connector got new settings) |
| `getSeatCustomer(companyId, { locationName? })` | Rebuilds the customer object (location, groups, rules, connector) by name |
| `addFrontlineUser(customer, user, extension)` | End user, created without an invitation: After Call only, alert email off, their extension mapped, then the extension added to every manager and integration user, First Alert and Insights Hub, and last the invitation emailed. Needs a connector |
| `addIntegrationUser(customer, user)` | Integration user (reads calls, alerts and insights for another system): created without an invitation, tagged `department: "integration"`, all three products, both groups, every alert email off, mapped to all lines; last the invitation emailed. Password sign-in only. Never counted as a seat or a manager, never switches alerts on |
| `addManager(customer, user, { activateAlerts? = true })` | Manager, created without an invitation: After Call, First Alert and Insights Hub, both groups, alert email on, mapped to exactly the end-user lines at the location; then both alerts switched on, and last the invitation emailed. The manager's own phone line is not captured on the Seat: it is never mapped, nor added to First Alert or Insights Hub |
| `activateSeatAlerts(customer)` | Switches on the Upset Customer and Customer Threat rules. Returns the ids it switched on |
| `changeUserExtension(customer, userId, old, new)` | Moves a user's extension and re-syncs managers, integration users, First Alert and Insights Hub |
| `removeUser(customer, userId, { keepExtensions? })` | In order: leaves every group, clears the number mapping, takes the user's line off managers, integration users, First Alert and Insights Hub (unless `keepExtensions`), then deactivates. Only an end user releases a line, and only one no other end user still holds; removing a manager, an integration user or any non-manager holding several lines leaves every line in place (`kind` says which). Products are left as they are |
| `listFrontlineUsers(customer)` / `listManagers(customer)` / `listIntegrationUsers(customer)` | One page-through of the location's users. End user: After Call only. Manager: all three products. Integration user: `department: "integration"`, never in the other two lists |
| `syncNumbers(customer, { dryRun? })` | Pushes the union of end-user lines (end users holding exactly one line) to managers, integration users, First Alert and Insights Hub; managers and integration users end up with exactly the lines (any other number on their mapping is removed); `dryRun` returns the diff only |
| `offboardCustomer(customer, { deactivateCompany? = true })` | A customer leaves, in order: pause the After Call webhook, clear the First Alert webhook address, deactivate the connector (stops call capture), deactivate the integration users, deactivate the company. Safe to re-run. Ask your Tresic contact about the retention of the customer's data |

`customer` can be the object returned by `provisionSeatCustomer` / `getSeatCustomer`, or a company id. Add `excludeUserIds` / `excludeEmails` to the customer object to hide users from every workflow (they are never counted, never updated, and their lines don't count). `user` is `{ email, firstName, lastName, phoneNumber?, sendInvitation? (default true), authMethod?, idempotencyKey? }`. The result carries `invited` (this call emailed the invitation) and `alertsActivated` (rule ids this call switched on).

The **Customer Threat phrases are provided by your Tresic contact**. `provisionSeatCustomer` needs them whenever it creates the Customer Threat rule and throws `FilterError` otherwise. `upsetCustomerRule(groupIds)` and `customerThreatRule(groupIds, phrases)` build the two rule bodies if you create rules yourself.

Workflows find users by email, so a re-run carries on with the same user. When the API refuses a user's number mapping (connector not `active`, or an extension another location monitors), the workflow stops before touching managers, First Alert and Insights Hub and throws `ExtensionMappingError` (`userId`, `cause`). The user exists but has not been invited: fix the cause and run the workflow again. The re-run finds the user, finishes the setup and emails the invitation; it also re-sends the invitation to any user who has not accepted one yet. Any other failure part-way throws `WorkflowError` with `step` (the failing step), `partial` (ids done so far) and `cause` (the original error).

Notes:
- Numbers are the extensions and DIDs from the customer's phone system. Read them there with your own key; the API cannot list them. Keep each extension at exactly one location.
- User number mappings need the connector to be `active`. A 409 means the extension is already monitored at another location (`ConflictError.extensions` lists it).
- Users are created with an `Idempotency-Key` and without an invitation; the workflow emails it last unless `sendInvitation: false`.
- Manage integration users with `addIntegrationUser` (or tag them `department: "integration"`), so the Seat workflows never treat them as end users or managers.

## Low-level methods

Every documented operation is a method named after its `operationId`, grouped by the reference's sections. Path parameters come first, then the JSON body, then the query filters. Responses are returned as documented, with any undocumented field removed.

- **Paged lists** (`list*` with a cursor) return one `Page`: `{ items, nextCursor, hasMore, total, raw }`, with each row's `attributes` unwrapped into `items`.
- Each paged list has an `iter*` twin that follows cursors with `limit=100` and yields rows (`maxItems` stops early).
- Query filters accept the reference's names (`is_active`) or camelCase (`isActive`).

```ts
const page = await admin.companies.listCompanies(resellerId, { search: "Riverbend", isActive: true });
for await (const loc of admin.locations.iterCompanyLocations(companyId)) console.log(loc.location_name);
await admin.firstAlert.updateAlertRule(locationId, ruleId, { enabled: true });
```

| Namespace | Methods |
|---|---|
| `resellers` | `getResellerBranding` `updateResellerBranding` `getResellerSmtpSettings` `saveResellerSmtpSettings` `deleteResellerSmtpSettings` |
| `companies` | `listCompanies` `iterCompanies` `createCompany` `getCompaniesMfaSummary` `getCompany` `updateCompany` `deactivateCompany` `reactivateCompany` `getCompanyBranding` `updateCompanyBranding` · helpers `addProducts` `removeProducts` `findCompany` `findCompanies` |
| `sso` | `listCompanyDomains` `claimCompanyDomain` `removeCompanyDomain` `listDomainVerifications` `verifyDomain` `getIdentityProvider` `connectIdentityProvider` `disconnectIdentityProvider` `testIdentityProvider` |
| `products` | `listProducts` `listCompanyProducts` `listUserProducts` `enableUserProduct` `disableUserProduct` |
| `locations` | `listVerticals` `listCompanyLocations` `iterCompanyLocations` `createLocation` `getLocation` `updateLocation` `deactivateLocation` `reactivateLocation` · helpers `addProducts` `removeProducts` `findLocation` |
| `groups` | `listUserGroups` `iterUserGroups` `createUserGroup` `getUserGroup` `updateUserGroup` `deleteUserGroup` `getUserGroupMembership` `setUserGroupMembership` · helpers `addMembers` `removeMembers` `userGroupIds` `addUserToGroups` `removeUserFromGroups` `findGroup` |
| `connectors` | `listConnectorTypes` `testConnector` `listLocationConnectors` `iterLocationConnectors` `createConnector` `getConnector` `updateConnector` `deactivateConnector` `reactivateConnector` `listCompanyConnectors` `iterCompanyConnectors` · helpers `waitForStatus` `findConnector` |
| `firstAlert` | `listAlertRules` `iterAlertRules` `createAlertRule` `getAlertRule` `updateAlertRule` `deleteAlertRule` `duplicateAlertRule` `getFirstAlertConfig` `saveFirstAlertConfig` `testFirstAlertWebhook` `getAlertNotificationPreferences` `setAlertEmailPreferences` `setAlertDigestPreferences` · helpers `addMonitoredNumbers` `removeMonitoredNumbers` `setMonitoredNumbers` `setWebhookUrl` `addRuleGroups` `removeRuleGroups` `findRule` |
| `insightsHub` | `getInsightsHubSetup` `saveInsightsHubSetup` `updateInsightsHubSetup` `getInsightsHubConfig` `updateInsightsHubConfig` `getUserInsightsHubAccess` · helpers `addNumbers` `removeNumbers` `setNumbers` `addGroups` `removeGroups` |
| `users` | `listCompanyUsers` `iterCompanyUsers` `createCompanyUser` `getCompanyUser` `updateCompanyUser` `deactivateCompanyUser` `reactivateCompanyUser` `resendInvitation` `resetPassword` `getUserNumberMappings` `setUserNumberMappings` `listLocationUsers` `iterLocationUsers` `getLocationUser` · helpers `findUserByEmail` `addLocations` `removeLocations` `userNumbers` `addNumbers` `removeNumbers` `setNumbers` `replaceNumber` |
| `afterCallSettings` | `getUserAfterCallSettings` `updateUserAfterCallSettings` |
| `account` | `getMe` `listVisibleLocations` `iterVisibleLocations` |
| `calls` | `listCalls` `iterCalls` `getCall` `getCallTranscript` |
| `alerts` | `listAlerts` `iterAlerts` `getAlertsDashboard` |
| `tasks` | `listTasks` `iterTasks` |
| `insights` | `getInsightsDashboard` `listTopicCalls` `iterTopicCalls` |
| `webhooks` | `getAfterCallWebhook` `saveAfterCallWebhook` `testAfterCallWebhook` |

What the SDK does for you on these:

- **Full-replacement writes** (`enabled_products`, `member_ids`, `group_ids`, rule triggers and groups, First Alert numbers and webhook URL, Insights Hub numbers and groups, user number mappings, user locations) have `add*` / `remove*` / `set*` helpers that read, merge, then write.
- `users.createCompanyUser` always sends an `Idempotency-Key` (a new UUID per call unless you pass `{ idempotencyKey }`) and reuses it on retries. After a 422 it looks the user up by email and fixes the half-created user with PATCH.
- Webhook test results and connector dry runs never carry the server's error text.
- `connectors.createConnector`, `reactivateConnector` and `updateConnector` (when it reconnects) wait until the connector is `active`, and throw `ConnectorError` with `stateReason` (for example `invalid_permissions` for a key without the permissions the connector needs) when it lands in `error`. `deactivateConnector` waits for `inactive`. They check the status every 10 seconds for up to 10 minutes. Pass `{ wait: false }` to return at once, or `{ timeout, checkInterval }` in seconds.
- The connector dry run and the webhook tests return only `success` and the HTTP status.
- `client.intelligence` and `client.workflows` hold the helpers above; the same methods are also on the client itself.

## Filters and validation

The API ignores parameters it doesn't know and returns unfiltered data. The SDK accepts only the documented filters and checks them **before** sending:

- An unknown filter throws `FilterError`.
- Dates: a `Date` or a full RFC 3339 timestamp, always sent as UTC. `2026-11-01` alone is refused; use `2026-11-01T00:00:00Z`. A `Date` passed as `dueOn` is sent as its local calendar date.
- `numbers`: at most 25, stripped to digits; a North American number with its leading 1 is sent as the last 10 digits (`+1 555-555-0142` → `5555550142`), because some numbers are stored without the 1. `locationIds`: at most 50 (longer query strings are refused before they reach the API).
- Enum values, UUIDs, page sizes (1–100) and required filters are checked.

## Errors

```
IntelligenceCloudError
├── ApiError (status, code, message, requestId, operationId, serverMessage)
│   ├── AuthError            401 (MfaRequiredError: MFA on; PasswordExpiredError: password expired)
│   ├── NotFoundError        404, also for records outside your login's scope
│   ├── ConflictError        409 (extensions: the refused extensions on a number conflict; code company_name_conflict)
│   ├── ValidationError      400, 422
│   └── RateLimitError       429 after retries (retryAfter in seconds)
├── FilterError              unsupported filter or value, raised before sending
├── ConnectorError           connector ended in error (stateReason) or did not settle
├── FrontlineRequiredError   conversation data requested with an admin login
├── ExtensionMappingError    a workflow could not map a user's numbers (userId, cause)
├── WorkflowError            a workflow stopped (step, partial, cause)
└── WebhookPayloadError      body isn't a JSON object, or a malformed After Call event (400)
    └── PayloadTooLargeError body over 256 KB (413)
```

- 429 and 5xx are retried up to 3 times with backoff and jitter, honouring `Retry-After` up to 60 seconds (a longer `Retry-After` is thrown at once). A `POST` is retried on 5xx only when it carries an `Idempotency-Key`.
- The API's different error shapes are normalised into `status`, `code` and `requestId`. The exception text (`message`) never carries the server's error text, which can echo phone numbers or names: it reads e.g. `HTTP 422 VALIDATION_ERROR (request_id …)`. The server's text is on `serverMessage`.
- Log `status`, `code` and `requestId`, not exception text or response bodies.
- The text of a 409 on number mappings is replaced with "Extension is already monitored at another location." and `extensions` lists the requested extensions that were refused.
- Show your own messages to end users.

```ts
import { ConflictError, NotFoundError, ValidationError } from "@intelligence-cloud/sdk";

try {
  await admin.users.addNumbers(companyId, userId, connectorId, ["2101"]);
} catch (err) {
  if (err instanceof ConflictError) { /* release the extension at the other location first */ }
  else if (err instanceof ValidationError && err.code === "CONNECTOR_NOT_VALID") { /* connector not active */ }
  else throw err;
}
```

## Secrets

Never log access or refresh tokens, passwords, phone-system keys, webhook URLs or recording links. The SDK logs nothing and never returns the one-time sign-in link the API can include when a user is created.

## Build from source

```bash
npm run typecheck && npm run build
```

## Support

Partner support: your Tresic contact. Security reports: security@tresic.cloud.

Intelligence Cloud SDK Licence. Copyright (c) 2026 Creo Solutions, Inc. d/b/a Tresic. Partners, their customers and contractors working for either may use, copy, modify and distribute the SDK solely to access Intelligence Cloud. Use of the API is governed by the Intelligence Cloud API and SDK Terms (https://docs.intelligence.cloud/terms/api) and your agreement with Tresic or your provider. Provided as is. See `LICENSE`.
