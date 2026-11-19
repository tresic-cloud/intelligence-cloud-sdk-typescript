import { describe, expect, it } from "vitest";
import {
  Deduplicator,
  FilterError,
  FrontlineRequiredError,
  isUnknownEvent,
  MAX_EVENT_BYTES,
  parseAfterCallEvent,
  PayloadTooLargeError,
  WebhookPayloadError,
  type AfterCallSummaryEvent,
} from "../../src/index.js";
import { FakeApi, id } from "./fake.js";

function frontline() {
  const api = new FakeApi();
  api.role = "frontline_user";
  const calls = Array.from({ length: 3 }, () => ({ id: id(), call_date: "2026-11-02T16:41:07Z", summary: "s", secret_flag: true }));
  api.on("GET", "/calls", (req) => ({
    status: 200,
    body: { data: { summary: { total_calls: 3 }, calls }, meta: { has_more: false, next_cursor: null, limit: Number(req.query.limit ?? 10) } },
  }));
  api.on("GET", "/alerts", (req) => ({
    status: 200,
    body: {
      data: { summary: { total: 1 }, alerts: req.query.search === "0193b6d0-2f3a-7b4c-9d5e-6f7a8b9c0d12" || !req.query.search ? [{ id: "0193b6d0-2f3a-7b4c-9d5e-6f7a8b9c0d12", call_id: calls[0]!.id, keywords: ["Upset Customer"] }] : [] },
      meta: { has_more: false, next_cursor: null },
    },
  }));
  api.on("GET", "/calls/{c}", () => ({ status: 200, body: { data: { id: calls[0]!.id } } }));
  return { api, c: api.client(), calls };
}

const q = (api: FakeApi, path: string) => api.calls.filter((x) => x.path === path).at(-1)!.query;

describe("filters", () => {
  it("maps phone/text to search; refuses both", async () => {
    const { api, c } = frontline();
    await c.searchCalls({ phone: "+1 (555) 555-0142" });
    expect(q(api, "/calls").search).toBe("+1 (555) 555-0142");
    await expect(c.searchCalls({ phone: "5550142", text: "loaner" })).rejects.toBeInstanceOf(FilterError);
  });

  it("refuses unknown filters before sending", async () => {
    const { api, c } = frontline();
    const before = api.calls.length;
    await expect(c.searchCalls({ direction: "inbound" } as never)).rejects.toThrow(/not a filter/);
    await expect(c.calls.listCalls({ call_type: "inbound" } as never)).rejects.toBeInstanceOf(FilterError);
    expect(api.calls.length).toBe(before);
  });

  it("sends Dates and offset timestamps as full RFC 3339 UTC; refuses date-only", async () => {
    const { api, c } = frontline();
    await c.searchCalls({ dateFrom: new Date(Date.UTC(2026, 10, 1)), dateTo: "2026-11-08T00:00:00-06:00" });
    expect(q(api, "/calls").date_from).toBe("2026-11-01T00:00:00Z");
    expect(q(api, "/calls").date_to).toBe("2026-11-08T06:00:00Z");
    await expect(c.searchCalls({ dateFrom: "2026-11-01" })).rejects.toThrow(/full timestamp/);
    await expect(c.searchCalls({ dateFrom: "2026-11-01T00:00:00" })).rejects.toBeInstanceOf(FilterError);
  });

  it("numbers: digits only, at most 25", async () => {
    const { api, c } = frontline();
    await c.searchAlerts({ numbers: ["+1 (555) 555-0142", "2101"] });
    // a North American number goes as its last 10 digits; extensions are unchanged
    expect(q(api, "/alerts").numbers).toBe("5555550142,2101");
    await expect(c.searchAlerts({ numbers: Array.from({ length: 26 }, (_, i) => `21${i}`) })).rejects.toThrow(/at most 25/);
  });

  it("location ids: UUIDs, at most 50", async () => {
    const { c } = frontline();
    await expect(c.searchCalls({ locationIds: ["nope"] })).rejects.toThrow(/UUID/);
    await expect(c.searchCalls({ locationIds: Array.from({ length: 51 }, () => id()) })).rejects.toThrow(/at most 50/);
  });

  it("enums, has_open_tasks and short search are checked", async () => {
    const { api, c } = frontline();
    await expect(c.searchCalls({ status: "COMPLETED" as never })).rejects.toThrow(/one of/);
    await expect(c.searchCalls({ hasOpenTasks: false as never })).rejects.toThrow(/only supports true/);
    await expect(c.searchCalls({ text: "a" })).rejects.toThrow(/at least 2/);
    await c.searchCalls({ hasOpenTasks: true, multiLeg: false, sentiment: "very_negative" });
    expect(q(api, "/calls")).toMatchObject({ has_open_tasks: "true", multi_leg: "false", sentiment: "very_negative" });
  });

  it("low-level lists accept reference names and camelCase", async () => {
    const api = new FakeApi();
    const c = api.client();
    await c.companies.listCompanies(api.resellerId, { is_active: true });
    await c.companies.listCompanies(api.resellerId, { isActive: false, limit: 5 });
    const lists = api.calls.filter((x) => x.path.endsWith("/companies"));
    expect(lists[0]!.query).toEqual({ is_active: "true" });
    expect(lists[1]!.query).toEqual({ is_active: "false", limit: "5" });
    await expect(c.companies.listCompanies(api.resellerId, { offset: 2 } as never)).rejects.toBeInstanceOf(FilterError);
    await expect(c.companies.listCompanies(api.resellerId, { limit: 500 })).rejects.toThrow(/at most 100/);
  });

  it("insights dashboard requires start and end", async () => {
    const { c } = frontline();
    await expect(c.insights.getInsightsDashboard({} as never)).rejects.toThrow(/required/);
  });
});

