import type { Client } from "./client.js";
import type { Page } from "./core.js";
import { FilterError, FrontlineRequiredError } from "./errors.js";
import type { components } from "./generated/openapi.js";

type S = components["schemas"];
export type Me = NonNullable<S["Me"]["data"]>;
export type CallListItem = S["CallListItem"];
export type CallDetail = NonNullable<S["CallDetailResponse"]["data"]>;
export type TranscriptLine = NonNullable<NonNullable<S["TranscriptResponse"]["data"]>["transcript"]>[number];
export type Alert = S["Alert"];
export type Task = S["Task"];
export type AfterCallWebhook = NonNullable<S["AfterCallWebhookResponse"]["data"]>;
export type CallsSummary = NonNullable<NonNullable<S["CallList"]["data"]>["summary"]>;
export type TasksSummary = NonNullable<S["TaskList"]["summary"]>;
export type TopicCall = NonNullable<S["TopicCallList"]["data"]>[number];
export type AlertsDashboard = NonNullable<S["AlertsDashboardResponse"]["data"]>;
export type InsightsDashboard = NonNullable<S["InsightsDashboardResponse"]["data"]>;

/** A call's recording link. `expiresAt` is RFC 3339; the link stops working then (120 minutes after issue). */
export interface RecordingLink {
  url: string | null;
  expiresAt: string | null;
}

/** The outcome of a webhook test send: whether your endpoint answered 2xx, and its HTTP status. */
export interface WebhookTestResult {
  success: boolean;
  http_status: number | null;
}

export type Sentiment =
  | "crisis"
  | "very_negative"
  | "negative"
  | "mildly_negative"
  | "below_neutral"
  | "neutral"
  | "positive"
  | "none";

export interface CallSearch {
  /** A phone number or extension in any format (partial digits work). Sent as the API's `search`. */
  phone?: string;
  /** Free text: names, summary, key points, transcript. Sent as the API's `search`. */
  text?: string;
  dateFrom?: Date | string;
  dateTo?: Date | string;
  status?: "completed" | "missed" | "voicemail" | "failed" | "cancelled";
  sentiment?: Sentiment;
  /** Only `true` is supported. */
  hasOpenTasks?: true;
  multiLeg?: boolean;
  /** Up to 50 location ids. */
  locationIds?: string[];
  companyId?: string;
  cursor?: string;
  limit?: number;
}

export interface AlertSearch {
  /** Exact rule name, case-sensitive (the API's `keyword`). */
  alertName?: string;
  /** Up to 25 numbers or extensions; formatting is stripped to digits. Substring match on caller or callee. */
  numbers?: string[];
  /** Names, numbers, summary text, or an alert id (the API's `search`). */
  text?: string;
  sentiment?: Sentiment;
  dateFrom?: Date | string;
  dateTo?: Date | string;
  locationIds?: string[];
  /** Exact topic slug. */
  topic?: string;
  companyId?: string;
  cursor?: string;
  limit?: number;
}

export interface TaskSearch {
  status?: "pending" | "in_progress" | "done" | "overdue" | "open";
  /** Your local midnight, e.g. 2026-11-02T00:00:00-06:00. */
  todayStart?: Date | string;
  callId?: string;
  taskId?: string;
  /** `YYYY-MM-DD` or a Date (UTC calendar day). */
  dueOn?: Date | string;
  /** Created at or after. No default window. */
  dateFrom?: Date | string;
  dateTo?: Date | string;
  search?: string;
  locationIds?: string[];
  companyId?: string;
  cursor?: string;
  limit?: number;
}

export interface TopicCallSearch {
  dateFrom?: Date | string;
  dateTo?: Date | string;
  sentiment?: "positive" | "neutral" | "negative";
  outcome?: "completed" | "missed" | "pending";
  search?: string;
  locationIds?: string[];
  companyId?: string;
  cursor?: string;
  limit?: number;
}

export interface CallsPage extends Page<CallListItem> {
  /** Totals for every call that matches (all pages). */
  summary: CallsSummary;
}
export interface TasksPage extends Page<Task> {
  /** Counts by display status (ignores the `status` filter). */
  summary: TasksSummary;
}

