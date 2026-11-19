import type { operations } from "./generated/openapi.js";
import { OPERATIONS, type OperationId } from "./generated/spec.js";
import type { OperationSpec } from "./spec-types.js";
import {
  ApiError,
  AuthError,
  ConflictError,
  EXTENSION_CONFLICT_MESSAGE,
  FilterError,
  MfaRequiredError,
  NotFoundError,
  PasswordExpiredError,
  RateLimitError,
  ValidationError,
  apiErrorText,
} from "./errors.js";
import { buildQuery } from "./filters.js";
import { project, projectKeepingUnknown, RECORDING_FIELDS } from "./projection.js";
import { MemoryTokenStore, type TokenStore, type Tokens } from "./tokens.js";

export const DEFAULT_BASE_URL = "https://app.intelligence.cloud/api/v1";
export const SDK_VERSION = "0.1.0";

// ---------------------------------------------------------------- typing helpers
type Camel<S extends string> = S extends `${infer A}_${infer B}` ? `${A}${Capitalize<Camel<B>>}` : S;
type Loose<V> = V extends string ? V | Date : V;
type LooseKeys<T> = { [K in keyof T]?: Loose<T[K]> };
type CamelKeys<T> = { [K in keyof T as K extends string ? Camel<K> : K]?: Loose<T[K]> };
type QueryParams<K extends keyof operations> = operations[K] extends { parameters: { query?: infer Q } }
  ? NonNullable<Q>
  : never;

/** Query options for an operation. Use the reference's names (`is_active`) or camelCase (`isActive`). */
export type QueryOf<K extends keyof operations> = [QueryParams<K>] extends [never]
  ? Record<string, never>
  : LooseKeys<QueryParams<K>> & CamelKeys<QueryParams<K>>;

/** JSON request body for an operation. */
export type BodyOf<K extends keyof operations> = operations[K] extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : never;

type SuccessCode = 200 | 201 | 202;
type ResponsesOf<K extends keyof operations> = operations[K]["responses"];
/** Projected success body of an operation (`void` for 204). */
export type ResponseOf<K extends keyof operations> =
  | {
      [C in keyof ResponsesOf<K>]: C extends SuccessCode
        ? ResponsesOf<K>[C] extends { content: { "application/json": infer R } }
          ? R
          : void
        : never;
    }[keyof ResponsesOf<K>]
  | (204 extends keyof ResponsesOf<K> ? void : never);

type DataOf<R> = R extends { data?: infer D } ? NonNullable<D> : never;
type ArrayItem<A> = A extends readonly (infer I)[] ? I : never;
type Unwrap<I> = I extends { attributes?: infer A } ? NonNullable<A> : I;
/** One row of a paged list (resource `attributes` already unwrapped). */
export type ItemOf<K extends keyof operations> =
  DataOf<ResponseOf<K>> extends readonly unknown[]
    ? Unwrap<ArrayItem<DataOf<ResponseOf<K>>>>
    : DataOf<ResponseOf<K>> extends { calls?: infer C }
      ? ArrayItem<NonNullable<C>>
      : DataOf<ResponseOf<K>> extends { alerts?: infer A }
        ? ArrayItem<NonNullable<A>>
        : never;

/** One page of a list. */
export interface Page<T, R = unknown> {
  /** The rows, with resource `attributes` unwrapped. */
  items: T[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  hasMore: boolean;
  /** Total matches when the API reports one (`total_count`, `summary.total`, `meta.total`). */
  total: number | null;
  /** The whole projected response, including summaries. */
  raw: R;
}

// ---------------------------------------------------------------- options
export interface ClientOptions {
  /** Default `https://app.intelligence.cloud/api/v1`. */
  baseUrl?: string;
  /** Integration user email. */
  email: string;
  /** Integration user password. */
  password: string;
  /** Where tokens live. Default: in memory, for this client only. */
  tokenStore?: TokenStore;
  /** Per-request timeout in seconds. Default 30. */
  timeout?: number;
  /** Retries for 429 and 5xx (backoff with jitter, honours Retry-After up to 60 seconds). Default 3. */
  maxRetries?: number;
  /**
   * Seconds to wait once when sign-in is rate limited (429), before trying again. Default 60.
   * 0 throws RateLimitError at once (better inside a web request).
   */
  loginRateLimitWait?: number;
  /**
   * Keep response fields the published reference does not list (default false: they are dropped).
   * Applies to the customer-lifecycle (admin) reads only. `invitation_link` and any key ending in
   * `_ref` are always removed, and `/me`, sign-in and every conversation-data read (calls, transcripts,
   * alerts, tasks, insights) are always reduced to the documented fields.
   */
  keepUnknownFields?: boolean;
  /** Sent as `User-Agent`. Default `intelligence-cloud-sdk-typescript/0.1.0`. */
  userAgent?: string;
  /** A `fetch` implementation. Default: the global `fetch` (Node 20+, Next.js). Keep certificate verification on in any client you pass. */
  fetch?: typeof fetch;
  /** @internal test hook */
  sleep?: (ms: number) => Promise<void>;
  /** @internal test hook */
  random?: () => number;
  /** @internal test hook */
  now?: () => number;
}

export interface CallOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Idempotency-Key header, reused on every retry. */
  idempotencyKey?: string;
}

