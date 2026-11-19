// After Call webhook receiver: app/api/ic-webhook/[token]/route.ts
//
// Register the URL with a long random token in the path (never in a query string):
//   https://portal.example.com/api/ic-webhook/<IC_WEBHOOK_TOKEN>
// Deliveries are not signed: the unguessable URL is the secret. HTTPS only. Keep the path out of
// your proxy, CDN and APM logs (log the route template, not the URL).
import { after } from "next/server";
import {
  Deduplicator,
  isUnknownEvent,
  MAX_EVENT_BYTES,
  parseAfterCallEvent,
  PayloadTooLargeError,
  WebhookPayloadError,
  type AfterCallSummaryEvent,
} from "@intelligence-cloud/sdk";
import { ic } from "@/lib/ic";
import { configuredToken, tokenMatches } from "@/lib/webhook-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-process. With several instances, pass a shared store: new Deduplicator({ store: mySharedStore }) backed by a database or cache.
const dedup = new Deduplicator();

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const want = configuredToken("IC_WEBHOOK_TOKEN");
  if (!want) return new Response(null, { status: 503 });
  if (!tokenMatches((await params).token, want)) return new Response(null, { status: 404 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_EVENT_BYTES) return new Response(null, { status: 413 });

  let event: AfterCallSummaryEvent;
  try {
    const parsed = parseAfterCallEvent(await request.text());
    if (isUnknownEvent(parsed)) return new Response(null, { status: 204 }); // a type we don't handle: acknowledge, ignore
    event = parsed;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return new Response(null, { status: 413 });
    if (err instanceof WebhookPayloadError) return new Response(null, { status: 400 });
    throw err;
  }
  if (event.is_test || (await dedup.isDuplicate(event.call.id))) {
    return new Response(null, { status: 204 });
  }
  // Answer within 2 seconds; do the work after the response is sent.
  after(() => handleCall(event));
  return new Response(null, { status: 202 });
}

async function handleCall(event: AfterCallSummaryEvent) {
  // Treat the event as a notification: read the call before writing anything to another system.
  // A 404 means this login can't see it (map every line to the integration user): drop it.
  const call = await ic.getCall(event.call.id);
  // Upsert on the call id: a repeat delivery can carry newer data.
  await saveToCrm({ callId: call.id, when: call.call_date, summary: call.summary, sentiment: call.sentiment });
}

async function saveToCrm(_record: Record<string, unknown>) {
  // your CRM / data warehouse upsert, keyed on callId, goes here
}
