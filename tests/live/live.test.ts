// Live suite. Opt in with IC_LIVE=1 (`npm run test:live`). Point it at a test reseller, never at a customer.
// Everything comes from the environment; nothing about the test tenant is written here.
//   IC_RESELLER_USER / IC_RESELLER_PASSWORD     reseller admin integration user
//   IC_FRONTLINE_USER / IC_FRONTLINE_PASSWORD   frontline integration user, READ ONLY (shapes and counts only)
//   SBX_NS_API_URL / SBX_NS_DOMAIN / SBX_NA_API_KEY   phone-system connector settings for the test company
//   IC_LIVE_COMPANY_NAME        the test company this suite creates (or finds) and deactivates at the end
//   IC_LIVE_COMPANY_CODE        its company code (optional)
//   IC_LIVE_LOCATION_NAME       its location (default "SDK Test - Main")
//   IC_LIVE_EMAIL_PREFIX / IC_LIVE_EMAIL_DOMAIN   test users are <prefix>-<n>@<domain>
//                               (n = 0 is the company's primary contact, who is always emailed an invitation)
//   IC_LIVE_SSO_DOMAIN          a domain to claim and release (optional; the SSO step is skipped without it)
//   IC_LIVE_THREAT_PHRASES_FILE Customer Threat phrases, one per line
//   IC_LIVE_EXPECT_CONNECTOR    the connector status the test key reaches: "active" or "error" (default "error")
//   IC_LIVE_FREE_EXTENSION      an extension no other location monitors
//   IC_LIVE_CONFLICT_EXTENSION  an extension another location monitors (optional; the 409 check is skipped)
//   IC_LIVE_VERTICAL            vertical key for the location (default "csps-msps")
//   IC_LIVE_RESELLER_ID         expected reseller id of the admin login (optional)
//   IC_LIVE_SEAT_COMPANY_ID / IC_LIVE_SEAT_LOCATION_NAME   an existing Seat customer to read (optional)
//   IC_LIVE_SEAT_FRONTLINE_ID / IC_LIVE_SEAT_MANAGER_ID    one end user and one manager there (optional)
// Safety: one sign-in per client per run, never logout, users created with send_invitation:false,
// everything created is deactivated at the end, nothing secret or call content is printed.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  Client,
  ExtensionMappingError,
  FilterError,
  ValidationError,
  type SeatCustomer,
} from "../../src/index.js";

const LIVE = process.env.IC_LIVE === "1";
const env = (k: string) => process.env[k] ?? "";
const COMPANY_NAME = env("IC_LIVE_COMPANY_NAME");
const LOCATION_NAME = env("IC_LIVE_LOCATION_NAME") || "SDK Test - Main";
const SEAT_COMPANY = env("IC_LIVE_SEAT_COMPANY_ID");
const SEAT_LOCATION_NAME = env("IC_LIVE_SEAT_LOCATION_NAME") || undefined;
const EXPECT_CONNECTOR = env("IC_LIVE_EXPECT_CONNECTOR") || "error";
const EXT = env("IC_LIVE_FREE_EXTENSION");
const CONFLICT_EXT = env("IC_LIVE_CONFLICT_EXTENSION");
const SSO_DOMAIN = env("IC_LIVE_SSO_DOMAIN");
const RUN = Math.floor(Date.now() / 1000);
const ME_KEYS = ["id", "email", "first_name", "last_name", "display_name", "user_type", "role", "status", "scopes", "reseller_id", "company_id", "location_ids", "enabled_products", "mfa_available"];
/** Test addresses come from the environment: <IC_LIVE_EMAIL_PREFIX>-<n>@<IC_LIVE_EMAIL_DOMAIN>. */
const testEmail = (n: string | number) => `${env("IC_LIVE_EMAIL_PREFIX")}-${n}@${env("IC_LIVE_EMAIL_DOMAIN")}`;
const threatPhrases = () =>
  readFileSync(env("IC_LIVE_THREAT_PHRASES_FILE"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

/** Fail with a message that never contains response content. */
function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`check failed: ${msg}`);
}
const subset = (o: object | undefined | null, allowed: string[]) => Object.keys(o ?? {}).every((k) => allowed.includes(k));

