import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  FileTokenStore,
  FilterError,
  PasswordExpiredError,
  RateLimitError,
  type NewUser,
  type SeatCustomer,
} from "../../src/index.js";
import { FakeApi, id } from "./fake.js";

const PHRASES = ["placeholder phrase one", "placeholder phrase two"];
const spec = {
  companyName: "Riverbend Auto Group",
  primaryAdmin: { name: "Jordan Lee", email: "jordan.lee@example.com", phone: "+15555550142" },
  mfaOff: true,
  location: { name: "Riverbend - Main", street: "100 River Rd", city: "Springfield", state: "IL", country: "United States", zipcode: "62701" },
  threatPhrases: PHRASES,
};
const u = (n: number): NewUser => ({ email: `user${n}@example.com`, firstName: "U", lastName: String(n), sendInvitation: false });
const writes = (api: FakeApi, mark = 0) => api.calls.slice(mark).filter((x) => x.method !== "GET" && !x.path.startsWith("/auth"));

async function seeded() {
  const api = new FakeApi();
  const c = api.client();
  const res = await c.provisionSeatCustomer(spec);
  const conn = api.addConnector(res.locationId, "active");
  const customer: SeatCustomer = { ...res, connectorId: conn, connectorStatus: "active" };
  return { api, c, customer, conn };
}
const nums = (api: FakeApi, uid: string) => api.mappings.get(uid)?.[0]?.monitored_numbers ?? [];
const fa = (api: FakeApi, loc: string) => api.faConfig.get(loc)?.connector_mappings?.[0]?.monitored_numbers ?? [];
const ih = (api: FakeApi, loc: string) => api.ihSetup.get(loc)?.connector_mappings?.[0]?.monitored_numbers ?? [];

describe("provisionSeatCustomer never adopts a same-named company", () => {
  it("refuses a same-named company with another contact, before any write", async () => {
    const api = new FakeApi();
    api.addCompany("Riverbend Auto Group", { primary_admin_contact_email: "someone.else@example.com" });
    const err = await api.client().provisionSeatCustomer(spec).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe("company_name_conflict");
    expect(err.message).toMatch(/Pass companyId/);
    expect(writes(api)).toEqual([]);
  });

  it("reuses a company whose name and contact email both match", async () => {
    const api = new FakeApi();
    const cid = api.addCompany("Riverbend Auto Group", { primary_admin_contact_email: "Jordan.Lee@example.com" });
    const r = await api.client().provisionSeatCustomer(spec);
    expect(r.companyId).toBe(cid);
    expect(r.created).not.toContain("company");
    expect(r.existing).toContain("company");
  });

  it("with two same-named companies uses only the one whose contact matches", async () => {
    const api = new FakeApi();
    api.addCompany("Riverbend Auto Group", { primary_admin_contact_email: "someone.else@example.com" });
    const mine = api.addCompany("Riverbend Auto Group", { primary_admin_contact_email: "jordan.lee@example.com" });
    const r = await api.client().provisionSeatCustomer(spec);
    expect(r.companyId).toBe(mine);
  });

  it("uses an explicit companyId even when another company has the same name", async () => {
    const api = new FakeApi();
    api.addCompany("Riverbend Auto Group", { primary_admin_contact_email: "someone.else@example.com" });
    const target = api.addCompany("Riverbend Auto Group", { primary_admin_contact_email: "x@example.com" });
    const r = await api.client().provisionSeatCustomer({ ...spec, companyId: target });
    expect(r.companyId).toBe(target);
    expect(api.count("POST", "/resellers/{r}/companies")).toBe(0);
  });
});