/** A raw HTTP outcome, before error mapping. */
interface RawResponse {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

// error text from these endpoints can carry internal detail: never surface it
const SUPPRESS_ERROR_TEXT = new Set<string>(["testConnector", "testAfterCallWebhook", "testFirstAlertWebhook"]);
// endpoints whose 409 is the extension-conflict check: the SDK replaces its text with a fixed message
const NUMBER_MAPPING_OPS = new Set<string>(["setUserNumberMappings", "updateUserAfterCallSettings"]);

const LOGIN_RATE_LIMIT_WAIT_S = 60;
const RENEW_MARGIN_MS = 30_000;
/** A Retry-After longer than this (ms) is not waited on: the error is raised instead. */
export const MAX_RETRY_AFTER_MS = 60_000;
// always reduced to the documented fields, whatever keepUnknownFields says
const ALWAYS_PROJECT = new Set<string>([
  "getMe", "login", "refresh",
  "listCalls", "getCall", "getCallTranscript", "listAlerts", "getAlertsDashboard", "listTasks",
  "getInsightsDashboard", "listTopicCalls",
]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Refuse a base URL that is not HTTPS, except on this machine (localhost) for tests. */
export function checkBaseUrl(baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new FilterError(`baseUrl "${baseUrl}" is not a URL.`);
  }
  if (u.protocol === "https:") return baseUrl;
  if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return baseUrl;
  throw new FilterError("baseUrl must use https:// (plain http is accepted for localhost only).");
}

/** Transport, authentication, retries, error mapping and projection. */
export class Core {
  readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly store: TokenStore;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly loginWaitS: number;
  private readonly keepUnknown: boolean;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  readonly now: () => number;
  private renewing: Promise<Tokens> | null = null;