type IterOpts<T> = Omit<T, "cursor"> & { maxItems?: number };

const CALL_FILTERS = [
  "phone", "text", "dateFrom", "dateTo", "status", "sentiment", "hasOpenTasks", "multiLeg",
  "locationIds", "companyId", "cursor", "limit",
];
const ALERT_FILTERS = [
  "alertName", "numbers", "text", "sentiment", "dateFrom", "dateTo", "locationIds", "topic", "companyId",
  "cursor", "limit",
];
const TASK_FILTERS = [
  "status", "todayStart", "callId", "taskId", "dueOn", "dateFrom", "dateTo", "search", "locationIds",
  "companyId", "cursor", "limit",
];
const TOPIC_FILTERS = ["dateFrom", "dateTo", "sentiment", "outcome", "search", "locationIds", "companyId", "cursor", "limit"];

function only(given: object, allowed: readonly string[], method: string): void {
  for (const [k, v] of Object.entries(given)) {
    if (v === undefined) continue;
    if (!allowed.includes(k)) {
      throw new FilterError(`"${k}" is not a filter of ${method}. Supported: ${allowed.join(", ")}.`);
    }
  }
}

function renameLocationIds(f: object): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) q[k === "locationIds" ? "location_id" : k] = v;
  return q;
}

/**
 * Conversation intelligence (frontline credentials): calls, transcripts, alerts, tasks, insights,
 * and webhook configuration. Also available directly on the client (`client.searchCalls(...)`).
 */
export class Intelligence {
  private roleCheck: Promise<Me> | null = null;

  constructor(
    private readonly c: Client,
    private readonly checkRole: boolean,
  ) {}

  // ------------------------------------------------------------------ account
  /** The signed-in user (`GET /me`). */
  async whoami(): Promise<Me> {
    return ((await this.c.account.getMe()).data ?? {}) as Me;
  }

  /** Throws `FrontlineRequiredError` unless this login is a frontline user. Checked once, then cached. */
  requireFrontline(): Promise<Me> {
    if (!this.roleCheck) {
      this.roleCheck = this.whoami().then((me) => {
        if (me.role !== "frontline_user") throw new FrontlineRequiredError(me.role ?? null);
        return me;
      });
      this.roleCheck.catch(() => {
        this.roleCheck = null;
      });
    }
    return this.roleCheck;
  }

  private async frontline(): Promise<void> {
    if (this.checkRole) await this.requireFrontline();
  }

  // ------------------------------------------------------------------ calls
  private callQuery(f: CallSearch): Record<string, unknown> {
    only(f, CALL_FILTERS, "searchCalls");
    if (f.phone !== undefined && f.text !== undefined) {
      throw new FilterError("Give phone or text, not both: the API has one search field.");
    }
    return {
      date_from: f.dateFrom,
      date_to: f.dateTo,
      status: f.status,
      sentiment: f.sentiment,
      has_open_tasks: f.hasOpenTasks,
      multi_leg: f.multiLeg,
      location_id: f.locationIds,
      company_id: f.companyId,
      search: f.phone ?? f.text,
      cursor: f.cursor,
      limit: f.limit,
    };
  }

  /** One page of calls, newest first, with totals for the whole filter in `summary`. */
  async searchCalls(filters: CallSearch = {}): Promise<CallsPage> {
    const q = this.callQuery(filters);
    await this.frontline();
    const page = await this.c.calls.listCalls(q as never);
    return { ...page, summary: page.raw.data?.summary ?? {} };
  }

  /** Every call that matches, following cursors with limit=100. Stop early with `maxItems`. */
  async *iterCalls(filters: IterOpts<CallSearch> = {}): AsyncGenerator<CallListItem> {
    const { maxItems, ...f } = filters;
    const q = this.callQuery(f);
    await this.frontline();
    yield* this.c.calls.iterCalls({ ...(q as object), maxItems } as never);
  }

  /** Full detail of one call. NotFoundError when the call is outside this login's view. */
  async getCall(callId: string): Promise<CallDetail> {
    await this.frontline();
    return ((await this.c.calls.getCall(callId)).data ?? {}) as CallDetail;
  }

