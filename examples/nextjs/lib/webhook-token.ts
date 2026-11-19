// Path-token check shared by the webhook routes. lib/webhook-token.ts
import "server-only";
import { timingSafeEqual } from "node:crypto";

export const MIN_TOKEN_LENGTH = 32;

/**
 * The configured token, or null when it is missing or shorter than 32 characters (the routes then
 * refuse every delivery). Make one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 */
export function configuredToken(envName: string): string | null {
  const want = process.env[envName] ?? "";
  if (want.length < MIN_TOKEN_LENGTH) {
    console.error(`${envName} must be set to a random string of at least ${MIN_TOKEN_LENGTH} characters.`);
    return null;
  }
  return want;
}

/** Constant-time comparison of the token from the URL path with the configured one. */
export function tokenMatches(given: string | undefined, want: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
