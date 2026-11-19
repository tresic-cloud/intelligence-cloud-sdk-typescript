# Next.js App Router example

Files to copy into a Next.js 15 app (Node.js runtime):

| File | What |
|---|---|
| `lib/ic.ts` | Server-only client, one per process |
| `lib/auth.ts` | `requireSignedIn()`: your sign-in check. Refuses everyone until you wire it to your own sign-in |
| `lib/webhook-token.ts` | Path-token check for the webhook routes (32 characters minimum, constant-time compare) |
| `app/api/ic-webhook/[token]/route.ts` | After Call webhook receiver: path token, size cap, parse, ignore unknown types, de-duplicate, answer fast, read the call after the response |
| `app/api/ic-alert-webhook/[token]/route.ts` | First Alert webhook receiver: path token, read the alert id, de-duplicate, answer fast, then fetch the alert and its call |
| `app/calls/actions.ts` | Server action that searches calls by phone number or text, for the signed-in viewer's locations only |
| `app/calls/page.tsx` | A search form using the action |

**Must:** put the calls page and action behind your own sign-in, and limit each viewer to the locations they are entitled to. The integration user sees everything it is mapped to; your portal must narrow it. `lib/auth.ts` fails closed until you wire it.

Install the SDK from the packed build in the zip (`npm install ./vendor-src/typescript/intelligence-cloud-sdk-0.1.0.tgz`) and `server-only`.
Set `IC_DATA_EMAIL`, `IC_DATA_PASSWORD` (a frontline integration user), `IC_WEBHOOK_TOKEN` and `IC_ALERT_WEBHOOK_TOKEN` (one per webhook, at least 32 random characters each) in the server environment. Make a token with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. The tokens travel in the URL path, never in a query string: keep the path out of your proxy, CDN and APM logs.
