/** Base class for every error this SDK throws. */
export class IntelligenceCloudError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Extra fields carried by an API error. */
export interface ApiErrorExtra {
  requestId?: string | null;
  operationId?: string | null;
  cause?: unknown;
  /** The server's own error text. Kept off `message` (see ApiError). */
  serverMessage?: string | null;
}

/**
 * An error response from the API. `status` is the HTTP status; `code` is the normalised error code.
 *
 * `message` (the exception text) never carries the server's error text, which can echo phone
 * numbers or other customer data: it holds the status, code, request id and, where the SDK has
 * one, a fixed hint. The server's text is on `serverMessage`; don't log it. Log `status`, `code`
 * and `requestId`.
 */
export class ApiError extends IntelligenceCloudError {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly operationId: string | null;
  /** The server's error text, when it sent one. May contain customer data: don't log it. */
  readonly serverMessage: string | null;

  constructor(status: number, code: string | null, message: string, extra: ApiErrorExtra = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.status = status;
    this.code = code;
    this.requestId = extra.requestId ?? null;
    this.operationId = extra.operationId ?? null;
    this.serverMessage = extra.serverMessage ?? null;
  }
}

/** The exception text for an API error: status, code, request id and an optional SDK-written hint. */
export function apiErrorText(status: number, code: string | null, requestId: string | null, hint?: string | null): string {
  let text = `HTTP ${status}${code ? ` ${code}` : ""}`;
  if (hint) text += `: ${hint}`;
  if (requestId) text += ` (request_id ${requestId})`;
  return text;
}

/** 401: token missing, invalid or expired, or the sign-in was refused. */
export class AuthError extends ApiError {}

/**
 * The integration user has MFA on. No tokens were issued.
 * Turn MFA off for the integration user's company (`mfa_enforced: false`).
 */
export class MfaRequiredError extends AuthError {
  constructor() {
    super(200, "mfa_required", "Integration users need MFA off for their company. API keys arrive in December 2026.");
  }
}

/**
 * The integration user's password has expired. No tokens were issued.
 * A person must set a new password in the app for that user; then update your secret store.
 */
export class PasswordExpiredError extends AuthError {
  constructor() {
    super(200, "password_expired", "The password has expired. Change it in the app, then sign in again.");
  }
}

/** 404. Also returned for records outside your login's scope: treat as absent. */
export class NotFoundError extends ApiError {}

/** 409: duplicate name or email, already active or inactive, extension already monitored. */
export class ConflictError extends ApiError {
  /** On an extension conflict: the requested extensions the API refused. Empty otherwise. */
  readonly extensions: string[];
  constructor(status: number, code: string | null, message: string, extra: ApiErrorExtra & { extensions?: string[] } = {}) {
    super(status, code, message, extra);
    this.extensions = extra.extensions ?? [];
  }
}

/** 400 or 422: malformed request or invalid value. */
export class ValidationError extends ApiError {}

/** 429: rate limited, after the SDK's own retries. `retryAfter` is in seconds when the API sent it. */
export class RateLimitError extends ApiError {
  readonly retryAfter: number | null;
  constructor(status: number, code: string | null, message: string, retryAfter: number | null, extra: ApiErrorExtra = {}) {
    super(status, code, message, extra);
    this.retryAfter = retryAfter;
  }
}

/** A filter or argument the API does not support. Raised before any request is sent. */
export class FilterError extends IntelligenceCloudError {}

/** The connector ended in `error` (or did not settle in time). */
export class ConnectorError extends IntelligenceCloudError {
  readonly stateReason: string | null;
  readonly status: string | null;
  readonly connector: Record<string, unknown> | null;
  constructor(
    message: string,
    stateReason: string | null,
    status: string | null,
    connector: Record<string, unknown> | null,
  ) {
    super(message);
    this.stateReason = stateReason;
    this.status = status;
    this.connector = connector;
  }
}

/** The login is not a frontline user, so conversation data would come back empty. */
export class FrontlineRequiredError extends IntelligenceCloudError {
  readonly role: string | null;
  constructor(role: string | null) {
    super(
      `This login has role "${role ?? "unknown"}". Conversation data endpoints return empty lists to admin logins: ` +
        "sign in with a frontline integration user.",
    );
    this.role = role;
  }
}

/** A workflow stopped part-way. `step` names the failing step; `partial` holds what was done; `cause` is the error. */
export class WorkflowError extends IntelligenceCloudError {
  readonly step: string;
  readonly partial: Record<string, unknown>;
  constructor(step: string, partial: Record<string, unknown>, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`Workflow stopped at "${step}": ${why}`, { cause });
    this.step = step;
    this.partial = partial;
  }
}

/**
 * A workflow created or updated the user, but the API refused the user's number mapping
 * (usually a connector that is not `active` yet, or an extension another location monitors).
 * Fix the cause, then run the workflow again (it finds the user and carries on) or call `syncNumbers`.
 */
export class ExtensionMappingError extends IntelligenceCloudError {
  readonly userId: string | null;
  constructor(userId: string | null, cause: unknown) {
    super(
      `User ${userId ?? "unknown"}: numbers not mapped (${cause instanceof Error ? cause.message : String(cause)}). ` +
        "Number mappings need an active connector and extensions no other location monitors.",
      { cause },
    );
    this.userId = userId;
  }
}

/** The webhook body is not JSON, not a JSON object, or a malformed After Call event. Answer 400. */
export class WebhookPayloadError extends IntelligenceCloudError {}

/** The webhook body is larger than the limit (`MAX_EVENT_BYTES`, 256 KB by default). Answer 413. */
export class PayloadTooLargeError extends WebhookPayloadError {}

export const EXTENSION_CONFLICT_MESSAGE = "Extension is already monitored at another location.";
