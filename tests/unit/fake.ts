// An in-memory fake of the Intelligence Cloud API, enough for unit tests. No network.
import { Client, type IntelligenceClientOptions } from "../../src/index.js";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string>;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; text?: string };
type Handler = (req: Recorded, m: RegExpMatchArray) => Reply | Promise<Reply>;

let seq = 0;
export const id = (p = "0000") => {
  seq++;
  const n = seq.toString(16).padStart(12, "0");
  return `0193b6c2-${p.padStart(4, "0").slice(0, 4)}-7000-8000-${n}`;
};

export class FakeApi {
  calls: Recorded[] = [];
  private routes: { method: string; re: RegExp; h: Handler }[] = [];
  tokenN = 0;
  /** refresh tokens handed out and not yet spent */
  liveRefresh = new Set<string>();
  spentRefresh: string[] = [];
  role = "reseller_admin";
  resellerId = "0193b6c2-41d8-7e0a-9c55-2f7d1e3a9b10";
  loginStatus: Reply | null = null;

  // state
  companies = new Map<string, any>();
  locations = new Map<string, any>();
  groups = new Map<string, any>(); // id -> {location_id, group_name, members:[]}
  rules = new Map<string, any>();
  users = new Map<string, any>(); // id -> {company_id, email, role, status, location_ids, products:Set, groups:Set}
  mappings = new Map<string, any[]>(); // userId -> [{connector_id, monitored_numbers}]
  faConfig = new Map<string, any>(); // locationId -> {webhook_url, connector_mappings}
  ihSetup = new Map<string, any>(); // locationId -> {connector_mappings, group_access}
  ihConfig = new Map<string, boolean>();
  connectors = new Map<string, any>();
  connectorPlan: string[] = ["connecting", "active"]; // statuses returned by successive GETs after create
  mappingStatus: Reply | null = null; // override for user mapping PUT
  reactivatePlan: string[] | null = null; // statuses after a reactivate (default: connectorPlan)
  invitations: string[] = []; // user ids emailed an invitation, in order
  afterCallHooks = new Map<string, any>(); // locationId -> {webhook_url, enabled}

  constructor() {
    this.installDefaults();
  }

  on(method: string, path: string | RegExp, h: Handler) {
    const re = typeof path === "string" ? new RegExp(`^${path.replace(/\{[^}]+\}/g, "([^/]+)")}$`) : path;
    this.routes.unshift({ method, re, h });
    return this;
  }

  count(method: string, path: string | RegExp) {
    const re = typeof path === "string" ? new RegExp(`^${path.replace(/\{[^}]+\}/g, "([^/]+)")}$`) : path;
    return this.calls.filter((c) => c.method === method && re.test(c.path)).length;
  }

  seq(): string[] {
    return this.calls.filter((c) => !c.path.startsWith("/auth/")).map((c) => `${c.method} ${c.path}`);
  }