  /** Transcript lines in order ("Speaker 1" … "Speaker N"; `name` when known). */
  async getTranscript(callId: string): Promise<TranscriptLine[]> {
    await this.frontline();
    return (await this.c.calls.getCallTranscript(callId)).data?.transcript ?? [];
  }

  /**
   * The call's recording link and when it expires. Nothing else from the conversation record is
   * returned. The link is a signed HTTPS URL to the WAV audio: fetch it with a plain GET and no
   * Authorization header (Range requests work). It is valid for 120 minutes. Treat it as a secret:
   * never log or store it, and call this again for a fresh link. `url` is null when the call has
   * no recording.
   */
  async getRecordingUrl(callId: string): Promise<RecordingLink> {
    const call = await this.getCall(callId);
    const v = (call as { vcon?: { recording_url?: string | null; recording_url_expires_at?: string | null } }).vcon;
    return { url: v?.recording_url ?? null, expiresAt: v?.recording_url_expires_at ?? null };
  }

  // ------------------------------------------------------------------ alerts
  private alertQuery(f: AlertSearch): Record<string, unknown> {
    only(f, ALERT_FILTERS, "searchAlerts");
    return {
      keyword: f.alertName,
      numbers: f.numbers,
      search: f.text,
      sentiment: f.sentiment,
      date_from: f.dateFrom,
      date_to: f.dateTo,
      location_id: f.locationIds,
      topic: f.topic,
      company_id: f.companyId,
      cursor: f.cursor,
      limit: f.limit,
    };
  }

  /** One page of First Alert hits, newest first. `total` counts every match. */
  async searchAlerts(filters: AlertSearch = {}): Promise<Page<Alert>> {
    const q = this.alertQuery(filters);
    await this.frontline();
    return this.c.alerts.listAlerts(q as never);
  }

  async *iterAlerts(filters: IterOpts<AlertSearch> = {}): AsyncGenerator<Alert> {
    const { maxItems, ...f } = filters;
    const q = this.alertQuery(f);
    await this.frontline();
    yield* this.c.alerts.iterAlerts({ ...(q as object), maxItems } as never);
  }

