import type { components } from "./generated/openapi.js";
import { WEBHOOK_SHAPES } from "./generated/spec.js";
import { PayloadTooLargeError, WebhookPayloadError } from "./errors.js";
import { project } from "./projection.js";

/** The After Call `end_of_call_summary` event, as documented. */
export type AfterCallSummaryEvent = components["schemas"]["AfterCallSummaryEvent"];

/** The largest webhook body the parser accepts by default (256 KB). Answer 413 to anything larger. */
export const MAX_EVENT_BYTES = 262_144;

/**
 * An event of a type this SDK does not handle. Answer 2xx and ignore it: new event types can be
 * added at any time.
 */
export interface UnknownEvent {
  readonly kind: "unknown";
  /** The event's `type`, or null when it has none. */
  readonly type: string | null;
  readonly version: string | null;
  /** The parsed body, as received. */
  readonly raw: Record<string, unknown>;
}

/** True for an event of a type this SDK does not handle (answer 2xx and ignore it). */
export function isUnknownEvent(e: AfterCallSummaryEvent | UnknownEvent): e is UnknownEvent {
  return (e as UnknownEvent).kind === "unknown";
}

/**
 * Parse and check an After Call webhook body. Accepts the raw body (string or bytes) or an
 * already-parsed object.
 *
 * - An `end_of_call_summary` event comes back with only the documented fields.
 * - Any other JSON object comes back as an `UnknownEvent` (check with `isUnknownEvent`): answer 2xx
 *   and ignore it.
 * - Throws `PayloadTooLargeError` for a body over `maxBytes` (default 256 KB; answer 413) and
 *   `WebhookPayloadError` for a body that isn't a JSON object or a malformed `end_of_call_summary`
 *   (answer 400).
 *
 * Treat the event as a notification: read the call with `getCall(event.call.id)` before you write
 * anything from it into another system.
 */
export function parseAfterCallEvent(
  body: string | Uint8Array | ArrayBuffer | Record<string, unknown>,
  options: { maxBytes?: number } = {},
): AfterCallSummaryEvent | UnknownEvent {
  const maxBytes = options.maxBytes ?? MAX_EVENT_BYTES;
  let obj: unknown = body;
  if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
    if (size > maxBytes) throw new PayloadTooLargeError(`Body is larger than ${maxBytes} bytes.`);
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    try {
      obj = JSON.parse(text);
    } catch {
      throw new WebhookPayloadError("Body is not JSON.");
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new WebhookPayloadError("Body is not a JSON object.");
  const o = obj as Record<string, any>;
  if (o.type !== "end_of_call_summary") {
    return {
      kind: "unknown",
      type: typeof o.type === "string" ? o.type : null,
      version: typeof o.version === "string" ? o.version : null,
      raw: o,
    };
  }
  if (typeof o.version !== "string" || !o.version.startsWith("1.")) {
    throw new WebhookPayloadError("Unsupported event version.");
  }
  if (!o.call || typeof o.call !== "object" || typeof o.call.id !== "string" || !o.call.id) {
    throw new WebhookPayloadError("Event has no call.id.");
  }
  if (typeof o.location_id !== "string") throw new WebhookPayloadError("Event has no location_id.");
  const event = project<AfterCallSummaryEvent>(o, WEBHOOK_SHAPES.afterCallSummary);
  return { ...event, is_test: o.is_test === true };
}

/** Storage for `Deduplicator`. Swap in a shared store (a database or cache) for multi-instance deployments. */
export interface DedupStore {
  /** Return true if `key` was already recorded; otherwise record it and return false. Must be atomic. */
  checkAndAdd(key: string): boolean | Promise<boolean>;
}

/** In-memory LRU store (per process). */
export class MemoryDedupStore implements DedupStore {
  private readonly keys = new Map<string, true>();
  constructor(private readonly maxSize = 10_000) {}
  checkAndAdd(key: string): boolean {
    if (this.keys.has(key)) {
      this.keys.delete(key);
      this.keys.set(key, true); // refresh recency
      return true;
    }
    this.keys.set(key, true);
    if (this.keys.size > this.maxSize) {
      const oldest = this.keys.keys().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return false;
  }
}

/**
 * De-duplicate deliveries on `call.id` (After Call) or the alert id (First Alert). Retries and calls
 * with several legs can deliver the same call more than once.
 *
 *     const dedup = new Deduplicator();
 *     if (await dedup.isDuplicate(event.call.id)) return; // already handled
 *
 * The same name and meaning in every SDK: Python `is_duplicate`, PHP `isDuplicate`.
 */
export class Deduplicator {
  private readonly store: DedupStore;
  constructor(options: { maxSize?: number; store?: DedupStore } = {}) {
    this.store = options.store ?? new MemoryDedupStore(options.maxSize ?? 10_000);
  }
  /** True if this id was seen before. The first call for an id records it and returns false. */
  async isDuplicate(id: string): Promise<boolean> {
    return Boolean(await this.store.checkAndAdd(id));
  }
  /** @deprecated Use `isDuplicate` (same result). */
  seen(id: string): Promise<boolean> {
    return this.isDuplicate(id);
  }
}
