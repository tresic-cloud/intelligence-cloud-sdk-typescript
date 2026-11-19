import { describe, expect, it } from "vitest";
import {
  ApiError,
  AuthError,
  ConflictError,
  ConnectorError,
  EXTENSION_CONFLICT_MESSAGE,
  MfaRequiredError,
  MemoryTokenStore,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../../src/index.js";
import { FakeApi, id } from "./fake.js";

describe("auth", () => {
  it("signs in lazily, once, and reuses the token", async () => {
    const api = new FakeApi();
    const c = api.client();
    expect(api.calls.length).toBe(0);
    await c.account.getMe();
    await c.account.getMe();
    expect(api.count("POST", "/auth/login")).toBe(1);
  });

  it("refreshes once on 401, stores the rotated pair before use, never resends a spent token", async () => {
    const api = new FakeApi();
    const writes: string[] = [];
    const store = new MemoryTokenStore();
    const spy = { get: () => store.get(), set: (t: any) => { writes.push(t ? `${t.accessToken}|${t.refreshToken}` : "null"); store.set(t); } };
    const c = api.client({ tokenStore: spy });
    await c.account.getMe();
    api.tokenN++; // server-side: current access token no longer valid
    await c.account.getMe();
    expect(api.count("POST", "/auth/refresh")).toBe(1);
    // spent marker written before the refresh call, new pair written before the retry
    expect(writes).toEqual(["access-1|refresh-1", "access-1|", "access-3|refresh-3"]);
    const lastMe = api.calls.filter((x) => x.path === "/me").at(-1)!;
    expect(lastMe.headers.authorization).toBe("Bearer access-3");
    expect(api.spentRefresh).toEqual(["refresh-1"]);
  });

  it("serialises concurrent refreshes behind one lock", async () => {
    const api = new FakeApi();
    const c = api.client();
    await c.account.getMe();
    api.tokenN++;
    await Promise.all([c.account.getMe(), c.account.getMe(), c.account.getMe(), c.account.getMe()]);
    expect(api.count("POST", "/auth/refresh")).toBe(1);
    expect(api.count("POST", "/auth/login")).toBe(1);
  });

  it("signs in again when the refresh token is refused", async () => {
    const api = new FakeApi();
    const c = api.client();
    await c.account.getMe();
    api.liveRefresh.clear();
    api.tokenN++;
    await c.account.getMe();
    expect(api.count("POST", "/auth/login")).toBe(2);
  });

  it("raises MfaRequiredError with the prescribed message", async () => {
    const api = new FakeApi();
    api.loginStatus = { status: 200, body: { status: "mfa_required" } };
    const err = await api.client().account.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(MfaRequiredError);
    expect(err.message).toBe("Integration users need MFA off for their company. API keys arrive in December 2026.");
  });

  it("waits 60 s once on a login 429", async () => {
    const api = new FakeApi();
    const sleeps: number[] = [];
    let n = 0;
    api.on("POST", "/auth/login", () => (n++ === 0 ? { status: 429, body: { error: { code: "RATE_LIMITED", message: "slow" } } } : { status: 200, body: api.tokens() }));
    await api.client({ sleep: async (ms) => void sleeps.push(ms) }).account.getMe();
    expect(sleeps).toEqual([60_000]);
    expect(api.count("POST", "/auth/login")).toBe(2);
  });

  it("logout calls the endpoint and forgets tokens (mock only)", async () => {
    const api = new FakeApi();
    const store = new MemoryTokenStore();
    const c = api.client({ tokenStore: store });
    await c.account.getMe();
    await c.logout();
    expect(api.count("POST", "/auth/logout")).toBe(1);
    expect(store.get()).toBeNull();
  });

  it("close() forgets tokens without calling logout", async () => {
    const api = new FakeApi();
    const store = new MemoryTokenStore();
    const c = api.client({ tokenStore: store });
    await c.account.getMe();
    await c.close();
    expect(api.count("POST", "/auth/logout")).toBe(0);
    expect(store.get()).toBeNull();
  });
});

describe("retries", () => {
  it("retries 429 with backoff and honours Retry-After", async () => {
    const api = new FakeApi();
    const sleeps: number[] = [];
    let n = 0;
    api.on("GET", "/products", () => (n++ < 2 ? { status: 429, body: {}, headers: { "retry-after": "7" } } : { status: 200, body: { data: [] } }));
    await api.client({ sleep: async (ms) => void sleeps.push(ms) }).products.listProducts();
    expect(sleeps).toEqual([7000, 7000]);
  });

  it("retries 5xx on GET up to 3 times, then raises", async () => {
    const api = new FakeApi();
    api.on("GET", "/products", () => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "busy" } } }));
    const err = await api.client().products.listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(api.count("GET", "/products")).toBe(4);
  });

  it("does not repeat a POST on 5xx without an Idempotency-Key", async () => {
    const api = new FakeApi();
    api.on("POST", "/resellers/{r}/companies", () => ({ status: 502, body: {} }));
    await api.client().companies.createCompany(api.resellerId, { company_name: "X", primary_admin_contact_name: "A B", primary_admin_contact_email: "a@example.com", primary_admin_contact_phone: "1" }).catch(() => {});
    expect(api.count("POST", "/resellers/{r}/companies")).toBe(1);
  });

  it("raises RateLimitError after the last 429", async () => {
    const api = new FakeApi();
    api.on("GET", "/products", () => ({ status: 429, body: { error: { code: "RATE_LIMITED", message: "slow" } }, headers: { "retry-after": "2" } }));
    const err = await api.client().products.listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(2);
  });
});