describe("integration users are never seats or managers", () => {
  it("addIntegrationUser tags, maps all lines, email off; lists leave it out", async () => {
    const { api, c, customer } = await seeded();
    const m = await c.addManager(customer, u(1));
    await c.addFrontlineUser(customer, u(2), "2101");
    await c.addFrontlineUser(customer, u(3), "2102");
    const i = await c.addIntegrationUser(customer, { ...u(9), email: "crm-sync@example.com" });
    expect(i.kind).toBe("integration");
    expect(api.users.get(i.userId).department).toBe("integration");
    expect(nums(api, i.userId).sort()).toEqual(["2101", "2102"]);
    const prefs = api.calls.filter((x) => x.path === `/locations/${customer.locationId}/users/${i.userId}/first-alert/email-preferences`).at(-1)!.body;
    expect(prefs).toEqual({ masterEnabled: false, alerts: [] });
    expect((await c.listManagers(customer)).map((x) => x.id)).toEqual([m.userId]);
    expect((await c.listFrontlineUsers(customer)).map((x) => x.id)).not.toContain(i.userId);
    expect((await c.listIntegrationUsers(customer)).map((x) => x.id)).toEqual([i.userId]);
    // a new end user's line reaches the integration user too
    const d = await c.addFrontlineUser(customer, u(4), "2103");
    expect(nums(api, i.userId)).toContain("2103");
    expect(d.managersUpdated.sort()).toEqual([m.userId, i.userId].sort());
  });

  it("refuses an integration user that signs in with SSO", async () => {
    const { c, customer } = await seeded();
    await expect(c.addIntegrationUser(customer, { ...u(9), authMethod: "sso" })).rejects.toBeInstanceOf(FilterError);
  });

  it("removing an integration user keeps every manager, First Alert and Insights Hub line", async () => {
    const { api, c, customer } = await seeded();
    const m = await c.addManager(customer, u(1));
    await c.addFrontlineUser(customer, u(2), "2101");
    await c.addFrontlineUser(customer, u(3), "2102");
    const i = await c.addIntegrationUser(customer, u(9));
    const r = await c.removeUser(customer, i.userId);
    expect(r.kind).toBe("integration");
    expect(r.extensionsReleased).toEqual([]);
    expect(nums(api, m.userId).sort()).toEqual(["2101", "2102"]);
    expect(fa(api, customer.locationId).sort()).toEqual(["2101", "2102"]);
    expect(ih(api, customer.locationId).sort()).toEqual(["2101", "2102"]);
    expect(api.users.get(i.userId).status).toBe("deactivated");
  });

  it("removing an untagged After-Call-only user mapped to every line releases nothing", async () => {
    const { api, c, customer, conn } = await seeded();
    const m = await c.addManager(customer, u(1));
    await c.addFrontlineUser(customer, u(2), "2101");
    await c.addFrontlineUser(customer, u(3), "2102");
    const dataUser = api.addUser(customer.companyId, customer.locationId, "data@example.com", ["after-call-copilot"], "active");
    api.mappings.set(dataUser, [{ connector_id: conn, monitored_numbers: ["2101", "2102"] }]);
    // it isn't a seat: its lines don't count, and sync leaves the lines alone
    const dry = await c.syncNumbers(customer, { dryRun: true });
    expect(dry.lines.sort()).toEqual(["2101", "2102"]);
    const r = await c.removeUser(customer, dataUser);
    expect(r.kind).toBe("integration");
    expect(r.extensionsReleased).toEqual([]);
    expect(nums(api, m.userId).sort()).toEqual(["2101", "2102"]);
    expect(fa(api, customer.locationId).sort()).toEqual(["2101", "2102"]);
  });

  it("an end user's line another end user still holds is not released", async () => {
    const { api, c, customer } = await seeded();
    const m = await c.addManager(customer, u(1));
    const a = await c.addFrontlineUser(customer, u(2), "2101");
    await c.addFrontlineUser(customer, u(3), "2101"); // a shared line
    const r = await c.removeUser(customer, a.userId);
    expect(r.kind).toBe("frontline");
    expect(r.extensionsReleased).toEqual([]);
    expect(nums(api, m.userId)).toEqual(["2101"]);
    expect(fa(api, customer.locationId)).toEqual(["2101"]);
  });

  it("syncNumbers gives integration users exactly the lines", async () => {
    const { api, c, customer, conn } = await seeded();
    await c.addFrontlineUser(customer, u(2), "2101");
    const i = await c.addIntegrationUser(customer, u(9));
    api.mappings.set(i.userId, [{ connector_id: conn, monitored_numbers: ["2101", "2999"] }]);
    await c.addFrontlineUser(customer, u(3), "2102");
    await c.syncNumbers(customer);
    expect(nums(api, i.userId).sort()).toEqual(["2101", "2102"]);
  });

  it("excludeUserIds and excludeEmails hide users from every workflow", async () => {
    const { api, c, customer } = await seeded();
    const m = await c.addManager(customer, u(1));
    const other = await c.addManager(customer, u(5));
    const ex: SeatCustomer = { ...customer, excludeUserIds: [other.userId], excludeEmails: ["USER6@example.com"] };
    const six = await c.addManager(ex, u(6));
    expect((await c.listManagers(ex)).map((x) => x.id)).toEqual([m.userId]);
    await c.addFrontlineUser(ex, u(2), "2101");
    expect(nums(api, m.userId)).toEqual(["2101"]);
    expect(nums(api, other.userId)).toEqual([]);
    expect(nums(api, six.userId)).toEqual([]);
  });
});