describe("intelligence helpers", () => {
  it("refuses admin logins with FrontlineRequiredError", async () => {
    const api = new FakeApi();
    await expect(api.client().searchCalls()).rejects.toBeInstanceOf(FrontlineRequiredError);
  });

  it("checks the role once", async () => {
    const { api, c } = frontline();
    await c.searchCalls();
    await c.searchCalls();
    expect(api.count("GET", "/me")).toBe(1);
  });

  it("searchCalls returns a page with summary and projected rows", async () => {
    const { c } = frontline();
    const p = await c.searchCalls({ limit: 3 });
    expect(p.items.length).toBe(3);
    expect(p.summary.total_calls).toBe(3);
    expect(p.total).toBe(3);
    expect(p.items[0]).not.toHaveProperty("secret_flag");
  });

  it("getAlert searches by lowercase id, adds the call, or returns null", async () => {
    const { api, c, calls } = frontline();
    const a = await c.getAlert("0193B6D0-2F3A-7B4C-9D5E-6F7A8B9C0D12", { withCall: true });
    expect(q(api, "/alerts").search).toBe("0193b6d0-2f3a-7b4c-9d5e-6f7a8b9c0d12");
    expect(a?.call?.id).toBe(calls[0]!.id);
    expect(await c.getAlert(id())).toBeNull();
  });

  it("webhook helpers: HTTPS only; First Alert URL set keeps numbers", async () => {
    const api = new FakeApi();
    const c = api.client();
    const loc = id();
    api.faConfig.set(loc, { webhook_url: null, connector_mappings: [{ id: id(), connector_id: "c1", connector_name: "x", monitored_numbers: ["2101"] }] });
    await expect(c.setAfterCallWebhook(loc, "http://hooks.example.com/x")).rejects.toBeInstanceOf(FilterError);
    await c.setFirstAlertWebhook(loc, "https://hooks.example.com/alerts");
    expect(api.faConfig.get(loc)).toEqual({ webhook_url: "https://hooks.example.com/alerts", connector_mappings: [{ connector_id: "c1", monitored_numbers: ["2101"] }] });
    api.on("POST", "/locations/{l}/first-alert/config/test-webhook", () => ({ status: 200, body: { data: { success: false, status_code: 500, message: "upstream detail: 192.0.2.10 refused" } } }));
    expect(await c.testFirstAlertWebhook(loc)).toEqual({ success: false, http_status: 500 });
  });
});