  client(opts: Partial<IntelligenceClientOptions> = {}) {
    return new Client({
      email: "integration@example.com",
      password: "pw",
      fetch: this.fetch,
      sleep: async () => {},
      random: () => 0.5,
      ...opts,
    });
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const req: Recorded = { method: init.method ?? "GET", path, query, body, headers };
    this.calls.push(req);
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.re);
      if (!m) continue;
      const out = await r.h(req, m);
      const text = out.text ?? (out.body === undefined ? "" : JSON.stringify(out.body));
      return new Response(out.status === 204 ? null : text, {
        status: out.status,
        headers: { "content-type": out.text !== undefined ? "text/html" : "application/json", ...(out.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `no fake route ${req.method} ${path}` } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  tokens() {
    this.tokenN++;
    const refresh = `refresh-${this.tokenN}`;
    this.liveRefresh.add(refresh);
    return { access_token: `access-${this.tokenN}`, refresh_token: refresh, token_type: "Bearer", expires_in: 899, user: { role: this.role } };
  }

  authed(req: Recorded): boolean {
    return req.headers.authorization === `Bearer access-${this.tokenN}`;
  }

  // ------------------------------------------------------------------ helpers for state
  addCompany(name: string, extra: any = {}) {
    const cid = id("c0");
    this.companies.set(cid, { id: cid, reseller_id: this.resellerId, company_name: name, enabled_products: ["after-call-copilot"], is_active: true, mfa_enforced: true, ...extra });
    return cid;
  }
  addLocation(companyId: string, name: string) {
    const lid = id("10");
    this.locations.set(lid, { id: lid, company_id: companyId, location_name: name, enabled_products: [], is_active: true });
    return lid;
  }
  addUser(companyId: string, locationId: string, email: string, products: string[], status = "invited") {
    const uid = id("40");
    this.users.set(uid, { id: uid, company_id: companyId, email, role: "frontline_user", status, location_ids: [locationId], products: new Set(products), first_name: "A", last_name: "B" });
    return uid;
  }
  addConnector(locationId: string, status = "active", name = "Main phone system") {
    const cid = id("c1");
    this.connectors.set(cid, { id: cid, location_id: locationId, name, type: "netsapiens", status, config: { api_url: "https://pbx.example.com/ns-api/v2", domain: "d.example", unexpected_ref: "redacted" } });
    return cid;
  }
  groupNamesOf(userId: string, locationId: string) {
    return [...this.groups.values()].filter((g) => g.location_id === locationId && g.members.includes(userId)).map((g) => g.group_name);
  }

  private installDefaults() {
    const ok = (body: unknown, status = 200): Reply => ({ status, body });
    const nf = (msg = "not found"): Reply => ({ status: 404, body: { error: { code: "NOT_FOUND", message: msg } } });
    const page = (rows: any[], q: Record<string, string>, wrap: string | null, top = false): Reply => {
      const limit = Number(q.limit ?? 20);
      const start = q.cursor ? Number(Buffer.from(q.cursor, "base64").toString()) : 0;
      const slice = rows.slice(start, start + limit);
      const more = start + limit < rows.length;
      const next = more ? Buffer.from(String(start + limit)).toString("base64") : null;
      const data = wrap ? slice.map((a) => ({ type: wrap, attributes: a })) : slice;
      return top
        ? ok({ data, has_more: more, next_cursor: next, total_count: rows.length })
        : ok({ data, pagination: { has_more: more, next_cursor: next, total_count: rows.length } });
    };
    const guard = (h: Handler): Handler => (req, m) => (this.authed(req) ? h(req, m) : { status: 401, body: { statusCode: 401, message: "Unauthorized" } });

    // auth
    this.on("POST", "/auth/login", () => (this.loginStatus ? this.loginStatus : ok(this.tokens())));
    this.on("POST", "/auth/refresh", (req) => {
      const t = req.body?.refresh_token;
      if (!this.liveRefresh.has(t)) return { status: 401, body: { error: { code: "renewal_replayed", message: "replayed" } } };
      this.liveRefresh.delete(t);
      this.spentRefresh.push(t);
      return ok(this.tokens());
    });
    this.on("POST", "/auth/logout", guard(() => ok({ message: "Logged out successfully" })));
    this.on("GET", "/me", guard(() => ok({ data: { id: id(), role: this.role, reseller_id: this.resellerId, unexpected_ref: "redacted", scopes: [] } })));

    // companies
    this.on("GET", "/resellers/{r}/companies", guard((req) => {
      const s = (req.query.search ?? "").toLowerCase();
      const rows = [...this.companies.values()].filter((c) => c.company_name.toLowerCase().startsWith(s));
      return page(rows, req.query, "company", true);
    }));
    this.on("POST", "/resellers/{r}/companies", guard((req) => {
      const cid = this.addCompany(req.body.company_name, { enabled_products: req.body.enabled_products ?? [], primary_admin_contact_email: req.body.primary_admin_contact_email });
      return ok({ data: { type: "company", attributes: this.companies.get(cid) }, invited_user: { id: id(), email: req.body.primary_admin_contact_email } }, 201);
    }));
    this.on("GET", "/companies/{c}", guard((_, m) => {
      const c = this.companies.get(m[1]!);
      return c ? ok({ data: { type: "company", attributes: c } }) : nf();
    }));
    this.on("POST", "/companies/{c}/deactivate", guard((_, m) => {
      const c = this.companies.get(m[1]!);
      if (!c.is_active) return { status: 409, body: { error: { code: "CONFLICT", message: "Company is already inactive" } } };
      c.is_active = false;
      return ok({ data: { type: "company", attributes: c } });
    }));
    this.on("PATCH", "/companies/{c}", guard((req, m) => {
      const c = this.companies.get(m[1]!);
      Object.assign(c, req.body);
      return ok({ data: { type: "company", attributes: c } });
    }));

    // locations
    this.on("GET", "/verticals", guard(() => ok({ data: [{ id: "0193b6c2-0001-7000-8000-00000000c5b5", key: "csps-msps", name: "CSPs" }] })));
    this.on("GET", "/companies/{c}/locations", guard((req, m) => {
      const s = (req.query.search ?? "").toLowerCase();
      let rows = [...this.locations.values()].filter((l) => l.company_id === m[1] && l.location_name.toLowerCase().includes(s));
      if (req.query.is_active) rows = rows.filter((l) => String(l.is_active) === req.query.is_active);
      return page(rows, req.query, "location");
    }));
    this.on("POST", "/companies/{c}/locations", guard((req, m) => {
      const lid = this.addLocation(m[1]!, req.body.location_name);
      Object.assign(this.locations.get(lid), { enabled_products: req.body.enabled_products ?? [] });
      return ok({ data: { type: "location", attributes: this.locations.get(lid) } }, 201);
    }));
    this.on("GET", "/companies/{c}/locations/{l}", guard((_, m) => ok({ data: { type: "location", attributes: this.locations.get(m[2]!) } })));
    this.on("PATCH", "/companies/{c}/locations/{l}", guard((req, m) => {
      Object.assign(this.locations.get(m[2]!), req.body);
      return ok({ data: { type: "location", attributes: this.locations.get(m[2]!) } });
    }));

    // groups
    this.on("GET", "/locations/{l}/user-groups", guard((req, m) => {
      const s = (req.query.search ?? "").toLowerCase();
      const rows = [...this.groups.values()].filter((g) => g.location_id === m[1] && g.group_name.toLowerCase().includes(s)).map(({ members, ...g }) => g);
      return page(rows, req.query, "user_group");
    }));
    this.on("POST", "/locations/{l}/user-groups", guard((req, m) => {
      const gid = id("8d");
      this.groups.set(gid, { id: gid, location_id: m[1], group_name: req.body.group_name, members: [] });
      return ok({ data: { type: "user_group", attributes: { id: gid, group_name: req.body.group_name } } }, 201);
    }));
    this.on("GET", "/locations/{l}/user-groups/{g}", guard((_, m) => {
      const g = this.groups.get(m[2]!);
      return ok({ data: { type: "user_group", attributes: { ...g, members: g.members.map((x: string) => ({ id: x })) } } });
    }));
    this.on("PATCH", "/locations/{l}/user-groups/{g}", guard((req, m) => {
      const g = this.groups.get(m[2]!);
      if (req.body.member_ids) g.members = req.body.member_ids;
      return ok({ data: { type: "user_group", attributes: g } });
    }));
    const membership = (loc: string, uid: string) =>
      [...this.groups.values()].filter((g) => g.location_id === loc).map((g) => ({ id: g.id, name: g.group_name, is_member: g.members.includes(uid), product_keys: [] }));
    this.on("GET", "/locations/{l}/users/{u}/group-membership", guard((_, m) => ok({ data: membership(m[1]!, m[2]!) })));
    this.on("PUT", "/locations/{l}/users/{u}/group-membership", guard((req, m) => {
      for (const g of this.groups.values()) {
        if (g.location_id !== m[1]) continue;
        g.members = g.members.filter((x: string) => x !== m[2]);
        if (req.body.group_ids.includes(g.id)) g.members.push(m[2]);
      }
      return ok({ data: membership(m[1]!, m[2]!) });
    }));

    // rules
    this.on("GET", "/locations/{l}/first-alert/rules", guard((req, m) => {
      const rows = [...this.rules.values()].filter((r) => r.location_id === m[1]).map(({ triggers, ...r }) => ({ ...r, trigger_types: triggers.map((t: any) => t.trigger_type) }));
      return page(rows, req.query, "first_alert_rule");
    }));
    this.on("POST", "/locations/{l}/first-alert/rules", guard((req, m) => {
      const rid = id("6f");
      this.rules.set(rid, { id: rid, location_id: m[1], ...req.body, groups: (req.body.group_ids ?? []).map((g: string) => ({ id: g })) });
      return ok({ data: { type: "first_alert_rule", attributes: this.rules.get(rid) } }, 201);
    }));
    this.on("GET", "/locations/{l}/first-alert/rules/{r}", guard((_, m) => ok({ data: { type: "first_alert_rule", attributes: this.rules.get(m[2]!) } })));
    this.on("PATCH", "/locations/{l}/first-alert/rules/{r}", guard((req, m) => {
      const r = this.rules.get(m[2]!);
      Object.assign(r, req.body);
      if (req.body.group_ids) r.groups = req.body.group_ids.map((g: string) => ({ id: g }));
      return ok({ data: { type: "first_alert_rule", attributes: r } });
    }));
    this.on("GET", "/locations/{l}/first-alert/config", guard((_, m) => ok({ data: this.faConfig.get(m[1]!) ?? { webhook_url: null, connector_mappings: [] } })));
    this.on("PUT", "/locations/{l}/first-alert/config", guard((req, m) => {
      this.faConfig.set(m[1]!, { webhook_url: req.body.webhook_url ?? null, connector_mappings: req.body.connector_mappings });
      return ok({ data: this.faConfig.get(m[1]!) });
    }));
    this.on("GET", "/locations/{l}/users/{u}/first-alert/notification-preferences", guard((_, m) => {
      const u = this.users.get(m[2]!);
      const rules = [...this.rules.values()].filter((r) => r.location_id === m[1] && r.groups.some((g: any) => this.groups.get(g.id)?.members.includes(u.id)));
      return ok({ emailNotifications: { masterEnabled: false, alerts: rules.map((r) => ({ alertId: r.id, alertName: r.name, emailEnabled: false })) }, digest: {}, webhook: { url: null } });
    }));
    this.on("PUT", "/locations/{l}/users/{u}/first-alert/email-preferences", guard((req) => ok({ emailNotifications: req.body })));

    // insights hub
    this.on("GET", "/locations/{l}/insights-hub/setup", guard((_, m) => ok({ data: { type: "insights_hub_setup", attributes: this.ihSetup.get(m[1]!) ?? { connector_mappings: [], group_access: [] } } })));
    this.on("POST", "/locations/{l}/insights-hub/setup", guard((req, m) => {
      this.ihSetup.set(m[1]!, { ...req.body });
      return ok({ data: { type: "insights_hub_setup", attributes: this.ihSetup.get(m[1]!) } }, 201);
    }));
    this.on("PATCH", "/locations/{l}/insights-hub/setup", guard((req, m) => {
      const cur = this.ihSetup.get(m[1]!) ?? { connector_mappings: [], group_access: [] };
      this.ihSetup.set(m[1]!, { ...cur, ...req.body });
      return ok({ data: { type: "insights_hub_setup", attributes: this.ihSetup.get(m[1]!) } });
    }));
    this.on("GET", "/locations/{l}/insights-hub/config", guard((_, m) => ok({ data: { type: "insights_hub_config", attributes: { monitor_all_numbers: this.ihConfig.get(m[1]!) ?? false } } })));
    this.on("PATCH", "/locations/{l}/insights-hub/config", guard((req, m) => {
      this.ihConfig.set(m[1]!, req.body.monitor_all_numbers);
      return ok({ data: { type: "insights_hub_config", attributes: { monitor_all_numbers: req.body.monitor_all_numbers } } });
    }));

    // connectors
    let planIdx = new Map<string, number>();
    this.on("GET", "/locations/{l}/connectors", guard((req, m) => page([...this.connectors.values()].filter((c) => c.location_id === m[1]), req.query, null)));
    this.on("POST", "/locations/{l}/connectors", guard((req, m) => {
      const cid = this.addConnector(m[1]!, "connecting", req.body.name);
      const conn = this.connectors.get(cid);
      conn.config = { ...conn.config, api_url: req.body.config.api_url, domain: req.body.config.domain };
      planIdx.set(cid, 0);
      return ok({ data: this.connectors.get(cid) }, 202);
    }));
    this.on("GET", "/locations/{l}/connectors/{c}", guard((_, m) => {
      const c = this.connectors.get(m[2]!);
      if (planIdx.has(c.id)) {
        const i = planIdx.get(c.id)!;
        c.status = this.connectorPlan[Math.min(i, this.connectorPlan.length - 1)];
        if (c.status === "error") c.state_reason = "invalid_permissions";
        planIdx.set(c.id, i + 1);
      }
      return ok({ data: c });
    }));
    this.on("PATCH", "/locations/{l}/connectors/{c}", guard((req, m) => {
      const c = this.connectors.get(m[2]!);
      planIdx.delete(c.id); // a settings change leaves the status as it is
      if (req.body.name) c.name = req.body.name;
      if (req.body.config) c.config = { ...c.config, api_url: req.body.config.api_url, domain: req.body.config.domain };
      return ok({ data: c });
    }));
    this.on("POST", "/locations/{l}/connectors/{c}/reactivate", guard((_, m) => {
      const c = this.connectors.get(m[2]!);
      if (this.reactivatePlan) this.connectorPlan = this.reactivatePlan;
      planIdx.set(c.id, 0);
      c.status = "connecting";
      return ok({ data: c }, 202);
    }));
    this.on("GET", "/locations/{l}/after-call/automation", guard((_, m) => {
      const h = this.afterCallHooks.get(m[1]!);
      return h ? ok({ data: { location_id: m[1], ...h } }) : nf();
    }));
    this.on("PUT", "/locations/{l}/after-call/automation", guard((req, m) => {
      this.afterCallHooks.set(m[1]!, { webhook_url: req.body.webhook_url, enabled: req.body.enabled });
      return ok({ data: { location_id: m[1], ...req.body } });
    }));
    this.on("POST", "/locations/{l}/connectors/{c}/deactivate", guard((_, m) => {
      const c = this.connectors.get(m[2]!);
      planIdx.delete(c.id);
      c.status = "inactive"; // the next GET sees it settled
      return ok({ data: { ...c, status: "deactivating" } }, 202);
    }));

    // users
    const userAttrs = (u: any) => ({ id: u.id, company_id: u.company_id, email: u.email, role: u.role, status: u.status, first_name: u.first_name, last_name: u.last_name, department: u.department ?? "", locations: u.location_ids.map((l: string) => ({ location_id: l })) });
    this.on("GET", "/companies/{c}/users", guard((req, m) => {
      const s = (req.query.search ?? "").toLowerCase();
      const locs = req.query.location_id ? req.query.location_id.split(",") : null;
      const rows = [...this.users.values()]
        .filter((u) => u.company_id === m[1] && u.email.toLowerCase().includes(s))
        .filter((u) => !locs || u.location_ids.some((l: string) => locs.includes(l)))
        .map(userAttrs);
      return page(rows, req.query, "company_user");
    }));
    this.on("POST", "/companies/{c}/users", guard((req, m) => {
      if (!req.headers["idempotency-key"]) return { status: 400, body: { error: "Idempotency-Key header is required" } };
      const uid = id("40");
      this.users.set(uid, { id: uid, company_id: m[1], email: req.body.email, role: req.body.role, status: "invited", location_ids: req.body.location_ids ?? [], products: new Set(), first_name: req.body.first_name, last_name: req.body.last_name });
      if (req.body.send_invitation) this.invitations.push(uid);
      return ok({ data: { type: "company_user", attributes: { ...userAttrs(this.users.get(uid)), external_id: "pending:x" } }, meta: { invitation_link: "https://app.example.com/invite/SECRET" } }, 201);
    }));
    this.on("GET", "/companies/{c}/users/{u}", guard((_, m) => ok({ data: { type: "company_user", attributes: userAttrs(this.users.get(m[2]!)) } })));
    this.on("PATCH", "/companies/{c}/users/{u}", guard((req, m) => {
      const u = this.users.get(m[2]!);
      if (req.body.location_ids) u.location_ids = req.body.location_ids;
      if (req.body.role) u.role = req.body.role;
      if (req.body.department !== undefined) u.department = req.body.department;
      return ok({ data: { type: "company_user", attributes: userAttrs(u) } });
    }));
    this.on("POST", "/companies/{c}/users/{u}/deactivate", guard((_, m) => {
      const u = this.users.get(m[2]!);
      if (u.status === "deactivated") return { status: 409, body: { error: { code: "CONFLICT", message: "User is already deactivated" } } };
      u.status = "deactivated";
      return ok({ data: { type: "company_user", attributes: userAttrs(u) } });
    }));
    this.on("GET", "/companies/{c}/users/{u}/connector-mappings", guard((_, m) => ok({ data: this.mappings.get(m[2]!) ?? [] })));
    this.on("PUT", "/companies/{c}/users/{u}/connector-mappings", guard((req, m) => {
      if (this.mappingStatus && req.body.mappings.length) return this.mappingStatus;
      this.mappings.set(m[2]!, req.body.mappings);
      return ok({ data: req.body.mappings });
    }));
    this.on("GET", "/locations/{l}/users", guard((req, m) => {
      const rows = [...this.users.values()]
        .filter((u) => u.location_ids.includes(m[1]))
        .map((u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, enabled_products: [...u.products], groups: this.groupNamesOf(u.id, m[1]!) }));
      return page(rows, req.query, "location_user");
    }));
    this.on("GET", "/locations/{l}/users/{u}", guard((_, m) => {
      const u = this.users.get(m[2]!);
      return u ? ok({ data: { type: "location_user", attributes: { id: u.id, email: u.email, role: u.role, status: u.status, enabled_products: [...u.products], groups: null } } }) : nf();
    }));
    this.on("POST", "/companies/{c}/users/{u}/resend-invitation", guard((_, m) => {
      const u = this.users.get(m[2]!);
      if (u.status !== "invited") return { status: 409, body: { error: { code: "CONFLICT", message: "User does not have a pending invitation" } } };
      this.invitations.push(u.id);
      return ok({ data: { type: "invitation_resend", attributes: { user_id: u.id, email: u.email } } }, 202);
    }));
    this.on("POST", "/companies/{c}/users/{u}/reactivate", guard((_, m) => {
      const u = this.users.get(m[2]!);
      u.status = "active";
      return ok({ data: { type: "company_user", attributes: userAttrs(u) } });
    }));
    this.on("POST", "/locations/{l}/users/{u}/products/{k}/enable", guard((_, m) => {
      this.users.get(m[2]!).products.add(m[3]);
      return ok({ data: { product_key: m[3], enabled: true } });
    }));
  }
}