describe("connector re-runs", () => {
  const connector = { apiUrl: "https://pbx.example.com/ns-api/v2", domain: "riverbend.example.com", apiKey: "NEW" };

  it("a connector in error gets the new key and is restarted", async () => {
    const api = new FakeApi();
    api.connectorPlan = ["connecting", "error"];
    const c = api.client();
    const first = await c.provisionSeatCustomer({ ...spec, connector });
    expect(first.connectorStatus).toBe("error");
    api.connectorPlan = ["error"]; // still in error until it is restarted with the fixed key
    api.reactivatePlan = ["connecting", "active"];
    const mark = api.calls.length;
    const again = await c.provisionSeatCustomer({ ...spec, connector });
    const w = writes(api, mark).map((x) => `${x.method} ${x.path.replace(/[0-9a-f-]{36}/g, ":id")}`);
    expect(w).toContain("PATCH /locations/:id/connectors/:id");
    expect(w).toContain("POST /locations/:id/connectors/:id/reactivate");
    expect(w).not.toContain("POST /locations/:id/connectors");
    const patch = writes(api, mark).find((x) => x.method === "PATCH" && x.path.includes("/connectors/"))!;
    expect(patch.body.config).toEqual({ api_url: connector.apiUrl, domain: connector.domain, api_key: "NEW" });
    expect(again.connectorId).toBe(first.connectorId);
    expect(again.connectorStatus).toBe("active");
    expect(again.existing).toContain("connector:updated");
  });

  it("reuses a connector for the same domain under another name", async () => {
    const api = new FakeApi();
    const c = api.client();
    const r = await c.provisionSeatCustomer(spec);
    const existingConn = api.addConnector(r.locationId, "active", "Old name");
    api.connectors.get(existingConn).config.domain = "Riverbend.Example.com";
    const again = await c.provisionSeatCustomer({ ...spec, connector });
    expect(again.connectorId).toBe(existingConn);
    expect(api.count("POST", "/locations/{l}/connectors")).toBe(0);
    expect(api.connectors.size).toBe(1);
  });
});