describe("webhook receiver", () => {
  const event = {
    version: "1.0",
    type: "end_of_call_summary",
    is_test: false,
    location_id: "0193b6c2-6b29-7a51-b0e4-1c8f3d5e7a02",
    timestamp: "2026-11-02T16:46:12Z",
    call: { id: "0193b6d0-1e2f-7a3b-8c4d-5e6f7a8b9c01", call_type: "inbound", duration_seconds: 284, call_date: "2026-11-02", extra: 1 },
    summary: { text: "t", sentiment: "negative" },
    location: { id: "0193b6c2-6b29-7a51-b0e4-1c8f3d5e7a02", company_id: "c", connector_id: "k" },
    unknown: "dropped",
  };

  it("parses strings, bytes and objects and drops undocumented fields", () => {
    for (const body of [JSON.stringify(event), new TextEncoder().encode(JSON.stringify(event)), event]) {
      const e = parseAfterCallEvent(body as never) as AfterCallSummaryEvent;
      expect(e.call.id).toBe(event.call.id);
      expect(e).not.toHaveProperty("unknown");
      expect(e.call).not.toHaveProperty("extra");
    }
  });

  it("refuses bodies that aren't JSON objects or are malformed events", () => {
    expect(() => parseAfterCallEvent("not json")).toThrow(WebhookPayloadError);
    expect(() => parseAfterCallEvent("[1]")).toThrow(WebhookPayloadError);
    expect(() => parseAfterCallEvent({ ...event, call: {} })).toThrow(/call.id/);
  });

  it("returns an UnknownEvent for other event types (answer 2xx and ignore)", () => {
    const e = parseAfterCallEvent({ version: "2.0", type: "something_new", data: { a: 1 } });
    expect(isUnknownEvent(e)).toBe(true);
    if (isUnknownEvent(e)) {
      expect(e.type).toBe("something_new");
      expect(e.version).toBe("2.0");
    }
    const noType = parseAfterCallEvent("{}");
    expect(isUnknownEvent(noType) && noType.type).toBe(null);
    expect(isUnknownEvent(parseAfterCallEvent(event as never))).toBe(false);
  });

  it("refuses bodies over 256 KB with PayloadTooLargeError", () => {
    const big = JSON.stringify({ ...event, pad: "x".repeat(MAX_EVENT_BYTES) });
    expect(() => parseAfterCallEvent(big)).toThrow(PayloadTooLargeError);
    expect(() => parseAfterCallEvent(new TextEncoder().encode(big))).toThrow(PayloadTooLargeError);
    expect(() => parseAfterCallEvent(JSON.stringify(event), { maxBytes: 10 })).toThrow(PayloadTooLargeError);
    expect(MAX_EVENT_BYTES).toBe(262144);
  });

  it("the after-call sample file parses", async () => {
    const fs = await import("node:fs");
    const raw = fs.readFileSync(new URL("../../examples/after-call-sample.json", import.meta.url), "utf8");
    const e = parseAfterCallEvent(raw);
    expect(isUnknownEvent(e)).toBe(false);
  });

  it("Deduplicator de-duplicates on call id with LRU eviction", async () => {
    const d = new Deduplicator({ maxSize: 2 });
    expect(await d.isDuplicate("a")).toBe(false);
    expect(await d.isDuplicate("a")).toBe(true);
    await d.isDuplicate("b");
    await d.isDuplicate("c"); // evicts a
    expect(await d.isDuplicate("a")).toBe(false);
    expect(await d.seen("c")).toBe(true); // deprecated alias, same meaning
  });
});
