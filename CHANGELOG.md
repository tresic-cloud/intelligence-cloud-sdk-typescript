# Changelog

## 0.1.0: 2026-11-18 (Base Intelligence Seat manager lines)

- On the Base Intelligence Seat a manager's own phone line is not captured. `addManager(customer, user, { activateAlerts? })` no longer takes `ownExtension` or a string third argument (a string, or any option other than `activateAlerts`, now throws `FilterError` before any write): a manager is mapped to exactly the end-user lines at the location, and their own extension is never mapped, nor added to First Alert or Insights Hub. `AddManagerOptions` has `activateAlerts` only.
- `syncNumbers` sets every manager's mapping to exactly the lines (as for integration users); a number on a manager that is not a line is removed.

## 0.1.0: 2026-11-17 (review 2)

- Licence: the Intelligence Cloud SDK Licence (Copyright (c) 2026 Creo Solutions, Inc. d/b/a Tresic), the same text in every SDK: partners, their customers and contractors may use, copy, modify and distribute the SDK solely to access Intelligence Cloud; provided as is.
- `provisionSeatCustomer` never adopts a same-named company: pass `companyId` (store it from the first run), or a company is reused only when its name and primary contact email both match; otherwise `ConflictError` (`company_name_conflict`) before any write. New `companies.findCompanies`.
- Integration users are first-class: `addIntegrationUser` (tagged `department: "integration"`, all lines, every alert email off), `listIntegrationUsers`, `isIntegration`. They are never listed as end users or managers and keep every line as end users come and go. `removeUser` releases only an end user's line, and only one no other end user holds; removing an integration user, a manager or a multi-line user leaves every line in place. Managers are users with all three products. `syncNumbers` counts only end users holding exactly one line. `excludeUserIds` / `excludeEmails` on the customer object hide users from every workflow.
- Connector re-runs match on the phone-system domain; a connector in `error`, `inactive` or with changed settings gets the new settings and key and is restarted. `ProvisionResult.existing` lists what was found (`connector:updated`).
- `offboardCustomer`: pause the After Call webhook, clear the First Alert webhook, stop the connector, deactivate integration users, deactivate the company.
- Webhooks: `parseAfterCallEvent` returns an `UnknownEvent` (`isUnknownEvent`) for other event types instead of throwing, and refuses bodies over `MAX_EVENT_BYTES` (256 KB) with `PayloadTooLargeError`. `Deduplicator.isDuplicate` (same name and meaning in every SDK); `seen` is kept as an alias. Answer within 2 seconds. `examples/after-call-sample.json` added.
- Token store: optional `withLock`; `FileTokenStore` shares tokens safely between processes on one machine. A rate-limited renewal retries the same refresh token and never signs in.
- `Retry-After` over 60 seconds is thrown, not waited on. `loginRateLimitWait` option (default 60; 0 throws at once). `PasswordExpiredError`.
- Exception text never carries the server's error text (`serverMessage` holds it).
- `keepUnknownFields` option (the deny-list always applies).
- Alerts `numbers`: North American numbers are sent as their last 10 digits. `dueOn` Dates use the local calendar date.
- `baseUrl` must be https (http only for localhost). Node.js 20 or later.
- Next.js example: webhook tokens move from `?token=` to a path segment (`app/api/ic-webhook/[token]`, `app/api/ic-alert-webhook/[token]`), 32 characters minimum; the calls action starts with `requireSignedIn()` (fails closed until wired) and searches only the viewer's locations.

## 0.1.0 (2026-11-16)

First release.

- Client with email and password sign-in for a dedicated integration user (MFA off), single-use refresh tokens with rotation and a serialised renewal lock, pluggable token store.
- Retries for 429 and 5xx with backoff, jitter and `Retry-After`; 60 s wait on a sign-in 429.
- One error hierarchy over the API's error shapes.
- Responses keep only documented fields.
- Every documented operation as a typed method, paged lists with `iter*` iterators, strict filter validation.
- Read → merge → write helpers for full-replacement writes; idempotent user create with half-create recovery; connector create, reactivate and deactivate wait for the final status, checking every 10 seconds for up to 10 minutes (`timeout`, `checkInterval`).
- Base Intelligence Seat workflows: `provisionSeatCustomer`, `getSeatCustomer`, `addFrontlineUser`, `addManager`, `activateSeatAlerts`, `changeUserExtension`, `removeUser`, `listFrontlineUsers`, `listManagers`, `syncNumbers`. Users are invited last, once their lines are mapped; the two alerts are created off and switched on when the first manager is in place.
- Conversation intelligence helpers: calls, transcripts, recording links, alerts, tasks, insights, webhook configuration.
- After Call webhook receiver: `parseAfterCallEvent` and `Deduplicator`.
- New calls and alerts reach you on the After Call and First Alert webhooks (2026-11-17). The Next.js First Alert receiver example (`app/api/ic-alert-webhook/route.ts`) reads only the alert id and fetches the alert and its call with `getAlert(alertId, { withCall: true })`. The README covers a one-off catch-up after an outage.
- Examples: plain Node and Next.js App Router (route handler and server action).
- Shipped as a packed build, `intelligence-cloud-sdk-0.1.0.tgz`, with no runtime dependencies.