describe("offboardCustomer", () => {
  it("pauses webhooks, stops the connector, deactivates integration users, then the company", async () => {
    const { api, c, customer, conn } = await seeded();
    const i = await c.addIntegrationUser(customer, u(9));
    api.afterCallHooks.set(customer.locationId, { webhook_url: "https://hooks.example.com/ic/x", enabled: true });
    api.faConfig.set(customer.locationId, { webhook_url: "https://hooks.example.com/fa/x", connector_mappings: [{ connector_id: conn, monitored_numbers: ["2101"] }] });
    const mark = api.calls.length;
    const r = await c.offboardCustomer(customer);
    expect(r).toEqual({ webhookPaused: true, firstAlertWebhookCleared: true, connectorDeactivated: true, integrationUsersDeactivated: [i.userId], companyDeactivated: true });
    const w = writes(api, mark).map((x) => `${x.method} ${x.path.replace(/[0-9a-f-]{36}/g, ":id")}`);
    expect(w).toEqual([
      "PUT /locations/:id/after-call/automation",
      "PUT /locations/:id/first-alert/config",
      "POST /locations/:id/connectors/:id/deactivate",
      "POST /companies/:id/users/:id/deactivate",
      "POST /companies/:id/deactivate",
    ]);
    expect(api.afterCallHooks.get(customer.locationId)).toEqual({ webhook_url: "https://hooks.example.com/ic/x", enabled: false });
    expect(api.faConfig.get(customer.locationId)).toEqual({ webhook_url: null, connector_mappings: [{ connector_id: conn, monitored_numbers: ["2101"] }] });
    // a second run finds everything done
    const again = await c.offboardCustomer(customer);
    expect(again).toEqual({ webhookPaused: false, firstAlertWebhookCleared: false, connectorDeactivated: false, integrationUsersDeactivated: [], companyDeactivated: false });
  });
});