describe.runIf(LIVE)("live: admin (test reseller)", () => {
  let admin: Client;
  let customer: SeatCustomer | null = null;
  let connectorId: string | null = null;
  let resellerId = "";
  const createdUsers: string[] = [];

  beforeAll(() => {
    if (process.env.IC_USER && env("IC_RESELLER_USER") === process.env.IC_USER) throw new Error("refusing to run as IC_USER");
    for (const k of ["IC_LIVE_COMPANY_NAME", "IC_LIVE_EMAIL_PREFIX", "IC_LIVE_EMAIL_DOMAIN", "IC_LIVE_FREE_EXTENSION", "IC_LIVE_THREAT_PHRASES_FILE"]) {
      if (!env(k)) throw new Error(`set ${k}`);
    }
    admin = new Client({ email: env("IC_RESELLER_USER"), password: env("IC_RESELLER_PASSWORD"), userAgent: "ic-sdk-ts-live-tests" });
  });

  afterAll(async () => {
    if (!customer) return;
    const c = customer;
    const steps: [string, () => Promise<unknown>][] = [
      ...createdUsers.map((u) => [`remove user`, () => admin.removeUser(c, u)] as [string, () => Promise<unknown>]),
      ["clear FA webhook", () => admin.setFirstAlertWebhook(c.locationId, null)],
      ...(connectorId ? [["deactivate connector", () => admin.connectors.deactivateConnector(c.locationId, connectorId!, { timeout: 60 })] as [string, () => Promise<unknown>]] : []),
      ["deactivate location", () => admin.locations.deactivateLocation(c.companyId, c.locationId)],
      ["deactivate company", () => admin.companies.deactivateCompany(c.companyId)],
    ];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (e) {
        console.warn(`teardown: ${name} failed (${(e as Error).name})`);
      }
    }
  });

  it("whoami: reseller admin", async () => {
    const me = await admin.whoami();
    check(me.role === "reseller_admin", "role is reseller_admin");
    check(me.reseller_id, "reseller id");
    if (env("IC_LIVE_RESELLER_ID")) check(me.reseller_id === env("IC_LIVE_RESELLER_ID"), "expected reseller");
    resellerId = me.reseller_id!;
    check(subset(me, ME_KEYS), "only documented /me fields");
  });

  it("catalogue reads", async () => {
    const p = await admin.products.listProducts();
    check((p.data ?? []).some((x) => x.key === "insights-hub"), "products listed");
    const v = await admin.locations.listVerticals();
    check((v.data ?? []).some((x) => x.key === (env("IC_LIVE_VERTICAL") || "csps-msps")), "vertical");
    const t = await admin.connectors.listConnectorTypes();
    check((t.data ?? []).some((x) => x.key === "netsapiens"), "netsapiens type");
    const mfa = await admin.companies.getCompaniesMfaSummary(resellerId);
    check(typeof mfa.data?.companies_mfa_default === "boolean", "mfa summary");
  });

  it.runIf(Boolean(SEAT_COMPANY))("getSeatCustomer rebuilds an existing Seat customer by name", async () => {
    const s = await admin.getSeatCustomer(SEAT_COMPANY, { locationName: SEAT_LOCATION_NAME });
    check(s.locationId, "location");
    check(s.groups.managerAlerts && s.groups.insightsHubAccess, "both groups");
    check(s.rules.upsetCustomer && s.rules.customerThreat, "both rules");
    const again = await admin.getSeatCustomer(SEAT_COMPANY, { locationName: SEAT_LOCATION_NAME });
    check(JSON.stringify(again) === JSON.stringify(s), "stable");
  });

  it.runIf(Boolean(SEAT_COMPANY))("classifies the Seat customer's users and dry-runs sync", async () => {
    const s = await admin.getSeatCustomer(SEAT_COMPANY, { locationName: SEAT_LOCATION_NAME });
    const frontline = await admin.listFrontlineUsers(s);
    const managers = await admin.listManagers(s);
    const fid = env("IC_LIVE_SEAT_FRONTLINE_ID");
    const mid = env("IC_LIVE_SEAT_MANAGER_ID");
    if (fid) check(frontline.some((u) => u.id === fid), "end user is frontline");
    if (mid) check(managers.some((u) => u.id === mid) && !frontline.some((u) => u.id === mid), "manager is manager");
    check(!frontline.some((u) => managers.some((m) => m.id === u.id)), "no user in both lists");
    const dry = await admin.syncNumbers(s, { dryRun: true });
    check(dry.dryRun === true && Array.isArray(dry.lines), "dry-run result");
  });

  it.runIf(Boolean(SEAT_COMPANY))("projection drops undocumented connector fields", async () => {
    const s = await admin.getSeatCustomer(SEAT_COMPANY, { locationName: SEAT_LOCATION_NAME });
    if (!s.connectorId) return;
    const r = await admin.connectors.getConnector(s.locationId, s.connectorId);
    check(r.data?.id, "connector read");
    check(subset(r.data?.config, ["api_url", "domain"]), "config has only api_url and domain");
    const list = await admin.connectors.listCompanyConnectors(SEAT_COMPANY);
    check(list.items.every((x) => !("config" in x)), "list rows carry no config");
  });

  it("refuses bad filters before sending", async () => {
    await expect(admin.companies.listCompanies(resellerId, { offset: 1 } as never)).rejects.toBeInstanceOf(FilterError);
    await expect(admin.users.listCompanyUsers(resellerId, { product: "insights-hub" } as never)).rejects.toBeInstanceOf(FilterError);
  });

  it("provisionSeatCustomer creates (or finds) the test company", async () => {
    const spec = {
      resellerId,
      companyName: COMPANY_NAME,
      companyCode: env("IC_LIVE_COMPANY_CODE") || undefined,
      primaryAdmin: { name: "SDK Test Admin", email: testEmail(0), phone: "+15555550100" },
      mfaOff: true,
      location: {
        name: LOCATION_NAME, street: "1 Example Way", city: "Springfield", state: "IL", country: "United States", zipcode: "62701",
        verticalKey: env("IC_LIVE_VERTICAL") || undefined,
      },
      threatPhrases: threatPhrases(),
      reactivate: true, // the previous run deactivated it
      connector: { apiUrl: env("SBX_NS_API_URL"), domain: env("SBX_NS_DOMAIN"), apiKey: env("SBX_NA_API_KEY"), timeout: 90 },
    };
    const r = await admin.provisionSeatCustomer(spec);
    // a connector that cannot connect is recorded on the result, not raised
    check(r.connectorId, "connector id recorded");
    check(r.connectorStatus === EXPECT_CONNECTOR, "connector status as expected");
    if (EXPECT_CONNECTOR === "error") check(r.connectorStateReason === "invalid_permissions", "state_reason invalid_permissions");
    connectorId = r.connectorId;
    check(r.companyId && r.locationId && r.groups.managerAlerts && r.groups.insightsHubAccess, "ids returned");
    check(r.rules.upsetCustomer && r.rules.customerThreat, "rules");
    const company = (await admin.companies.getCompany(r.companyId)).data?.attributes;
    check(company?.mfa_enforced === false, "MFA off");
    for (const id of [r.rules.upsetCustomer, r.rules.customerThreat]) {
      const rule = (await admin.firstAlert.getAlertRule(r.locationId, id!)).data?.attributes;
      check(rule?.groups?.some((g) => g.id === r.groups.managerAlerts), "rule routed to Manager Alerts");
    }
    const again = await admin.provisionSeatCustomer(spec);
    check(again.created.length === 0, "re-run created nothing");
    check(again.rules.customerThreat === r.rules.customerThreat, "same rule ids");
    customer = await admin.getSeatCustomer(r.companyId, { locationName: LOCATION_NAME });
  });

  it("connector reads carry only the documented config", async () => {
    const r = await admin.connectors.getConnector(customer!.locationId, connectorId!);
    check(r.data?.status === EXPECT_CONNECTOR, "status unchanged");
    check(subset(r.data?.config, ["api_url", "domain"]), "only api_url and domain");
  });

  it("location-level numbers can be set and cleared (First Alert keeps its webhook URL)", async () => {
    const c = customer!;
    await admin.setFirstAlertWebhook(c.locationId, `https://example.invalid/hooks/sdk-${RUN}`);
    await admin.firstAlert.addMonitoredNumbers(c.locationId, connectorId!, [EXT]);
    const cfg = (await admin.firstAlert.getFirstAlertConfig(c.locationId)).data;
    check(cfg?.webhook_url?.endsWith(`sdk-${RUN}`), "webhook URL kept");
    check(cfg?.connector_mappings?.some((m) => m.monitored_numbers?.includes(EXT)), "FA number added");
    await admin.insightsHub.addNumbers(c.locationId, connectorId!, [EXT]);
    await admin.insightsHub.removeNumbers(c.locationId, connectorId!, [EXT]);
    await admin.firstAlert.removeMonitoredNumbers(c.locationId, connectorId!, [EXT]);
    const after = (await admin.firstAlert.getFirstAlertConfig(c.locationId)).data;
    check(!after?.connector_mappings?.some((m) => m.monitored_numbers?.includes(EXT)), "FA number removed");
    const t = await admin.testFirstAlertWebhook(c.locationId).catch((e) => e);
    if (t instanceof ValidationError) check(!/lookup|dial|127\.|:53/.test(t.message), "no server text");
    else check(subset(t, ["success", "http_status"]) && t.success === false, "test reports success + status only");
  });

  it("After Call webhook: set paused, read, test (success + status only)", async () => {
    const c = customer!;
    const url = `https://example.invalid/hooks/sdk-ac-${RUN}`;
    const w = await admin.setAfterCallWebhook(c.locationId, url, false);
    check(w.webhook_url === url && w.enabled === false, "saved paused");
    const got = await admin.getAfterCallWebhook(c.locationId);
    check(got?.webhook_url === url, "read back");
    const t = await admin.testAfterCallWebhook(c.locationId).catch((e) => e);
    if (t instanceof Error) check(!/lookup|dial|127\.|:53/.test(t.message), "no server text");
    else check(subset(t, ["success", "http_status"]) && t.success === false, "success + status only");
  });

  it.runIf(EXPECT_CONNECTOR === "error")("addManager (switches the alerts on) and addFrontlineUser (mapping 422 on a connector in error)", async () => {
    const c = customer!;
    const m = await admin.addManager(c, { email: testEmail(`${RUN}1`), firstName: "SDK", lastName: "Manager", sendInvitation: false });
    createdUsers.push(m.userId);
    check(m.invited === false, "not invited");
    for (const id of [c.rules.upsetCustomer, c.rules.customerThreat]) {
      check((await admin.firstAlert.getAlertRule(c.locationId, id!)).data?.attributes?.enabled === true, "rule switched on");
    }
    const err = await admin
      .addFrontlineUser(c, { email: testEmail(`${RUN}2`), firstName: "SDK", lastName: "Agent", sendInvitation: false }, EXT)
      .catch((e) => e);
    check(err instanceof ExtensionMappingError, "ExtensionMappingError");
    const agentId = (err as ExtensionMappingError).userId;
    check(agentId, "user id on the error");
    createdUsers.push(agentId!);
    check((err as Error).cause instanceof ValidationError && ((err as Error).cause as ValidationError).status === 422, "422");
    const fa = (await admin.firstAlert.getFirstAlertConfig(c.locationId)).data;
    check(!fa?.connector_mappings?.some((m) => m.monitored_numbers?.includes(EXT)), "stopped before First Alert");
    const managers = await admin.listManagers(c);
    const frontline = await admin.listFrontlineUsers(c);
    check(managers.some((u) => u.id === m.userId), "manager listed");
    check(frontline.some((u) => u.id === createdUsers[1]), "agent listed");
    check(managers.find((u) => u.id === m.userId)?.groups.length === 2, "manager in both groups");
  });

  it.runIf(EXPECT_CONNECTOR === "active")("maps extensions end to end and switches the alerts on", async () => {
    const c = customer!;
    const m = await admin.addManager(c, { email: testEmail(`${RUN}1`), firstName: "SDK", lastName: "Manager", sendInvitation: false });
    createdUsers.push(m.userId);
    const a = await admin.addFrontlineUser(c, { email: testEmail(`${RUN}2`), firstName: "SDK", lastName: "Agent", sendInvitation: false }, EXT);
    createdUsers.push(a.userId);
    check(a.invited === false, "not invited");
    check((await admin.users.userNumbers(c.companyId, a.userId, connectorId!)).includes(EXT), "own line mapped");
    check((await admin.users.userNumbers(c.companyId, m.userId, connectorId!)).includes(EXT), "line on the manager");
    for (const id of [c.rules.upsetCustomer, c.rules.customerThreat]) {
      check((await admin.firstAlert.getAlertRule(c.locationId, id!)).data?.attributes?.enabled === true, "rule switched on");
    }
  });

  it.runIf(Boolean(CONFLICT_EXT))("an extension conflict 409 carries the fixed message", async () => {
    const c = customer!;
    const uid = createdUsers[0]!;
    const err = await admin.afterCallSettings
      .updateUserAfterCallSettings(c.locationId, uid, { connector_mappings: [{ connector_id: connectorId!, monitored_numbers: [CONFLICT_EXT] }] })
      .catch((e) => e);
    if (err instanceof ConflictError) {
      check(err.message === "Extension is already monitored at another location.", "fixed message");
      check(JSON.stringify(err.extensions) === JSON.stringify([CONFLICT_EXT]), "extension listed");
    } else {
      check(err instanceof ValidationError, "409, or 422 for a connector that is not active");
    }
  });

  it.runIf(Boolean(SSO_DOMAIN))("SSO: claim returns the TXT record; a failed check is a 200; remove the claim", async () => {
    const c = customer!;
    const domain = SSO_DOMAIN;
    const d = (await admin.sso.claimCompanyDomain(c.companyId, { domain })).data;
    check(d?.verification?.name === `_ic-verify.${domain}`, "TXT name");
    const v = await admin.sso.verifyDomain(c.companyId, d!.id!);
    check(v.data?.status === "pending", "pending after failed check");
    await admin.sso.removeCompanyDomain(c.companyId, d!.id!);
  });
});

