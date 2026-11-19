import { FilterError } from "./errors.js";
import type { QueryParamRule } from "./spec-types.js";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Client-side cap on location id lists: longer query strings are refused before they reach the API. */
export const MAX_LOCATION_IDS = 50;
/** Maximum `numbers` entries on the alert list. */
export const MAX_NUMBERS = 25;

export function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Full RFC 3339 UTC for a Date or timestamp string. Date-only strings are refused. */
export function toRfc3339(value: unknown, name: string): string {
  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === "string") {
    if (DATE_ONLY.test(value)) {
      throw new FilterError(`"${name}" needs a full timestamp, e.g. ${value}T00:00:00Z. A date alone is refused.`);
    }
    if (!RFC3339.test(value)) {
      throw new FilterError(`"${name}" must be a full RFC 3339 timestamp with an offset, e.g. 2026-11-01T00:00:00Z.`);
    }
    d = new Date(value);
  } else {
    throw new FilterError(`"${name}" must be a Date or an RFC 3339 timestamp string.`);
  }
  if (Number.isNaN(d.getTime())) throw new FilterError(`"${name}" is not a valid date.`);
  return d.toISOString().replace(/\.000Z$/, "Z");
}

function toDateOnly(value: unknown, name: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new FilterError(`"${name}" is not a valid date.`);
    // the local calendar date (toISOString would shift it a day in zones east or west of UTC)
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "string" && DATE_ONLY.test(value)) return value;
  throw new FilterError(`"${name}" must be a calendar date (YYYY-MM-DD) or a Date.`);
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new FilterError(`"${name}" must be a UUID.`);
  return value.toLowerCase();
}

/** Strip a phone number to digits (`+1 (555) 555-0142` → `15555550142`). */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * A number for the alerts `numbers` filter: digits only, and a North American number with its
 * leading 1 sent as the last 10 digits (`+1 555-555-0142` → `5555550142`), because the filter
 * matches part of the stored number and some numbers are stored without the 1.
 */
export function alertNumber(value: string): string {
  const d = digitsOnly(value);
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

function scalar(rule: QueryParamRule, value: unknown, name: string): string {
  if (rule.type === "boolean") {
    if (typeof value !== "boolean") throw new FilterError(`"${name}" must be true or false.`);
    return value ? "true" : "false";
  }
  if (rule.type === "integer" || rule.type === "number") {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new FilterError(`"${name}" must be an integer.`);
    if (rule.minimum !== undefined && value < rule.minimum) throw new FilterError(`"${name}" must be at least ${rule.minimum}.`);
    if (rule.maximum !== undefined && value > rule.maximum) throw new FilterError(`"${name}" must be at most ${rule.maximum}.`);
    return String(value);
  }
  // strings
  if (rule.format === "date-time") return toRfc3339(value, name);
  if (rule.format === "date") return toDateOnly(value, name);
  if (rule.format === "uuid") return uuid(value, name);
  // the only literal-true filter: accept the boolean too
  if (rule.enum && rule.enum.length === 1 && rule.enum[0] === "true") {
    if (value === true || value === "true") return "true";
    throw new FilterError(`"${name}" only supports true. Leave it out to include every record.`);
  }
  if (typeof value !== "string") throw new FilterError(`"${name}" must be a string.`);
  if (rule.enum && !rule.enum.includes(value)) {
    throw new FilterError(`"${name}" must be one of: ${rule.enum.join(", ")}.`);
  }
  if (rule.minLength !== undefined && value.trim().length < rule.minLength) {
    throw new FilterError(`"${name}" needs at least ${rule.minLength} characters; shorter values are ignored by the API.`);
  }
  return value;
}

function list(rule: QueryParamRule, value: unknown, name: string): string {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!raw) throw new FilterError(`"${name}" must be a list.`);
  let entries = raw.map((v) => (typeof v === "string" ? v.trim() : v));
  if (rule.name === "numbers") {
    entries = entries.map((v) => {
      if (typeof v !== "string" && typeof v !== "number") throw new FilterError(`"${name}" entries must be strings.`);
      const d = alertNumber(String(v));
      if (!d) throw new FilterError(`"${name}" entries must contain digits.`);
      return d;
    });
  } else if (rule.items?.format === "uuid") {
    entries = entries.map((v) => uuid(v, name));
  } else {
    entries = entries.map((v) => {
      if (typeof v !== "string" || v === "") throw new FilterError(`"${name}" entries must be non-empty strings.`);
      if (rule.items?.enum && !rule.items.enum.includes(v)) {
        throw new FilterError(`"${name}" entries must be one of: ${rule.items.enum.join(", ")}.`);
      }
      return v;
    });
  }
  const unique = [...new Set(entries as string[])];
  if (unique.length === 0) throw new FilterError(`"${name}" must not be empty.`);
  const max = rule.name === "location_id" ? Math.min(MAX_LOCATION_IDS, rule.maxItems ?? MAX_LOCATION_IDS) : rule.maxItems;
  if (max !== undefined && unique.length > max) {
    throw new FilterError(`"${name}" takes at most ${max} entries per request.`);
  }
  return unique.join(",");
}

/**
 * Validate options against the operation's documented query parameters and build the query.
 * The API silently ignores unknown parameters (and returns unfiltered data), so anything not
 * documented is refused here before a request is sent.
 */
export function buildQuery(
  operationId: string,
  rules: readonly QueryParamRule[],
  options: Record<string, unknown>,
): Record<string, string> {
  const byKey = new Map<string, QueryParamRule>();
  for (const r of rules) {
    byKey.set(r.name, r);
    byKey.set(camel(r.name), r);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value === undefined || value === null) continue;
    const rule = byKey.get(key);
    if (!rule) {
      const supported = rules.map((r) => camel(r.name)).join(", ") || "none";
      throw new FilterError(`"${key}" is not a filter of ${operationId}. Supported: ${supported}.`);
    }
    if (rule.name in out) throw new FilterError(`"${key}" was given twice.`);
    out[rule.name] = rule.type === "array" ? list(rule, value, key) : scalar(rule, value, key);
  }
  for (const r of rules) {
    if (r.required && !(r.name in out)) throw new FilterError(`"${camel(r.name)}" is required for ${operationId}.`);
  }
  return out;
}
