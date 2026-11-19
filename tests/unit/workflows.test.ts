import { describe, expect, it } from "vitest";
import { ExtensionMappingError, FilterError, THREAT_PHRASES_MISSING, ValidationError, WorkflowError, type NewUser, type SeatCustomer } from "../../src/index.js";
import { FakeApi } from "./fake.js";

// placeholder phrases: the real list comes from your Tresic contact
const PHRASES = ["placeholder phrase one", "placeholder phrase two"];

const spec = {
  companyName: "Riverbend Auto Group",
  primaryAdmin: { name: "Jordan Lee", email: "jordan.lee@example.com", phone: "+15555550142" },
  mfaOff: true,
  location: { name: "Riverbend - Main", street: "100 River Rd", city: "Springfield", state: "IL", country: "United States", zipcode: "62701" },
  threatPhrases: PHRASES,
};

/** A provisioned customer with a connector and some users. */
async function seeded(connectorStatus = "active") {
  const api = new FakeApi();
  const c = api.client();
  const res = await c.provisionSeatCustomer(spec);
  const conn = api.addConnector(res.locationId, connectorStatus);
  const customer: SeatCustomer = { ...res, connectorId: conn, connectorStatus };
  return { api, c, customer, conn };
}

describe("provisionSeatCustomer", () => {
  it("builds the whole Seat customer in order", async () => {
    const api = new FakeApi();
    const c = api.client();
    const r = await c.provisionSeatCustomer({ ...spec, sso: { domain: "riverbendauto.example.com" } }).catch((e) => e);
    // SSO route isn't faked: the workflow reports the failing step and what was done
    expect(r).toBeInstanceOf(WorkflowError);
    expect(r.step).toBe("sso_domain");
    expect(r.partial.companyId).toBeTruthy();

    const api2 = new FakeApi();
    const res = await api2.client().provisionSeatCustomer(spec);
    expect(res.created).toEqual(["company", "location", "group:Manager Alerts", "group:Insights Hub Access", "rule:Upset Customer", "rule:Customer Threat"]);
    const company = api2.companies.get(res.companyId);
    expect(company.mfa_enforced).toBe(false);
    expect(company.enabled_products.sort()).toEqual(["after-call-copilot", "first-alert-copilot", "insights-hub"]);
    const upset = api2.rules.get(res.rules.upsetCustomer!);
    const threat = api2.rules.get(res.rules.customerThreat!);
    expect(upset).toMatchObject({ priority: "high", match_logic: "any", enabled: false, triggers: [{ trigger_type: "sentiment", config: { operator: "lt", threshold: -40 } }] });
    expect(threat.triggers).toEqual([
      { trigger_type: "sentiment", config: { operator: "lt", threshold: -20 } },
      { trigger_type: "keyword_match", config: { match_logic: "any", keywords: PHRASES } },
    ]);
    expect(threat).toMatchObject({ priority: "critical", match_logic: "all" });
    expect(upset.group_ids).toEqual([res.groups.managerAlerts]);
    // rules created switched off, and left off (addManager / activateSeatAlerts switch them on)
    expect(threat.enabled).toBe(false);
    expect(api2.count("PATCH", "/locations/{l}/first-alert/rules/{r}")).toBe(0);
    const posts = api2.calls.filter((x) => x.method === "POST" && x.path.endsWith("/first-alert/rules"));
    expect(posts.every((x) => x.body.enabled === false)).toBe(true);
    expect(api2.ihSetup.get(res.locationId).group_access).toEqual([res.groups.insightsHubAccess]);
    expect(api2.ihConfig.get(res.locationId)).toBe(true);
    const order = api2.seq().map((s) => s.replace(/[0-9a-f-]{36}/g, ":id"));
    expect(order.indexOf("POST /resellers/:id/companies")).toBeLessThan(order.indexOf("PATCH /companies/:id"));
    expect(order.indexOf("POST /companies/:id/locations")).toBeLessThan(order.indexOf("POST /locations/:id/user-groups"));
  });

  it("is idempotent: a re-run creates nothing", async () => {
    const api = new FakeApi();
    const c = api.client();
    const a = await c.provisionSeatCustomer(spec);
    const n = api.calls.length;
    const b = await c.workflows.provisionSeatCustomer(spec);
    expect(b.created).toEqual([]);
    expect(b.companyId).toBe(a.companyId);
    expect(b.rules).toEqual(a.rules);
    const writes = api.calls.slice(n).filter((x) => x.method !== "GET");
    expect(writes).toEqual([]);
  });

  it("does not touch MFA unless mfaOff", async () => {
    const api = new FakeApi();
    const r = await api.client().provisionSeatCustomer({ ...spec, mfaOff: false });
    expect(api.companies.get(r.companyId).mfa_enforced).toBe(true);
  });

  it("needs the Customer Threat phrases from the caller", async () => {
    const api = new FakeApi();
    const err = await api.client().provisionSeatCustomer({ ...spec, threatPhrases: undefined }).catch((e) => e);
    expect(err).toBeInstanceOf(FilterError);
    expect(err.message).toBe(THREAT_PHRASES_MISSING);
    expect(api.calls.filter((x) => x.method !== "GET" && !x.path.startsWith("/auth"))).toEqual([]);
  });

  it("re-runs without phrases when the rule already exists", async () => {
    const api = new FakeApi();
    const c = api.client();
    await c.provisionSeatCustomer(spec);
    const r = await c.provisionSeatCustomer({ ...spec, threatPhrases: undefined });
    expect(r.created).toEqual([]);
  });

  it("creates the connector and maps monitored numbers once active", async () => {
    const api = new FakeApi();
    const r = await api.client().provisionSeatCustomer({
      ...spec,
      connector: { apiUrl: "https://pbx.example.com/ns-api/v2", domain: "d.example", apiKey: "k", monitoredNumbers: ["2101", "2102"] },
    });
    expect(r.connectorStatus).toBe("active");
    expect(api.faConfig.get(r.locationId).connector_mappings).toEqual([{ connector_id: r.connectorId, monitored_numbers: ["2101", "2102"] }]);
    expect(api.ihSetup.get(r.locationId).connector_mappings).toEqual([{ connector_id: r.connectorId, monitored_numbers: ["2101", "2102"] }]);
  });

  it("records a connector in error on the result instead of raising", async () => {
    const api = new FakeApi();
    api.connectorPlan = ["connecting", "error"];
    const r = await api.client().provisionSeatCustomer({ ...spec, connector: { apiUrl: "https://pbx.example.com/ns-api/v2", domain: "d", apiKey: "k" } });
    expect(r.connectorStatus).toBe("error");
    expect(r.connectorStateReason).toBe("invalid_permissions");
    expect(r.created).toContain("connector");
  });

  it("refuses a deactivated company unless reactivate: true", async () => {
    const api = new FakeApi();
    const c = api.client();
    const r = await c.provisionSeatCustomer(spec);
    api.companies.get(r.companyId).is_active = false;
    api.locations.get(r.locationId).is_active = false;
    await expect(c.provisionSeatCustomer(spec)).rejects.toThrow(/reactivate: true/);
    api.on("POST", "/companies/{c}/reactivate", (_, m) => { api.companies.get(m[1]!).is_active = true; return { status: 200, body: {} }; });
    api.on("POST", "/companies/{c}/locations/{l}/reactivate", (_, m) => { api.locations.get(m[2]!).is_active = true; return { status: 200, body: {} }; });
    const again = await c.provisionSeatCustomer({ ...spec, reactivate: true });
    expect(again.companyId).toBe(r.companyId);
    expect(api.companies.get(r.companyId).is_active).toBe(true);
    expect(api.locations.get(r.locationId).is_active).toBe(true);
  });

  it("updates the Customer Threat phrases on a re-run with a new list", async () => {
    const api = new FakeApi();
    const c = api.client();
    const r = await c.provisionSeatCustomer(spec);
    await c.provisionSeatCustomer({ ...spec, threatPhrases: ["placeholder phrase three"] });
    expect(api.rules.get(r.rules.customerThreat!).triggers[1].config.keywords).toEqual(["placeholder phrase three"]);
  });
});