  /**
   * One alert by id (there is no alert detail endpoint: this searches by id, no date window).
   * Returns null when the alert is not visible. With `withCall: true` the call detail is added as `call`.
   */
  async getAlert(alertId: string, options: { withCall?: boolean } = {}): Promise<(Alert & { call?: CallDetail }) | null> {
    const id = alertId.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new FilterError("alertId must be a UUID.");
    }
    const page = await this.searchAlerts({ text: id, limit: 10 });
    const alert = page.items.find((a) => (a.id ?? "").toLowerCase() === id);
    if (!alert) return null;
    if (options.withCall && alert.call_id) return { ...alert, call: await this.getCall(alert.call_id) };
    return alert;
  }

  /** Alert totals for a window (default: 00:00 UTC seven days ago until now). */
  async getAlertsDashboard(
    filters: { dateFrom?: Date | string; dateTo?: Date | string; locationIds?: string[]; companyId?: string } = {},
  ): Promise<AlertsDashboard> {
    only(filters, ["dateFrom", "dateTo", "locationIds", "companyId"], "getAlertsDashboard");
    await this.frontline();
    return ((await this.c.alerts.getAlertsDashboard(renameLocationIds(filters) as never)).data ?? {}) as AlertsDashboard;
  }

  // ------------------------------------------------------------------ tasks
  /** One page of follow-up tasks, newest first. No default date window. */
  async listTasks(filters: TaskSearch = {}): Promise<TasksPage> {
    only(filters, TASK_FILTERS, "listTasks");
    await this.frontline();
    const page = await this.c.tasks.listTasks(renameLocationIds(filters) as never);
    return { ...page, summary: page.raw.summary ?? {} };
  }

  async *iterTasks(filters: IterOpts<TaskSearch> = {}): AsyncGenerator<Task> {
    const { maxItems, ...f } = filters;
    only(f, TASK_FILTERS, "iterTasks");
    await this.frontline();
    yield* this.c.tasks.iterTasks({ ...renameLocationIds(f), maxItems } as never);
  }

  // ------------------------------------------------------------------ insights
  /** Insights Hub dashboard for a window. `start` and `end` are required. */
  async getInsightsDashboard(filters: {
    start: Date | string;
    end: Date | string;
    trendingLimit?: number;
    locationIds?: string[];
    companyId?: string;
  }): Promise<InsightsDashboard> {
    only(filters, ["start", "end", "trendingLimit", "locationIds", "companyId"], "getInsightsDashboard");
    await this.frontline();
    return ((await this.c.insights.getInsightsDashboard(renameLocationIds(filters) as never)).data ?? {}) as InsightsDashboard;
  }

  /** One page of calls for a topic slug (from the dashboard's `topic_call_volumes`). */
  async listTopicCalls(slug: string, filters: TopicCallSearch = {}): Promise<Page<TopicCall>> {
    only(filters, TOPIC_FILTERS, "listTopicCalls");
    await this.frontline();
    return this.c.insights.listTopicCalls(slug, renameLocationIds(filters) as never);
  }

  async *iterTopicCalls(slug: string, filters: IterOpts<TopicCallSearch> = {}): AsyncGenerator<TopicCall> {
    const { maxItems, ...f } = filters;
    only(f, TOPIC_FILTERS, "iterTopicCalls");
    await this.frontline();
    yield* this.c.insights.iterTopicCalls(slug, { ...renameLocationIds(f), maxItems } as never);
  }

  // ------------------------------------------------------------------ webhook configuration
  /** The location's After Call webhook, or null when none is set. */
  async getAfterCallWebhook(locationId: string): Promise<AfterCallWebhook | null> {
    return ((await this.c.webhooks.getAfterCallWebhook(locationId)).data ?? null) as AfterCallWebhook | null;
  }

  /**
   * Set the location's After Call webhook (HTTPS). It receives every call at the location,
   * whatever users' number mappings say. `enabled: false` pauses it (there is no delete).
   */
  async setAfterCallWebhook(locationId: string, url: string, enabled = true): Promise<AfterCallWebhook> {
    if (!/^https:\/\//i.test(url)) throw new FilterError("The webhook URL must use HTTPS.");
    const r = await this.c.webhooks.saveAfterCallWebhook(locationId, { webhook_url: url, enabled });
    return (r.data ?? {}) as AfterCallWebhook;
  }

  /** Send the test event to the saved URL. Returns only whether your endpoint answered 2xx, and its status. */
  async testAfterCallWebhook(
    locationId: string,
  ): Promise<WebhookTestResult> {
    const d = (await this.c.webhooks.testAfterCallWebhook(locationId)).data ?? {};
    return { success: Boolean(d.success), http_status: d.http_status ?? null };
  }

  /** The location's First Alert webhook URL, or null. */
  async getFirstAlertWebhook(locationId: string): Promise<string | null> {
    return (await this.c.firstAlert.getFirstAlertConfig(locationId)).data?.webhook_url ?? null;
  }

  /**
   * Set (or, with null, clear) the location's First Alert webhook URL. Read → merge → write: the
   * configuration PUT would otherwise clear the monitored numbers.
   */
  async setFirstAlertWebhook(locationId: string, url: string | null) {
    if (url !== null && !/^https:\/\//i.test(url)) throw new FilterError("The webhook URL must use HTTPS.");
    return (await this.c.firstAlert.setWebhookUrl(locationId, url)).data ?? {};
  }

  /** Send a test request to `url` (default: the saved URL). Returns only success and your endpoint's status. */
  async testFirstAlertWebhook(locationId: string, url?: string): Promise<WebhookTestResult> {
    const target = url ?? (await this.getFirstAlertWebhook(locationId));
    if (!target) throw new FilterError("No First Alert webhook URL is set for this location; pass one.");
    const d = (await this.c.firstAlert.testFirstAlertWebhook(locationId, { url: target })).data ?? {};
    return { success: Boolean(d.success), http_status: d.status_code ?? null };
  }
}