  constructor(opts: ClientOptions) {
    if (!opts || !opts.email || !opts.password) {
      throw new TypeError("email and password are required (a dedicated integration user with MFA off).");
    }
    this.baseUrl = checkBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.email = opts.email;
    this.password = opts.password;
    this.store = opts.tokenStore ?? new MemoryTokenStore();
    this.timeoutMs = (opts.timeout ?? 30) * 1000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.loginWaitS = opts.loginRateLimitWait ?? LOGIN_RATE_LIMIT_WAIT_S;
    this.keepUnknown = opts.keepUnknownFields ?? false;
    this.userAgent = opts.userAgent ?? `intelligence-cloud-sdk-typescript/${SDK_VERSION}`;
    const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new TypeError("No fetch implementation found. Use Node 20+ or pass `fetch`.");
    this.fetchImpl = f;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  // -------------------------------------------------------------- public core
  /** Call one documented operation and return its projected response body. */
  async call<K extends OperationId>(operationId: K, pathArgs: string[], opts: CallOptions = {}): Promise<any> {
    const op = OPERATIONS[operationId] as OperationSpec;
    const query = buildQuery(operationId, op.query, opts.query ?? {});
    const url = this.url(op, pathArgs, query);
    const res = await this.send(op.method, url, {
      body: op.hasBody ? opts.body ?? {} : undefined,
      headers: opts.headers,
      idempotencyKey: opts.idempotencyKey,
      auth: true,
      operationId,
    });
    if (res.status < 200 || res.status >= 300) throw this.toError(res, operationId, op.hasBody ? opts.body : undefined);
    if (res.status === 204 || res.text === "") return undefined;
    if (!this.keepUnknown || ALWAYS_PROJECT.has(operationId)) return project(res.json, op.response);
    const out = projectKeepingUnknown(res.json, op.response) as any;
    if (operationId === "getCall" && out?.data?.vcon && typeof out.data.vcon === "object") {
      const v = out.data.vcon as Record<string, unknown>;
      out.data.vcon = Object.fromEntries(RECORDING_FIELDS.filter((k) => k in v).map((k) => [k, v[k]]));
    }
    return out;
  }

  /** Call a paged list operation and return one page. */
  async page<K extends OperationId>(operationId: K, pathArgs: string[], opts: CallOptions = {}): Promise<Page<any, any>> {
    const body = await this.call(operationId, pathArgs, opts);
    const p = extractPage(body);
    return { items: p.items.map(unwrapRow), nextCursor: p.nextCursor, hasMore: p.hasMore, total: p.total, raw: body };
  }

  /** Iterate every row of a paged list operation, following cursors with limit=100. */
  async *iterate<K extends OperationId>(
    operationId: K,
    pathArgs: string[],
    query: Record<string, unknown> & { maxItems?: number } = {},
  ): AsyncGenerator<any> {
    const { maxItems, ...rest } = query;
    const q: Record<string, unknown> = { limit: 100, ...rest };
    let yielded = 0;
    const seen = new Set<string>();
    for (;;) {
      const body = await this.call(operationId, pathArgs, { query: q });
      const page = extractPage(body);
      for (const item of page.items) {
        if (maxItems !== undefined && yielded >= maxItems) return;
        yielded++;
        yield unwrapRow(item);
      }
      if (!page.hasMore || !page.nextCursor || seen.has(page.nextCursor)) return;
      if (maxItems !== undefined && yielded >= maxItems) return;
      seen.add(page.nextCursor);
      q.cursor = page.nextCursor;
    }
  }

  /** Ends ALL sessions of this user (web app too) and forgets the tokens. */
  async logout(): Promise<void> {
    const t = await this.store.get();
    if (t && t.accessToken) {
      const res = await this.send("POST", `${this.baseUrl}/auth/logout`, { auth: true, operationId: "logout", body: {} });
      if (res.status >= 300 && res.status !== 401) throw this.toError(res, "logout");
    }
    await this.store.set(null);
  }

  /** Forget the tokens held by this client. Does not sign out on the server. */
  async close(): Promise<void> {
    await this.store.set(null);
  }

  // -------------------------------------------------------------- auth
  private async accessToken(): Promise<string> {
    const t = await this.store.get();
    if (!t || !t.accessToken) return (await this.renew(null)).accessToken;
    if (t.expiresAt - this.now() < RENEW_MARGIN_MS) return (await this.renew(t.accessToken)).accessToken;
    return t.accessToken;
  }

  /**
   * Get fresh tokens. Serialised: concurrent callers share one refresh or login.
   * `failed` is the access token that was rejected (null = none yet); if another caller has
   * already replaced it, the new tokens are reused.
   */
  private renew(failed: string | null): Promise<Tokens> {
    if (this.renewing) return this.renewing;
    const work = async (): Promise<Tokens> => {
      // inside the store's lock (when it has one): another process may already have renewed
      const cur = await this.store.get();
      if (cur && cur.accessToken && cur.accessToken !== failed && cur.expiresAt - this.now() >= RENEW_MARGIN_MS) {
        return cur;
      }
      if (cur && cur.refreshToken) {
        const spent = cur.refreshToken;
        // a refresh token is single use: mark it spent before it leaves the process
        await this.store.set({ ...cur, refreshToken: "" });
        let fresh: Tokens | null;
        try {
          fresh = await this.refreshWith(spent);
        } catch (err) {
          // rate limited: the token was never used, so put it back for the next try
          if (err instanceof RateLimitError) await this.store.set(cur);
          throw err;
        }
        if (fresh) return fresh;
      }
      return await this.login();
    };
    this.renewing = (async () => {
      try {
        return this.store.withLock ? await this.store.withLock(work) : await work();
      } finally {
        this.renewing = null;
      }
    })();
    return this.renewing;
  }

  /**
   * Swap a refresh token for a new pair. On 429 the same token is tried again after a wait (it was
   * not used); a sign-in is never attempted for a rate-limited refresh. Returns null when the token
   * is refused (spent, expired or revoked), so the caller signs in again.
   */
  private async refreshWith(refreshToken: string): Promise<Tokens | null> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.send("POST", `${this.baseUrl}/auth/refresh`, {
        body: { refresh_token: refreshToken },
        auth: false,
        operationId: "refresh",
        noRetry: true,
      });
      if (res.status === 429) {
        const ra = retryAfterMs(res.headers);
        if (attempt >= this.maxRetries || (ra !== null && ra > MAX_RETRY_AFTER_MS)) throw this.toError(res, "refresh");
        await this.sleep(this.backoff(attempt + 1, ra));
        continue;
      }
      if (res.status !== 200) return null;
      return this.saveTokens(res.json);
    }
  }

