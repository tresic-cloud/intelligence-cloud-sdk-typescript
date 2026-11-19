// First Alert webhook receiver: app/api/ic-alert-webhook/[token]/route.ts
//
// Register the URL as the location's First Alert webhook, with a long random token in the path
// (never in a query string):
//   https://portal.example.com/api/ic-alert-webhook/<IC_ALERT_WEBHOOK_TOKEN>
// with admin.setFirstAlertWebhook(locationId, url). Deliveries are not signed: the unguessable
// URL is the secret. HTTPS only. Keep the path out of your proxy, CDN and APM logs.
//
// The receiver reads only the alert id from the request, answers at once, and then fetches the
// alert and its call with the frontline integration user (a member of Manager Alerts).
import { after } from "next/server";
import { Deduplicator, MAX_EVENT_BYTES } from "@intelligence-cloud/sdk";
import { ic } from "@/lib/ic";
import { configuredToken, tokenMatches } from "@/lib/webhook-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Per-process. With several instances, pass a shared store: new Deduplicator({ store: mySharedStore }).
const alertDedup = new Deduplicator();

/** The alert id from a First Alert delivery, or null. Reads nothing else from the request. */
function alertIdFrom(body: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const nested = d.alert && typeof d.alert === "object" ? (d.alert as Record<string, unknown>) : {};
  for (const v of [d.alert_id, nested.id, d.id]) {
    if (typeof v === "string" && UUID.test(v.trim().toLowerCase())) return v.trim().toLowerCase();
  }
  return null;
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const want = configuredToken("IC_ALERT_WEBHOOK_TOKEN");
  if (!want) return new Response(null, { status: 503 });
  if (!tokenMatches((await params).token, want)) return new Response(null, { status: 404 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_EVENT_BYTES) return new Response(null, { status: 413 });
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_EVENT_BYTES) return new Response(null, { status: 413 });
  const alertId = alertIdFrom(body);
  if (!alertId) return new Response(null, { status: 204 }); // no alert id: acknowledge, ignore
  if (!(await alertDedup.isDuplicate(alertId))) {
    // Answer within 2 seconds; fetch the alert after the response is sent.
    after(() => handleAlert(alertId));
  }
  return new Response(null, { status: 204 });
}

async function handleAlert(alertId: string) {
  const alert = await ic.getAlert(alertId, { withCall: true }); // null when this login can't see it
  if (!alert?.id || !alert.call_id) return;
  await pageOnCallManager({ alertId: alert.id, callId: alert.call_id, rules: alert.keywords ?? [] });
}

async function pageOnCallManager(_page: { alertId: string; callId: string; rules: string[] }) {
  // your paging, chat or ticketing tool goes here; send ids, never the summary or numbers
}