describe("errors", () => {
  const cases: [string, any, any, string | null, string, string][] = [
    ["error.code", 422, { error: { code: "VALIDATION_ERROR", message: "bad", request_id: "r1" } }, "VALIDATION_ERROR", "bad", "HTTP 422 VALIDATION_ERROR (request_id r1)"],
    ["error.type", 400, { error: { type: "invalid_parameter", message: "bad task" } }, "invalid_parameter", "bad task", "HTTP 400 invalid_parameter"],
    ["flat edge", 401, { statusCode: 401, message: "Unauthorized" }, null, "Unauthorized", "HTTP 401"],
    ["bare string", 400, { error: "Idempotency-Key header is required" }, null, "Idempotency-Key header is required", "HTTP 400"],
  ];
  for (const [name, status, body, code, serverMessage, text] of cases) {
    it(`normalises ${name}`, async () => {
      const api = new FakeApi();
      api.on("GET", "/products", () => ({ status, body }));
      const err = await api.client({ maxRetries: 0 }).products.listProducts().catch((e) => e);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.serverMessage).toBe(serverMessage);
      expect(err.message).toBe(text);
      expect(err).toBeInstanceOf(status === 401 ? AuthError : ValidationError);
    });
  }

  it("keeps the server's text out of the exception text", async () => {
    const api = new FakeApi();
    api.on("GET", "/products", () => ({ status: 422, body: { error: { code: "VALIDATION_ERROR", message: "number 5555550142 is invalid", request_id: "r9" } } }));
    const err = await api.client({ maxRetries: 0 }).products.listProducts().catch((e) => e);
    expect(String(err)).not.toMatch(/5555550142/);
    expect(err.message).toBe("HTTP 422 VALIDATION_ERROR (request_id r9)");
    expect(err.serverMessage).toBe("number 5555550142 is invalid");
  });

  it("maps a non-JSON 404 (URL too long) to NotFoundError with guidance", async () => {
    const api = new FakeApi();
    api.on("GET", "/products", () => ({ status: 404, text: "<html>nope</html>" }));
    const err = await api.client().products.listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toMatch(/Non-JSON 404/);
  });

  it("replaces the extension-conflict 409 text", async () => {
    const api = new FakeApi();
    const serverText = "Conflict: 2002 and 2008 are taken (example detail the SDK must not pass on)";
    api.on("PUT", "/companies/{c}/users/{u}/connector-mappings", () => ({ status: 409, body: { error: { code: "CONFLICT", message: serverText } } }));
    api.on("PATCH", "/locations/{l}/users/{u}/after-call-settings", () => ({ status: 409, body: { error: { code: "CONFLICT", message: serverText } } }));
    const c = api.client();
    const err = await c.users
      .setUserNumberMappings(id(), id(), { mappings: [{ connector_id: id(), monitored_numbers: ["2001", "2002", "2008"] }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe(EXTENSION_CONFLICT_MESSAGE);
    expect(err.extensions).toEqual(["2002", "2008"]);
    expect(String(err)).not.toMatch(/example detail/);
    const err2 = await c.afterCallSettings.updateUserAfterCallSettings(id(), id(), { connector_mappings: [] }).catch((e) => e);
    expect(err2).toBeInstanceOf(ConflictError);
    expect(err2.message).toBe(EXTENSION_CONFLICT_MESSAGE);
    expect(err2.extensions).toEqual([]);
  });

  it("never surfaces server text from test endpoints", async () => {
    const api = new FakeApi();
    api.on("POST", "/locations/{l}/connectors/test", () => ({ status: 200, body: { data: { success: false, error: "upstream detail: 192.0.2.10 refused" } } }));
    api.on("POST", "/locations/{l}/after-call/automation/test", () => ({ status: 422, body: { error: { code: "X", message: "upstream detail: 192.0.2.10 refused" } } }));
    const c = api.client();
    const r = await c.connectors.testConnector(id(), { type: "netsapiens", config: { api_url: "https://pbx.example.com/ns-api/v2", domain: "d", api_key: "k" } });
    expect(r).toEqual({ data: { success: false } });
    const err = await c.webhooks.testAfterCallWebhook(id()).catch((e) => e);
    expect(err.message).toBe("Request failed with HTTP 422.");
  });
});

describe("projection", () => {
  it("strips undocumented connector fields", async () => {
    const api = new FakeApi();
    const loc = id();
    const cid = api.addConnector(loc);
    const r = await api.client().connectors.getConnector(loc, cid);
    expect(JSON.stringify(r)).not.toMatch(/unexpected_ref|redacted/);
    expect(r.data?.config?.domain).toBe("d.example");
  });

  it("strips the invitation link and undocumented user fields", async () => {
    const api = new FakeApi();
    const cid = api.addCompany("Riverbend Auto Group");
    const r = await api.client().users.createCompanyUser(cid, { email: "sam@example.com", first_name: "Sam", last_name: "Ortiz", role: "frontline_user", location_ids: [id()], send_invitation: false, auth_method: "password" });
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/invitation_link|SECRET|external_id|meta/);
    expect(r.data?.attributes?.email).toBe("sam@example.com");
  });

  it("drops undocumented fields on /me and call detail", async () => {
    const api = new FakeApi();
    api.role = "frontline_user";
    const callId = id();
    api.on("GET", "/calls/{c}", () => ({
      status: 200,
      body: { data: { id: callId, summary: "s", unexpected_field: "x", vcon: { unexpected_id: "x", recording_url: "https://r.example.com/a.wav?sig=1", recording_url_expires_at: "2026-11-02T18:45:00Z", recording_mime_type: "audio/wav", unexpected_flag: "x" } } },
    }));
    const c = api.client();
    const me = await c.whoami();
    expect(me).not.toHaveProperty("unexpected_ref");
    const call = await c.getCall(callId);
    expect(JSON.stringify(call)).not.toMatch(/unexpected/);
    const rec = await c.getRecordingUrl(callId);
    expect(rec).toEqual({ url: "https://r.example.com/a.wav?sig=1", expiresAt: "2026-11-02T18:45:00Z" });
  });
});

describe("users", () => {
  it("sends an Idempotency-Key, reuses it on retry with Accept-Encoding: identity", async () => {
    const api = new FakeApi();
    const cid = api.addCompany("R");
    let n = 0;
    const seen: Record<string, string>[] = [];
    api.on("POST", "/companies/{c}/users", (req) => {
      seen.push(req.headers);
      return n++ === 0 ? { status: 503, body: {} } : { status: 201, body: { data: { type: "company_user", attributes: { id: id(), email: req.body.email } } } };
    });
    await api.client().users.createCompanyUser(cid, { email: "a@example.com", first_name: "A", last_name: "B", role: "frontline_user", location_ids: [id()], auth_method: "password" });
    expect(seen.length).toBe(2);
    expect(seen[0]!["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]!["idempotency-key"]).toBe(seen[0]!["idempotency-key"]);
    expect(seen[0]!["accept-encoding"]).toBeUndefined();
    expect(seen[1]!["accept-encoding"]).toBe("identity");
  });

  it("recovers the half-created user after a 422 (lookup by email, PATCH)", async () => {
    const api = new FakeApi();
    const cid = api.addCompany("R");
    const loc = api.addLocation(cid, "Main");
    api.on("POST", "/companies/{c}/users", (req) => {
      const uid = id("40");
      api.users.set(uid, { id: uid, company_id: cid, email: req.body.email, role: "frontline_user", status: "invited", location_ids: [], products: new Set(), first_name: "A", last_name: "B" });
      return { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "One or more locations not found" } } };
    });
    const r = await api.client().users.createCompanyUser(cid, { email: "Half@Example.com", first_name: "A", last_name: "B", role: "frontline_user", location_ids: [loc], auth_method: "password" });
    expect(r.data?.attributes?.locations).toEqual([{ location_id: loc }]);
    expect(api.seq().slice(-2)).toEqual([`GET /companies/${cid}/users`, `PATCH /companies/${cid}/users/${r.data?.attributes?.id}`]);
  });

  it("rethrows the 422 when no user was left behind", async () => {
    const api = new FakeApi();
    const cid = api.addCompany("R");
    api.on("POST", "/companies/{c}/users", () => ({ status: 422, body: { error: { code: "ROLE_NOT_ASSIGNABLE", message: "nope" } } }));
    const err = await api.client().users.createCompanyUser(cid, { email: "x@example.com", first_name: "A", last_name: "B", role: "frontline_user", auth_method: "password" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("ROLE_NOT_ASSIGNABLE");
  });
});

describe("connectors", () => {
  const body = { name: "Main phone system", type: "netsapiens" as const, config: { api_url: "https://pbx.example.com/ns-api/v2", domain: "d.example", api_key: "k" } };

  it("checks create every 10 seconds until active", async () => {
    const api = new FakeApi();
    api.connectorPlan = ["connecting", "connecting", "active"];
    const sleeps: number[] = [];
    const r = await api.client({ sleep: async (ms) => void sleeps.push(ms) }).connectors.createConnector(id(), body);
    expect(r.data?.status).toBe("active");
    expect(api.count("GET", "/locations/{l}/connectors/{c}")).toBe(3);
    expect(sleeps).toEqual([10_000, 10_000]);
  });

  it("gives up after 10 minutes by default", async () => {
    const api = new FakeApi();
    api.connectorPlan = ["connecting"];
    let t = 0;
    const err = await api.client({ now: () => (t += 10_000) }).connectors.createConnector(id(), body).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(api.count("GET", "/locations/{l}/connectors/{c}")).toBeLessThanOrEqual(61);
  });

  it("raises ConnectorError(stateReason) when it ends in error", async () => {
    const api = new FakeApi();
    api.connectorPlan = ["connecting", "error"];
    const err = await api.client().connectors.createConnector(id(), body).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.stateReason).toBe("invalid_permissions");
  });

  it("times out with ConnectorError", async () => {
    const api = new FakeApi();
    api.connectorPlan = ["connecting"];
    let t = 0;
    const err = await api.client({ now: () => (t += 10_000) }).connectors.createConnector(id(), body, { timeout: 30 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.message).toMatch(/did not settle/);
  });

  it("returns at once with wait: false", async () => {
    const api = new FakeApi();
    const r = await api.client().connectors.createConnector(id(), body, { wait: false });
    expect(r.data?.status).toBe("connecting");
    expect(api.count("GET", "/locations/{l}/connectors/{c}")).toBe(0);
  });

  it("waits for deactivate until inactive", async () => {
    const api = new FakeApi();
    const loc = id();
    const cid = api.addConnector(loc);
    const r = await api.client().connectors.deactivateConnector(loc, cid);
    expect(r.data?.status).toBe("inactive");
  });
});

describe("paging", () => {
  it("iterators follow cursors with limit=100 and unwrap rows", async () => {
    const api = new FakeApi();
    for (let i = 0; i < 230; i++) api.addCompany(`Co ${String(i).padStart(3, "0")}`);
    const c = api.client();
    const names: string[] = [];
    for await (const row of c.companies.iterCompanies(api.resellerId)) names.push(row.company_name!);
    expect(names.length).toBe(230);
    const lists = api.calls.filter((x) => x.path.endsWith("/companies"));
    expect(lists.length).toBe(3);
    expect(lists.every((x) => x.query.limit === "100")).toBe(true);
    expect(lists[1]!.query.cursor).toBeTruthy();
  });

  it("maxItems stops early; list methods return one Page", async () => {
    const api = new FakeApi();
    for (let i = 0; i < 30; i++) api.addCompany(`Co ${i}`);
    const c = api.client();
    const got: unknown[] = [];
    for await (const row of c.companies.iterCompanies(api.resellerId, { maxItems: 5 })) got.push(row);
    expect(got.length).toBe(5);
    const page = await c.companies.listCompanies(api.resellerId, { limit: 10 });
    expect(page.items.length).toBe(10);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(30);
    expect(page.items[0]).toHaveProperty("company_name");
  });
});