  private async login(): Promise<Tokens> {
    let waited = false;
    for (;;) {
      const res = await this.send("POST", `${this.baseUrl}/auth/login`, {
        body: { email: this.email, password: this.password },
        auth: false,
        operationId: "login",
        noRetry: true,
      });
      if (res.status === 429 && !waited && this.loginWaitS > 0) {
        waited = true;
        await this.sleep(this.loginWaitS * 1000);
        continue;
      }
      if (res.status !== 200) throw this.toError(res, "login");
      const body = res.json as Record<string, unknown> | null;
      if (body && body.status === "mfa_required") throw new MfaRequiredError();
      if (body && body.password_expired === true) throw new PasswordExpiredError();
      return this.saveTokens(body);
    }
  }

  private async saveTokens(body: unknown): Promise<Tokens> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.access_token !== "string" || typeof b.refresh_token !== "string") {
      throw new AuthError(200, null, "Sign-in returned no tokens.");
    }
    const tokens: Tokens = {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      expiresAt: this.now() + (typeof b.expires_in === "number" ? b.expires_in : 900) * 1000,
    };
    // write the new pair before anyone uses it
    await this.store.set(tokens);
    return tokens;
  }

  // -------------------------------------------------------------- transport
  private url(op: OperationSpec, pathArgs: string[], query: Record<string, string>): string {
    let i = 0;
    const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const v = pathArgs[i++];
      if (typeof v !== "string" || v.trim() === "") {
        throw new TypeError(`Missing path parameter "${name}".`);
      }
      return encodeURIComponent(v);
    });
    const qs = new URLSearchParams(query).toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  private async send(
    method: string,
    url: string,
    o: {
      body?: unknown;
      headers?: Record<string, string>;
      idempotencyKey?: string;
      auth: boolean;
      operationId: string;
      noRetry?: boolean;
    },
  ): Promise<RawResponse> {
    let attempt = 0;
    let authRetried = false;
    // POST is only retried on 5xx when the server can de-duplicate it (Idempotency-Key)
    const safeToRepeat = method !== "POST" || Boolean(o.idempotencyKey);
    for (;;) {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": this.userAgent,
        ...(o.headers ?? {}),
      };
      if (o.body !== undefined) headers["Content-Type"] = "application/json";
      if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;
      if (attempt > 0 && o.idempotencyKey) headers["Accept-Encoding"] = "identity";
      let token: string | null = null;
      if (o.auth) {
        token = await this.accessToken();
        headers.Authorization = `Bearer ${token}`;
      }

      let res: RawResponse;
      try {
        res = await this.fetchOnce(method, url, headers, o.body);
      } catch (err) {
        if (!o.noRetry && safeToRepeat && attempt < this.maxRetries) {
          attempt++;
          await this.sleep(this.backoff(attempt, null));
          continue;
        }
        throw err;
      }

      if (res.status === 401 && o.auth && !authRetried) {
        authRetried = true;
        await this.renew(token);
        continue;
      }
      if (!o.noRetry && attempt < this.maxRetries) {
        const retriable = res.status === 429 || (res.status >= 500 && safeToRepeat);
        const ra = retryAfterMs(res.headers);
        // a wait longer than 60 seconds is not slept on: the error goes back to the caller
        if (retriable && (ra === null || ra <= MAX_RETRY_AFTER_MS)) {
          attempt++;
          await this.sleep(this.backoff(attempt, ra));
          continue;
        }
      }
      return res;
    }
  }

  private async fetchOnce(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<RawResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        redirect: "manual",
        cache: "no-store",
      } as RequestInit);
      const text = await r.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: r.status, headers: r.headers, json, text };
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      throw new ApiError(0, aborted ? "timeout" : "network_error", aborted ? "Request timed out." : "Network error.", {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private backoff(attempt: number, retryAfter: number | null): number {
    const base = Math.min(8000, 500 * 2 ** (attempt - 1));
    const jittered = base / 2 + this.random() * (base / 2);
    return Math.max(jittered, retryAfter ?? 0);
  }

  // -------------------------------------------------------------- errors
  toError(res: RawResponse, operationId: string, requestBody?: unknown): ApiError {
    const { code, message: serverText, requestId, hint } = normaliseErrorBody(res);
    // the exception text never carries the server's message (it can echo numbers or names)
    let message = apiErrorText(res.status, code, requestId, hint ?? (res.status === 404 ? NOT_FOUND_HINT : null));
    let serverMessage = serverText;
    if (SUPPRESS_ERROR_TEXT.has(operationId)) {
      message = `Request failed with HTTP ${res.status}.`;
      serverMessage = null;
    }
    let extensions: string[] = [];
    if (res.status === 409) {
      const requested = requestedNumbers(requestBody);
      if (NUMBER_MAPPING_OPS.has(operationId) || requested.length) {
        extensions = extensionConflictNumbers(serverText ?? "", requested);
        message = EXTENSION_CONFLICT_MESSAGE;
        serverMessage = null; // it can name other companies' locations
      }
    }
    const extra = { requestId, operationId, serverMessage };
    switch (true) {
      case res.status === 401:
        return new AuthError(res.status, code, message, extra);
      case res.status === 404:
        return new NotFoundError(res.status, code, message, extra);
      case res.status === 409:
        return new ConflictError(res.status, code, message, { ...extra, extensions });
      case res.status === 400 || res.status === 422:
        return new ValidationError(res.status, code, message, extra);
      case res.status === 429:
        return new RateLimitError(res.status, code, message, secondsOrNull(retryAfterMs(res.headers)), extra);
      default:
        return new ApiError(res.status, code, message, extra);
    }
  }
}

// ---------------------------------------------------------------- helpers
/** Every number listed under `monitored_numbers` anywhere in a request body. */
export function requestedNumbers(body: unknown, out: string[] = []): string[] {
  if (Array.isArray(body)) {
    for (const v of body) requestedNumbers(v, out);
  } else if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k === "monitored_numbers" && Array.isArray(v)) {
        for (const n of v) if (!out.includes(String(n))) out.push(String(n));
      } else {
        requestedNumbers(v, out);
      }
    }
  }
  return out;
}