describe("user workflows", () => {
  it("getSeatCustomer rebuilds the customer by name", async () => {
    const { c, customer } = await seeded();
    const got = await c.getSeatCustomer(customer.companyId);
    const { created, existing, ssoTxtRecord, ...base } = customer as any;
    expect(got).toEqual({ ...base, companyName: spec.companyName });
  });

  it("addManager: products, both groups, alert email on every rule, all lines", async () => {
    const { api, c, customer, conn } = await seeded();
    api.faConfig.set(customer.locationId, { webhook_url: null, connector_mappings: [{ connector_id: conn, monitored_numbers: ["2101", "2102"] }] });
    const r = await c.addManager(customer, { email: "m@example.com", firstName: "M", lastName: "G", sendInvitation: false });
    const u = api.users.get(r.userId);
    expect([...u.products].sort()).toEqual(["after-call-copilot", "first-alert-copilot", "insights-hub"]);
    expect(api.groupNamesOf(r.userId, customer.locationId).sort()).toEqual(["Insights Hub Access", "Manager Alerts"]);
    const prefs = api.calls.find((x) => x.path.endsWith("/first-alert/email-preferences"))!.body;
    expect(prefs.masterEnabled).toBe(true);
    expect(prefs.alerts.map((a: any) => a.alertId).sort()).toEqual([customer.rules.upsetCustomer, customer.rules.customerThreat].sort());
    expect(api.mappings.get(r.userId)).toEqual([{ connector_id: conn, monitored_numbers: ["2101", "2102"] }]);
    const create = api.calls.find((x) => x.method === "POST" && x.path.endsWith("/users"))!;
    expect(create.body).toMatchObject({ role: "frontline_user", location_ids: [customer.locationId], send_invitation: false });
  });

  it("addFrontlineUser: After Call only, email off, own line, then managers, First Alert, Insights Hub", async () => {
    const { api, c, customer, conn } = await seeded();
    const m = await c.addManager(customer, { email: "m@example.com", firstName: "M", lastName: "G" });
    const r = await c.addFrontlineUser(customer, { email: "a@example.com", firstName: "A", lastName: "K" }, "2101");
    expect([...api.users.get(r.userId).products]).toEqual(["after-call-copilot"]);
    expect(api.calls.filter((x) => x.path === `/locations/${customer.locationId}/users/${r.userId}/first-alert/email-preferences`)[0]!.body).toEqual({ masterEnabled: false, alerts: [] });
    expect(api.mappings.get(r.userId)).toEqual([{ connector_id: conn, monitored_numbers: ["2101"] }]);
    expect(api.mappings.get(m.userId)).toEqual([{ connector_id: conn, monitored_numbers: ["2101"] }]);
    expect(api.faConfig.get(customer.locationId).connector_mappings).toEqual([{ connector_id: conn, monitored_numbers: ["2101"] }]);
    expect(api.ihSetup.get(customer.locationId).connector_mappings).toEqual([{ connector_id: conn, monitored_numbers: ["2101"] }]);
    expect(r.managersUpdated).toEqual([m.userId]);
    expect((await c.listFrontlineUsers(customer)).map((u) => u.id)).toEqual([r.userId]);
    expect((await c.listManagers(customer)).map((u) => u.id)).toEqual([m.userId]);
  });

  it("addFrontlineUser stops at map_extension on a 422 (connector not active) and keeps the user", async () => {
    const { api, c, customer } = await seeded("error");
    api.mappingStatus = { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "connector not found or inactive" } } };
    const err = await c.addFrontlineUser(customer, { email: "a@example.com", firstName: "A", lastName: "K" }, "2101").catch((e) => e);
    expect(err).toBeInstanceOf(ExtensionMappingError);
    expect(err.cause).toBeInstanceOf(ValidationError);
    expect(err.userId).toBeTruthy();
    // stopped before First Alert / Insights Hub
    expect(api.faConfig.get(customer.locationId)).toBeUndefined();
    // a re-run finds the same user and carries on
    api.mappingStatus = null;
    const again = await c.addFrontlineUser(customer, { email: "a@example.com", firstName: "A", lastName: "K" }, "2101");
    expect(again.userId).toBe(err.userId);
    expect(again.created).toBe(false);
  });

  it("refuses addFrontlineUser before creating anything when there is no connector", async () => {
    const api = new FakeApi();
    const c = api.client();
    const res = await c.provisionSeatCustomer(spec);
    await expect(c.addFrontlineUser(res, { email: "x@example.com", firstName: "X", lastName: "Y" }, "2101")).rejects.toBeInstanceOf(FilterError);
    expect(api.users.size).toBe(0);
  });

  it("changeUserExtension re-syncs user, managers, First Alert and Insights Hub", async () => {
    const { api, c, customer, conn } = await seeded();
    const m = await c.addManager(customer, { email: "m@example.com", firstName: "M", lastName: "G" });
    const a = await c.addFrontlineUser(customer, { email: "a@example.com", firstName: "A", lastName: "K" }, "2101");
    await c.changeUserExtension(customer, a.userId, "2101", "2106");
    for (const uid of [a.userId, m.userId]) expect(api.mappings.get(uid)).toEqual([{ connector_id: conn, monitored_numbers: ["2106"] }]);
    expect(api.faConfig.get(customer.locationId).connector_mappings[0].monitored_numbers).toEqual(["2106"]);
    expect(api.ihSetup.get(customer.locationId).connector_mappings[0].monitored_numbers).toEqual(["2106"]);
  });

  it("removeUser clears groups and numbers, deactivates, releases the extension", async () => {
    const { api, c, customer, conn } = await seeded();
    const m = await c.addManager(customer, { email: "m@example.com", firstName: "M", lastName: "G" });
    const a = await c.addFrontlineUser(customer, { email: "a@example.com", firstName: "A", lastName: "K" }, "2101");
    const b = await c.addFrontlineUser(customer, { email: "b@example.com", firstName: "B", lastName: "K" }, "2102");
    const mark = api.calls.length;
    const r = await c.removeUser(customer, a.userId);
    expect(r.extensionsReleased).toEqual(["2101"]);
    const writes = api.calls.slice(mark).filter((x) => x.method !== "GET").map((x) => `${x.method} ${x.path.replace(/[0-9a-f-]{36}/g, ":id")}`);
    expect(writes).toEqual([
      "PUT /locations/:id/users/:id/group-membership",
      "PUT /companies/:id/users/:id/connector-mappings",
      "PUT /companies/:id/users/:id/connector-mappings",
      "PUT /locations/:id/first-alert/config",
      "PATCH /locations/:id/insights-hub/setup",
      "POST /companies/:id/users/:id/deactivate",
    ]);
    expect(api.users.get(a.userId).status).toBe("deactivated");
    expect(api.mappings.get(a.userId)).toEqual([]);
    expect(api.mappings.get(m.userId)).toEqual([{ connector_id: conn, monitored_numbers: ["2102"] }]);
    expect(api.faConfig.get(customer.locationId).connector_mappings[0].monitored_numbers).toEqual(["2102"]);
    // removing a manager keeps everyone's lines
    const rm = await c.removeUser(customer, m.userId);
    expect(rm.extensionsReleased).toEqual([]);
    expect(api.mappings.get(b.userId)).toEqual([{ connector_id: conn, monitored_numbers: ["2102"] }]);
    expect(api.groupNamesOf(m.userId, customer.locationId)).toEqual([]);
    // keepExtensions
    const kb = await c.removeUser(customer, b.userId, { keepExtensions: true });
    expect(kb.extensionsReleased).toEqual([]);
    expect(api.faConfig.get(customer.locationId).connector_mappings[0].monitored_numbers).toEqual(["2102"]);
  });

  it("syncNumbers: dry run returns the diff; apply sets every manager to exactly the lines", async () => {
    const { api, c, customer, conn } = await seeded();
    const m = await c.addManager(customer, { email: "m@example.com", firstName: "M", lastName: "G" });
    const a = await c.addFrontlineUser(customer, { email: "a@example.com", firstName: "A", lastName: "K" }, "2101");
    // drift: a frontline mapping changed behind our back, plus a stale line in First Alert, plus a
    // number on the manager that is not a line (the Seat never captures a manager's own phone)
    api.mappings.set(a.userId, [{ connector_id: conn, monitored_numbers: ["2105"] }]);
    api.mappings.set(m.userId, [{ connector_id: conn, monitored_numbers: ["2101", "2199"] }]);
    api.faConfig.set(customer.locationId, { webhook_url: "https://hooks.example.com/a", connector_mappings: [{ connector_id: conn, monitored_numbers: ["2101", "2150"] }] });
    const dry = await c.syncNumbers(customer, { dryRun: true });
    expect(dry.lines).toEqual(["2105"]);
    expect(dry.firstAlert).toEqual({ add: ["2105"], remove: ["2101", "2150"] });
    expect(dry.managers).toEqual([{ userId: m.userId, add: ["2105"], remove: ["2101", "2199"] }]);
    const writesBefore = api.calls.filter((x) => x.method !== "GET").length;
    expect(api.calls.filter((x) => x.method !== "GET").length).toBe(writesBefore);
    await c.syncNumbers(customer);
    expect(api.mappings.get(m.userId)![0].monitored_numbers.sort()).toEqual(["2105"]);
    expect(api.faConfig.get(customer.locationId)).toEqual({ webhook_url: "https://hooks.example.com/a", connector_mappings: [{ connector_id: conn, monitored_numbers: ["2105"] }] });
    expect(api.ihSetup.get(customer.locationId).connector_mappings).toEqual([{ connector_id: conn, monitored_numbers: ["2105"] }]);
    const again = await c.syncNumbers(customer, { dryRun: true });
    expect(again.managers).toEqual([]);
  });

  it("accepts a company id instead of a customer object", async () => {
    const { c, customer } = await seeded();
    expect(await c.listManagers(customer.companyId)).toEqual([]);
  });
});