describe("transport and auth", () => {
  it("refuses a non-https base URL except on localhost", () => {
    const api = new FakeApi();
    expect(() => api.client({ baseUrl: "http://api.example.com/api/v1" })).toThrow(FilterError);
    expect(() => api.client({ baseUrl: "http://localhost:8080/api/v1" })).not.toThrow();
    expect(() => api.client({ baseUrl: "http://127.0.0.1:8080/api/v1" })).not.toThrow();
  });

  it("does not wait on a Retry-After over 60 seconds: raises RateLimitError", async () => {
    const api = new FakeApi();
    const sleeps: number[] = [];
    api.on("GET", "/products", () => ({ status: 429, body: {}, headers: { "retry-after": "3600" } }));
    const err = await api.client({ sleep: async (ms) => void sleeps.push(ms) }).products.listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(3600);
    expect(sleeps).toEqual([]);
    expect(api.count("GET", "/products")).toBe(1);
  });

  it("a rate-limited refresh retries the same refresh token and never signs in", async () => {
    const api = new FakeApi();
    const sleeps: number[] = [];
    const c = api.client({ sleep: async (ms) => void sleeps.push(ms) });
    await c.account.getMe();
    let n = 0;
    const seen: string[] = [];
    api.on("POST", "/auth/refresh", (req) => {
      seen.push(req.body.refresh_token);
      if (n++ < 2) return { status: 429, body: {}, headers: { "retry-after": "2" } };
      api.liveRefresh.delete(req.body.refresh_token);
      return { status: 200, body: api.tokens() };
    });
    api.tokenN++;
    await c.account.getMe();
    expect(seen).toEqual(["refresh-1", "refresh-1", "refresh-1"]);
    expect(api.count("POST", "/auth/login")).toBe(1);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("raises RateLimitError when the refresh stays rate limited, and keeps the token for later", async () => {
    const api = new FakeApi();
    const store = new (await import("../../src/index.js")).MemoryTokenStore();
    const c = api.client({ tokenStore: store });
    await c.account.getMe();
    api.on("POST", "/auth/refresh", () => ({ status: 429, body: {} }));
    api.tokenN++;
    const err = await c.account.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(api.count("POST", "/auth/login")).toBe(1);
    expect(store.get()?.refreshToken).toBe("refresh-1");
  });

  it("loginRateLimitWait: 0 raises at once on a login 429", async () => {
    const api = new FakeApi();
    api.loginStatus = { status: 429, body: {} };
    const sleeps: number[] = [];
    const err = await api.client({ loginRateLimitWait: 0, sleep: async (ms) => void sleeps.push(ms) }).account.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(sleeps).toEqual([]);
  });

  it("raises PasswordExpiredError on a password_expired sign-in", async () => {
    const api = new FakeApi();
    api.loginStatus = { status: 200, body: { ...api.tokens(), password_expired: true } };
    const err = await api.client().account.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(PasswordExpiredError);
    expect(err.code).toBe("password_expired");
  });

  it("runs sign-in and renewal inside the store's lock", async () => {
    const api = new FakeApi();
    const events: string[] = [];
    let t: any = null;
    const store = {
      get: () => t,
      set: (x: any) => void (t = x),
      withLock: async <T>(fn: () => Promise<T>) => {
        events.push("lock");
        try {
          return await fn();
        } finally {
          events.push("unlock");
        }
      },
    };
    const c = api.client({ tokenStore: store });
    await c.account.getMe();
    api.tokenN++;
    await c.account.getMe();
    expect(events).toEqual(["lock", "unlock", "lock", "unlock"]);
  });

  it("reuses tokens another process renewed while it waited for the lock", async () => {
    const api = new FakeApi();
    let t: any = null;
    const store = { get: () => t, set: (x: any) => void (t = x), withLock: async <T>(fn: () => Promise<T>) => {
      // another process renewed first
      t = { accessToken: `access-${api.tokenN}`, refreshToken: "refresh-other", expiresAt: Date.now() + 900_000 };
      return fn();
    } };
    const c = api.client({ tokenStore: store });
    await c.account.getMe();
    expect(api.count("POST", "/auth/login")).toBe(0);
  });
});

describe("keepUnknownFields", () => {
  it("keeps unknown fields but always removes the deny-list and reduces vcon", async () => {
    const api = new FakeApi();
    api.role = "frontline_user";
    const callId = id();
    api.on("GET", "/calls/{c}", () => ({
      status: 200,
      body: { data: { id: callId, new_field: "kept", analysis: { unexpected_field: 1, nested: [{ ok: 1 }] }, unexpected_ref: "x", vcon: { unexpected_id: "x", recording_url: "https://r.example.com/a.wav" } } },
    }));
    const loc = id();
    const cid = api.addConnector(loc);
    api.connectors.get(cid).config.secret_ref = "secret-value";
    api.connectors.get(cid).new_field = "kept";
    const c = api.client({ keepUnknownFields: true });
    const call: any = await c.calls.getCall(callId);
    expect(call.data).not.toHaveProperty("new_field"); // conversation data is always projected
    expect(JSON.stringify(call)).not.toMatch(/unexpected_field|_ref|unexpected_id/);
    expect(call.data.vcon).toEqual({ recording_url: "https://r.example.com/a.wav" });
    const conn: any = await c.connectors.getConnector(loc, cid);
    expect(JSON.stringify(conn)).not.toMatch(/secret-value/);
    expect(conn.data.new_field).toBe("kept"); // lifecycle reads keep new fields
    const me: any = await c.whoami();
    expect(me).not.toHaveProperty("unexpected_ref"); // /me is always projected
    const plain: any = await api.client().calls.getCall(callId);
    expect(plain.data).not.toHaveProperty("new_field");
  });
});

describe("filters", () => {
  it("dueOn sends the local calendar date", async () => {
    const api = new FakeApi();
    api.role = "frontline_user";
    api.on("GET", "/tasks", () => ({ status: 200, body: { data: [], pagination: { has_more: false } } }));
    const c = api.client();
    await c.listTasks({ dueOn: new Date(2026, 10, 2, 23, 30) });
    expect(api.calls.filter((x) => x.path === "/tasks").at(-1)!.query.due_on).toBe("2026-11-02");
  });
});

describe("FileTokenStore", () => {
  it("stores tokens with mode 0600, and the lock serialises callers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ic-tokens-"));
    try {
      const path = join(dir, "t.json");
      const a = new FileTokenStore(path, { retryMs: 5 });
      const b = new FileTokenStore(path, { retryMs: 5 });
      expect(await a.get()).toBeNull();
      await a.set({ accessToken: "A", refreshToken: "R", expiresAt: 1 });
      expect(await b.get()).toEqual({ accessToken: "A", refreshToken: "R", expiresAt: 1 });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const order: string[] = [];
      const slow = (name: string) => async () => {
        order.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`${name}:out`);
      };
      await Promise.all([a.withLock(slow("a")), b.withLock(slow("b"))]);
      expect(order[1]).toBe(`${order[0]!.split(":")[0]}:out`);
      await a.set(null);
      expect(await a.get()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
