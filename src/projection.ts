import type { Shape } from "./spec-types.js";

/**
 * Keep only the fields the API reference documents. Anything else in a response is dropped,
 * so internal or secret fields never reach your code even if the API starts sending them.
 */
export function project<T = unknown>(value: unknown, shape: Shape | null | undefined): T {
  if (shape === null || shape === undefined || shape === "*") return value as T;
  if (value === null || value === undefined) return value as T;
  if (shape === "v") {
    return (typeof value === "object" ? undefined : value) as T;
  }
  if ("a" in shape) {
    if (!Array.isArray(value)) return undefined as T;
    return value.map((v) => project(v, shape.a)) as T;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    // a scalar where an object is documented (e.g. a null-able object sent as a string): drop it
    return undefined as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, sub] of Object.entries(shape.o)) {
    if (Object.prototype.hasOwnProperty.call(value, k)) {
      const v = project((value as Record<string, unknown>)[k], sub);
      if (v !== undefined) out[k] = v;
    }
  }
  return out as T;
}

/** Inside a call's `vcon` object, only these fields are ever passed on. */
export const RECORDING_FIELDS = ["recording_url", "recording_url_expires_at", "recording_mime_type"] as const;

/**
 * Fields removed from every response, even with `keepUnknownFields`: these names, and any key
 * ending in `_ref` (internal references).
 */
export const ALWAYS_REMOVED_FIELDS: ReadonlySet<string> = new Set(["invitation_link"]);

function removed(key: string): boolean {
  return ALWAYS_REMOVED_FIELDS.has(key) || key.endsWith("_ref");
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!removed(k)) out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

/**
 * Like `project`, but keeps fields the reference does not list (the `keepUnknownFields` option).
 * The fields in `ALWAYS_REMOVED_FIELDS` and any `*_ref` key are still removed at every depth.
 */
export function projectKeepingUnknown<T = unknown>(value: unknown, shape: Shape | null | undefined): T {
  if (value === null || value === undefined) return value as T;
  if (shape === null || shape === undefined || shape === "*" || shape === "v") return scrub(value) as T;
  if ("a" in shape) {
    if (!Array.isArray(value)) return scrub(value) as T;
    return value.map((v) => projectKeepingUnknown(v, shape.a)) as T;
  }
  if (typeof value !== "object" || Array.isArray(value)) return scrub(value) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (removed(k)) continue;
    const sub = shape.o[k];
    out[k] = sub === undefined ? scrub(v) : projectKeepingUnknown(v, sub);
  }
  return out as T;
}