describe("invitation and alert order", () => {
  const u = (n: number, invite = false): NewUser => ({ email: `user${n}@example.com`, firstName: "U", lastName: String(n), sendInvitation: invite });
  const writesSince = (api: FakeApi, mark: number) =>
    api.calls.slice(mark).filter((x) => x.method !== "GET" && !x.path.startsWith("/auth")).map((x) => `${x.method} ${x.path}`);
  const allOn = (api: FakeApi) => [...api.rules.values()].every((r) => r.enabled === true);
  const noneOn = (api: FakeApi) => [...api.rules.values()].every((r) => r.enabled !== true);

  it("creates users without an invitation", async () => {
    const { api, c, customer } = await seeded();
    await c.addFrontlineUser(customer, u(1, true), "2101");
    await c.addManager(customer, u(2, true));
    const creates = api.calls.filter((x) => x.method === "POST" && x.path.endsWith("/users"));
    expect(creates.length).toBe(2);
    expect(creates.every((x) => x.body.send_invitation === false)).toBe(true);
  });

  it("emails an end user's invitation as the last write", async () => {
    const { api, c, customer } = await seeded();
    const m = await c.addManager(customer, u(2));
    const mark = api.calls.length;
    const fl = await c.addFrontlineUser(customer, u(1, true), "2101");
    const w = writesSince(api, mark);
    expect(w[w.length - 1]).toBe(`POST /companies/${customer.companyId}/users/${fl.userId}/resend-invitation`);
    expect(w.indexOf(`PUT /companies/${customer.companyId}/users/${fl.userId}/connector-mappings`)).toBeLessThan(w.length - 1);
    expect(w.slice(0, -1)).toContain(`PUT /companies/${customer.companyId}/users/${m.userId}/connector-mappings`);
    expect(fl.invited).toBe(true);
    expect(api.invitations).toEqual([fl.userId]);
  });

  it("addManager switches the alerts on, then invites; a second manager finds them on", async () => {
    const { api, c, customer } = await seeded();
    await c.addFrontlineUser(customer, u(1), "2101");
    const mark = api.calls.length;
    const m = await c.addManager(customer, u(2, true));
    const w = writesSince(api, mark);
    const patches = w.map((x, i) => (x.startsWith("PATCH") && x.includes("/first-alert/rules/") ? i : -1)).filter((i) => i >= 0);
    const mapping = w.indexOf(`PUT /companies/${customer.companyId}/users/${m.userId}/connector-mappings`);
    expect(patches.length).toBe(2);
    expect(mapping).toBeGreaterThanOrEqual(0);
    expect(mapping).toBeLessThan(patches[0]!);
    expect(w[w.length - 1]).toBe(`POST /companies/${customer.companyId}/users/${m.userId}/resend-invitation`);
    expect(allOn(api)).toBe(true);
    expect([...m.alertsActivated].sort()).toEqual([customer.rules.upsetCustomer, customer.rules.customerThreat].sort());
    expect(m.invited).toBe(true);
    const second = await c.addManager(customer, u(3));
    expect(second.alertsActivated).toEqual([]);
    expect(second.invited).toBe(false);
  });

  it("activateAlerts: false leaves the rules off; activateSeatAlerts switches them on", async () => {
    const { api, c, customer } = await seeded();
    const m = await c.addManager(customer, u(2), { activateAlerts: false });
    expect(m.alertsActivated).toEqual([]);
    expect(noneOn(api)).toBe(true);
    expect((await c.activateSeatAlerts(customer)).length).toBe(2);
    expect(allOn(api)).toBe(true);
    expect(await c.workflows.activateSeatAlerts(customer)).toEqual([]);
  });

  it("a manager's mapping is exactly the end-user lines; no extra extension is accepted", async () => {
    // Base Intelligence Seat: a manager's own phone line is never captured
    const { api, c, customer, conn } = await seeded();
    await c.addFrontlineUser(customer, u(1), "2101");
    await c.addFrontlineUser(customer, u(4), "2104");
    await expect(c.addManager(customer, u(2), "2190" as any)).rejects.toBeInstanceOf(FilterError);
    await expect(c.addManager(customer, u(2), { extension: "2190" } as any)).rejects.toBeInstanceOf(FilterError);
    const m = await c.addManager(customer, u(2));
    expect(m.extensions.sort()).toEqual(["2101", "2104"]);
    expect(api.mappings.get(m.userId)).toEqual([{ connector_id: conn, monitored_numbers: m.extensions }]);
    expect(api.faConfig.get(customer.locationId).connector_mappings[0].monitored_numbers.sort()).toEqual(["2101", "2104"]);
    expect(api.ihSetup.get(customer.locationId).connector_mappings[0].monitored_numbers.sort()).toEqual(["2101", "2104"]);
  });

  it("sendInvitation: false never invites", async () => {
    const { api, c, customer } = await seeded();
    await c.addFrontlineUser(customer, u(1), "2101");
    await c.addManager(customer, u(2));
    expect(api.invitations).toEqual([]);
    expect(api.count("POST", "/companies/{c}/users/{u}/resend-invitation")).toBe(0);
  });

  it("sends no invitation when a mapping fails, and a failed manager leaves the alerts off", async () => {
    const { api, c, customer } = await seeded("error");
    api.mappingStatus = { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "connector not found or inactive" } } };
    await expect(c.addFrontlineUser(customer, u(1, true), "2101")).rejects.toBeInstanceOf(ExtensionMappingError);
    api.faConfig.set(customer.locationId, { webhook_url: null, connector_mappings: [{ connector_id: customer.connectorId, monitored_numbers: ["2101"] }] });
    await expect(c.addManager(customer, u(2, true))).rejects.toBeInstanceOf(ExtensionMappingError);
    expect(api.invitations).toEqual([]);
    expect(noneOn(api)).toBe(true);
  });

  it("a re-run after a refused mapping finishes the setup and invites", async () => {
    const { api, c, customer } = await seeded("error");
    api.mappingStatus = { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "connector not found or inactive" } } };
    const err = await c.addFrontlineUser(customer, u(1, true), "2101").catch((e) => e);
    expect(err).toBeInstanceOf(ExtensionMappingError);
    api.mappingStatus = null; // the connector is fixed
    const again = await c.addFrontlineUser(customer, u(1, true), "2101");
    expect(again.userId).toBe(err.userId);
    expect(again.created).toBe(false);
    expect(again.invited).toBe(true);
    expect(api.invitations).toEqual([again.userId]);
  });

  it("a provisioning re-run keeps the rules on", async () => {
    const { api, c, customer } = await seeded();
    await c.addManager(customer, u(2));
    await c.provisionSeatCustomer(spec);
    expect(allOn(api)).toBe(true);
  });
});