describe.runIf(LIVE)("live: frontline (read only, shapes and counts)", () => {
  let fl: Client;
  beforeAll(() => {
    fl = new Client({ email: env("IC_FRONTLINE_USER"), password: env("IC_FRONTLINE_PASSWORD"), userAgent: "ic-sdk-ts-live-tests" });
  });

  const CALL_KEYS = ["id", "location_id", "call_date", "caller_timezone", "caller_name", "caller_number", "callee_name", "callee_number", "call_type", "status", "sentiment", "sentiment_score", "sentiment_label", "summary", "top_highlight", "highlights", "duration", "leg_count", "task_count", "completed_task_count"];

  it("requireFrontline", async () => {
    const me = await fl.requireFrontline();
    check(me.role === "frontline_user", "frontline");
  });

  it("calls: page, iterator, detail, transcript, recording link, phone search", async () => {
    const p = await fl.searchCalls({ limit: 5 });
    check(p.items.length <= 5 && typeof p.summary.total_calls === "number", "page + summary");
    check(p.items.every((x) => subset(x, CALL_KEYS)), "list rows: documented keys only");
    let n = 0;
    const ids = new Set<string>();
    for await (const x of fl.iterCalls({ maxItems: 150 })) {
      n++;
      ids.add(x.id!);
    }
    check(n === ids.size && n <= 150, "iterator: unique rows, capped");
    if (!p.items.length) return;
    const first = p.items[0]!;
    const detail = await fl.getCall(first.id!);
    check(detail.id === first.id, "detail id");
    check(subset((detail as { vcon?: object }).vcon, ["recording_url", "recording_url_expires_at", "recording_mime_type"]), "vcon: only the recording fields");
    const rec = await fl.getRecordingUrl(first.id!);
    check(subset(rec, ["url", "expiresAt"]), "recording: link and expiry only");
    check(rec.url === null || rec.url.startsWith("https://"), "https link or null");
    const tr = await fl.getTranscript(first.id!);
    check(tr.every((l) => /^Speaker \d+$/.test(l.speaker ?? "")), "speaker labels");
    const digits = (first.caller_number ?? "").replace(/\D/g, "");
    if (digits.length >= 4) {
      const s = await fl.searchCalls({ phone: digits.slice(-4), limit: 1 });
      check((s.summary.total_calls ?? 0) >= 1, "partial number search hits");
    }
  });

  it("alerts: page, by rule name, by id with call", async () => {
    const p = await fl.searchAlerts({ limit: 5, dateFrom: new Date(Date.now() - 30 * 86400_000) });
    check(typeof p.total === "number", "total");
    if (!p.items.length) return;
    const a = p.items[0]!;
    const byId = await fl.getAlert(a.id!, { withCall: true });
    check(byId?.id === a.id, "alert by id");
    check(!byId?.call_id || byId.call?.id === byId.call_id, "call attached");
    const rule = a.keywords?.[0];
    if (rule) {
      const r = await fl.searchAlerts({ alertName: rule, dateFrom: new Date(Date.now() - 30 * 86400_000), limit: 1 });
      check((r.total ?? 0) >= 1, "rule-name filter");
    }
  });

  it("tasks, dashboards, topics, locations, webhook read", async () => {
    const t = await fl.listTasks({ limit: 5, status: "open" });
    check(typeof t.summary.total === "number", "task summary");
    const d = await fl.getAlertsDashboard();
    check(typeof d.kpis?.new_alerts === "number", "alert kpis");
    const end = new Date();
    const ins = await fl.getInsightsDashboard({ start: new Date(end.getTime() - 7 * 86400_000), end });
    check(typeof ins.stats?.total_calls === "number", "insights stats");
    const slug = ins.topic_call_volumes?.[0]?.slug;
    if (slug) {
      const tc = await fl.listTopicCalls(slug, { limit: 5 });
      check(tc.items.length <= 5 && typeof tc.total === "number", "topic calls");
    }
    const locs = await fl.account.listVisibleLocations({ limit: 5 });
    check(locs.items.length >= 1, "visible locations");
    const w = await fl.getAfterCallWebhook(locs.items[0]!.id!);
    check(w === null || typeof w.enabled === "boolean", "webhook read");
  });

  it("refuses an unsupported filter and a date-only window before sending", async () => {
    await expect(fl.searchCalls({ direction: "inbound" } as never)).rejects.toBeInstanceOf(FilterError);
    await expect(fl.searchAlerts({ dateFrom: "2026-11-01" })).rejects.toBeInstanceOf(FilterError);
  });
});

describe.skipIf(LIVE)("live suite", () => {
  it.skip("set IC_LIVE=1 to run against the API", () => {});
});