/** The requested extensions that a 409 message mentions. Nothing else from the message is kept. */
export function extensionConflictNumbers(message: string, requested: string[]): string[] {
  const wanted = new Set(requested);
  const seen: string[] = [];
  for (const tok of (message ?? "").match(/[0-9*#+]+/g) ?? []) {
    if (wanted.has(tok) && !seen.includes(tok)) seen.push(tok);
  }
  return seen;
}

const NOT_FOUND_HINT = "Not found, or outside what this login can see.";

/**
 * The three error shapes, normalised. `message` is the server's own text (null when it sent none);
 * `hint` is SDK-written text that is safe to show.
 */
export function normaliseErrorBody(res: { status: number; json: unknown; text: string; headers: Headers }): {
  code: string | null;
  message: string | null;
  requestId: string | null;
  hint: string | null;
} {
  const b = res.json as Record<string, unknown> | null;
  if (b && typeof b === "object") {
    const e = b.error;
    if (e && typeof e === "object") {
      const eo = e as Record<string, unknown>;
      return { code: str(eo.code) ?? str(eo.type), message: str(eo.message), requestId: str(eo.request_id), hint: null };
    }
    if (typeof e === "string") return { code: null, message: e, requestId: null, hint: null };
    if (typeof b.message === "string") {
      return { code: str(b.code) ?? null, message: b.message, requestId: null, hint: null };
    }
  }
  const ct = res.headers?.get?.("content-type") ?? "";
  if (res.status === 404 && !ct.includes("json")) {
    return {
      code: "not_json",
      message: null,
      requestId: null,
      hint: "Non-JSON 404: the request was refused before reaching the API. Long query strings (e.g. many location ids) cause this.",
    };
  }
  return { code: null, message: null, requestId: null, hint: null };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function retryAfterMs(h: Headers | undefined): number | null {
  const v = h?.get?.("retry-after");
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

function secondsOrNull(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms / 1000);
}

/** A list row: resource `attributes` when present, else the row itself. */
export function unwrapRow(item: any): any {
  return item && typeof item === "object" && item.attributes && typeof item.attributes === "object" ? item.attributes : item;
}

/** Pull rows and paging fields out of any list response. */
export function extractPage(body: any): { items: any[]; nextCursor: string | null; hasMore: boolean; total: number | null } {
  const data = body?.data;
  const items: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.calls)
      ? data.calls
      : Array.isArray(data?.alerts)
        ? data.alerts
        : [];
  const paging = body?.pagination ?? body?.meta ?? body ?? {};
  const nextCursor = typeof paging.next_cursor === "string" && paging.next_cursor ? paging.next_cursor : null;
  const hasMore = Boolean(paging.has_more);
  const total =
    typeof paging.total_count === "number"
      ? paging.total_count
      : typeof paging.total === "number"
        ? paging.total
        : typeof data?.summary?.total === "number"
          ? data.summary.total
          : typeof data?.summary?.total_calls === "number"
            ? data.summary.total_calls
            : null;
  return { items, nextCursor, hasMore, total };
}
