import type { Client, ProductKey } from "./client.js";
import {
  ConflictError,
  ConnectorError,
  ExtensionMappingError,
  FilterError,
  IntelligenceCloudError,
  NotFoundError,
  ValidationError,
  WorkflowError,
} from "./errors.js";
import { diff, numbersFor, sameSet } from "./util.js";

export const ALL_PRODUCTS: ProductKey[] = ["after-call-copilot", "first-alert-copilot", "insights-hub"];
export const MANAGER_ALERTS_GROUP = "Manager Alerts";
export const INSIGHTS_HUB_ACCESS_GROUP = "Insights Hub Access";
export const UPSET_CUSTOMER_RULE = "Upset Customer";
export const CUSTOMER_THREAT_RULE = "Customer Threat";
export const DEFAULT_VERTICAL_KEY = "csps-msps";
export const THREAT_PHRASES_MISSING = "Customer Threat phrases are provided by your Tresic contact.";
/** The `department` value that marks an integration (data-reading) user. Such users are never seats or managers. */
export const INTEGRATION_DEPARTMENT = "integration";

/** The fixed message of the ConflictError raised when a same-named company has another contact. */
export function companyNameConflictMessage(name: string): string {
  return (
    `A company named '${name}' already exists with a different primary contact. ` +
    "Pass companyId to use an existing company, or choose a different company name."
  );
}

/** The "Upset Customer" rule: sentiment below −40, priority high, routed to `groupIds`. */
export function upsetCustomerRule(groupIds: string[], enabled = false) {
  return {
    name: UPSET_CUSTOMER_RULE,
    priority: "high" as const,
    match_logic: "any" as const,
    enabled,
    triggers: [{ trigger_type: "sentiment" as const, config: { operator: "lt" as const, threshold: -40 } }],
    group_ids: groupIds,
  };
}

/** The "Customer Threat" rule: any threat phrase AND sentiment below −20, priority critical. */
export function customerThreatRule(groupIds: string[], phrases: readonly string[], enabled = false) {
  if (!phrases || phrases.length === 0) throw new FilterError(THREAT_PHRASES_MISSING);
  return {
    name: CUSTOMER_THREAT_RULE,
    priority: "critical" as const,
    match_logic: "all" as const,
    enabled,
    triggers: [
      { trigger_type: "sentiment" as const, config: { operator: "lt" as const, threshold: -20 } },
      { trigger_type: "keyword_match" as const, config: { match_logic: "any" as const, keywords: [...phrases] } },
    ],
    group_ids: groupIds,
  };
}

/** What `provisionSeatCustomer` builds. */
export interface SeatCustomerSpec {
  /** Default: `reseller_id` of the signed-in admin. */
  resellerId?: string;
  /**
   * The id of an existing company to use. Store the `companyId` a first run returns and pass it on
   * every re-run. Without it, an existing company is reused only when both its name and its primary
   * contact email match; a same-named company with another contact raises ConflictError.
   */
  companyId?: string;
  companyName: string;
  companyCode?: string;
  /** Becomes the company's customer admin and is always emailed an invitation. */
  primaryAdmin: { name: string; email: string; phone: string };
  /** Turn MFA off for the company (needed when an integration user lives in it). */
  mfaOff?: boolean;
  location: {
    name: string;
    street: string;
    city: string;
    state: string;
    country: string;
    zipcode: string;
    /** A `GET /verticals` id. Default: looked up by `verticalKey`. */
    verticalId?: string;
    /** Default `csps-msps`. */
    verticalKey?: string;
  };
  /**
   * Customer Threat phrases. Required when the Customer Threat rule has to be created.
   * Customer Threat phrases are provided by your Tresic contact.
   */
  threatPhrases?: readonly string[];
  /** Optional phone-system connector for the location. */
  connector?: {
    /** Default "<location name> phone system". */
    name?: string;
    apiUrl: string;
    domain: string;
    apiKey: string;
    /** Lines to monitor in First Alert and Insights Hub once the connector is active. */
    monitoredNumbers?: string[];
    /** Seconds to wait for the connector to settle, checking every 10 seconds. Default 600. */
    timeout?: number;
  };
  /** Optional single sign-on: claims the domain and returns the DNS TXT record to publish. */
  sso?: { domain: string };
  /** Reactivate the company or location when it is found deactivated (otherwise that is an error). */
  reactivate?: boolean;
}

/** A Base Intelligence Seat customer, rebuilt by name. */
export interface SeatCustomer {
  companyId: string;
  companyName: string;
  locationId: string;
  locationName: string;
  groups: { managerAlerts: string | null; insightsHubAccess: string | null };
  rules: { upsetCustomer: string | null; customerThreat: string | null };
  connectorId: string | null;
  connectorStatus: string | null;
  /** Why the connector is in its status, e.g. `invalid_permissions` for a key without the permissions the connector needs. */
  connectorStateReason: string | null;
  /** Users every workflow ignores (never a seat, manager or integration user; never updated). */
  excludeUserIds?: string[];
  /** Same as `excludeUserIds`, by email (case-insensitive). */
  excludeEmails?: string[];
}

export interface ProvisionResult extends SeatCustomer {
  /** Objects created by this run (everything else already existed). */
  created: string[];
  /** Objects found and kept; `connector:updated` when a found connector got the new settings. */
  existing: string[];
  /** DNS TXT record to publish for single sign-on, when `sso` was given. */
  ssoTxtRecord: { type: string; name: string; value: string } | null;
}

/** A customer object, or a company id to rebuild it from. */
export type CustomerRef = SeatCustomer | string;

export interface NewUser {
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber?: string;
  /**
   * Email the invitation once the user is fully set up (lines mapped, groups and products on).
   * Default true. False: create the user without an invitation; send one later with
   * `users.resendInvitation`.
   */
  sendInvitation?: boolean;
  authMethod?: "password" | "sso";
  /** Reuse an Idempotency-Key when retrying the same create. */
  idempotencyKey?: string;
}

export type UserKind = "frontline" | "manager" | "integration";

export interface UserResult {
  userId: string;
  email: string;
  kind: UserKind;
  /** False when the user already existed (found by email) and the workflow carried on. */
  created: boolean;
  extensions: string[];
  /** Managers (and integration users) whose line list this call changed. */
  managersUpdated: string[];
  /** True when this call emailed the invitation. */
  invited: boolean;
  /** Rule ids this call switched on (addManager only). */
  alertsActivated: string[];
}

/** Options for `addManager`. */
export interface AddManagerOptions {
  /** Switch the customer's two alert rules on once the manager is set up. Default true. */
  activateAlerts?: boolean;
}

export interface ChangeResult {
  userId: string;
  oldExtension: string;
  newExtension: string;
  managersUpdated: string[];
}

export interface RemoveResult {
  userId: string;
  /**
   * `integration` for a user tagged `department: "integration"`, an excluded user, or a non-manager
   * holding more than one line: such a user releases no lines.
   */
  kind: UserKind;
  /** Lines taken off managers, integration users, First Alert and Insights Hub (only lines no other end user holds). */
  extensionsReleased: string[];
  managersUpdated: string[];
}

/** What `offboardCustomer` did. */
export interface OffboardResult {
  webhookPaused: boolean;
  firstAlertWebhookCleared: boolean;
  connectorDeactivated: boolean;
  integrationUsersDeactivated: string[];
  companyDeactivated: boolean;
}

export interface SeatUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  enabledProducts: string[];
  groups: string[];
  /** The user's department (`integration` marks an integration user). */
  department: string | null;
}

export interface SyncResult {
  dryRun: boolean;
  /** The union of end-user extensions (end users holding exactly one line). */
  lines: string[];
  /** Managers and integration users whose lines change. */
  managers: { userId: string; add: string[]; remove: string[] }[];
  firstAlert: { add: string[]; remove: string[] };
  insightsHub: { add: string[]; remove: string[] };
}

async function step<T>(name: string, partial: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkflowError || err instanceof ExtensionMappingError || err instanceof FilterError) throw err;
    throw new WorkflowError(name, partial, err);
  }
}

/** JSON with sorted keys, for order-insensitive comparison. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const CONNECTOR_RANK: Record<string, number> = { active: 0, connecting: 1, error: 2, deactivating: 3, inactive: 4 };

/** An integration (data-reading) user: `department` is "integration". Never a seat or a manager. */
export function isIntegration(u: { department?: string | null }): boolean {
  return (u.department ?? "").trim().toLowerCase() === INTEGRATION_DEPARTMENT;
}

/** A manager: After Call, First Alert and Insights Hub, and not an integration user. Groups are not checked. */
export function isManager(u: { enabledProducts: string[]; department?: string | null }): boolean {
  return !isIntegration(u) && ALL_PRODUCTS.every((p) => u.enabledProducts.includes(p));
}

/** An end user (a seat): After Call only, and not an integration user. */
export function isFrontline(u: { enabledProducts: string[]; department?: string | null }): boolean {
  return !isIntegration(u) && u.enabledProducts.length === 1 && u.enabledProducts[0] === "after-call-copilot";
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Base Intelligence Seat lifecycle (admin credentials). One location per customer, After Call for
 * every end user, First Alert and Insights Hub for managers, two alert rules routed to
 * "Manager Alerts", and an "Insights Hub Access" group.
 */
export class Workflows {
  constructor(private readonly c: Client) {}

  // ------------------------------------------------------------------ lookups
  private async bestConnector(locationId: string) {
    let best: { id?: string; status?: string; state_reason?: string } | null = null;
    for await (const row of this.c.connectors.iterLocationConnectors(locationId)) {
      if (!best || (CONNECTOR_RANK[row.status ?? ""] ?? 9) < (CONNECTOR_RANK[best.status ?? ""] ?? 9)) best = row;
    }
    return best;
  }

  private async resolve(ref: CustomerRef): Promise<SeatCustomer> {
    return typeof ref === "string" ? this.getSeatCustomer(ref) : ref;
  }

  private requireConnector(customer: SeatCustomer): string {
    if (!customer.connectorId) {
      throw new IntelligenceCloudError("This customer has no connector at its location, so numbers can't be mapped.");
    }
    return customer.connectorId;
  }

  /**
   * Find the user by email (reactivating and assigning to the location if needed) or create them.
   * Re-running a workflow therefore carries on with the same user.
   */
  private async ensureUser(
    customer: SeatCustomer,
    u: NewUser,
  ): Promise<{ id: string; created: boolean; status: string | null }> {
    if (!u?.email || !u.firstName || !u.lastName) throw new FilterError("email, firstName and lastName are required.");
    const users = this.c.users;
    const found = await users.findUserByEmail(customer.companyId, u.email);
    if (!found?.id) {
      const r = await users.createCompanyUser(
        customer.companyId,
        {
          email: u.email,
          first_name: u.firstName,
          last_name: u.lastName,
          phone_number: u.phoneNumber,
          role: "frontline_user",
          location_ids: [customer.locationId],
          send_invitation: false, // the invitation is emailed last, once the user is set up
          auth_method: u.authMethod ?? "password",
        },
        { idempotencyKey: u.idempotencyKey },
      );
      const id = r.data?.attributes?.id;
      if (!id) throw new IntelligenceCloudError("User create returned no id.");
      return { id, created: true, status: r.data?.attributes?.status ?? "invited" };
    }
    if (found.status === "deactivated") await users.reactivateCompanyUser(customer.companyId, found.id);
    const detail = (await users.getCompanyUser(customer.companyId, found.id)).data?.attributes ?? {};
    if (detail.role !== "frontline_user") {
      throw new FilterError(`${u.email} is a ${detail.role}; Seat users are frontline users.`);
    }
    if (!(detail.locations ?? []).some((l) => l.location_id === customer.locationId)) {
      await users.addLocations(customer.companyId, found.id, [customer.locationId]);
    }
    return { id: found.id, created: false, status: detail.status ?? null };
  }

  /** The last step: email the invitation to a user who has not accepted one yet. */
  private async invite(customer: SeatCustomer, u: NewUser, userId: string, status: string | null): Promise<boolean> {
    if (u.sendInvitation === false || status !== "invited") return false;
    await this.c.users.resendInvitation(customer.companyId, userId);
    return true;
  }

  /** Replace the user's numbers on the customer's connector; a refusal becomes ExtensionMappingError. */
  private async mapNumbers(customer: SeatCustomer, userId: string, numbers: string[]): Promise<void> {
    const connectorId = this.requireConnector(customer);
    try {
      await this.c.users.setNumbers(customer.companyId, userId, connectorId, numbers);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ConflictError) throw new ExtensionMappingError(userId, err);
      throw err;
    }
  }

  /** Lines at the location: First Alert's monitored numbers for the customer's connector. */
  private async locationLines(customer: SeatCustomer): Promise<string[]> {
    if (!customer.connectorId) return [];
    const cfg = (await this.c.firstAlert.getFirstAlertConfig(customer.locationId)).data;
    return numbersFor(cfg?.connector_mappings, customer.connectorId);
  }

  private excluded(customer: SeatCustomer, id: string, email: string | null | undefined): boolean {
    if ((customer.excludeUserIds ?? []).includes(id)) return true;
    const e = (email ?? "").trim().toLowerCase();
    return Boolean(e) && (customer.excludeEmails ?? []).some((x) => x.trim().toLowerCase() === e);
  }

  /** Active or invited frontline users at the location (not excluded), with their department. */
  private async seatUsers(customer: SeatCustomer): Promise<SeatUser[]> {
    const departments = new Map<string, string | null>();
    for await (const u of this.c.users.iterCompanyUsers(customer.companyId, { locationId: [customer.locationId] })) {
      if (u?.id) departments.set(u.id, u.department ?? null);
    }
    const out: SeatUser[] = [];
    for await (const a of this.c.users.iterLocationUsers(customer.locationId)) {
      if (!a?.id || a.status === "deactivated" || a.role !== "frontline_user") continue;
      if (this.excluded(customer, a.id, a.email)) continue;
      out.push({
        id: a.id,
        email: a.email ?? "",
        displayName: a.display_name ?? "",
        status: a.status ?? "",
        enabledProducts: [...(a.enabled_products ?? [])],
        groups: [...(a.groups ?? [])],
        department: departments.get(a.id) ?? null,
      });
    }
    return out;
  }

  /** Managers and integration users: the users who hold every line. */
  private async lineHolders(customer: SeatCustomer): Promise<SeatUser[]> {
    const all = await this.seatUsers(customer);
    return all.filter((u) => isManager(u) || isIntegration(u));
  }

  /** Lines held by end users who hold exactly one line (users holding several are not seats). */
  private async endUserLines(customer: SeatCustomer, connectorId: string, exceptUserId?: string): Promise<Set<string>> {
    const lines = new Set<string>();
    for (const u of await this.listFrontlineUsers(customer)) {
      if (u.id === exceptUserId) continue;
      const nums = await this.c.users.userNumbers(customer.companyId, u.id, connectorId);
      if (nums.length === 1) lines.add(nums[0]!);
    }
    return lines;
  }

  // ------------------------------------------------------------------ workflows
  /** Rebuild the customer object (location, groups, rules, connector) from a company id. */
  async getSeatCustomer(companyId: string, options: { locationName?: string } = {}): Promise<SeatCustomer> {
    const company = (await this.c.companies.getCompany(companyId)).data?.attributes;
    if (!company?.id) throw new NotFoundError(404, "NOT_FOUND", "Company not found.");
    let loc: { id?: string; location_name?: string } | null = null;
    if (options.locationName) {
      loc = await this.c.locations.findLocation(companyId, options.locationName);
    } else {
      for await (const row of this.c.locations.iterCompanyLocations(companyId, { isActive: true })) {
        loc = row;
        break;
      }
    }
    if (!loc?.id) throw new NotFoundError(404, "NOT_FOUND", "The company has no matching active location.");
    const locationId = loc.id;
    const ma = await this.c.groups.findGroup(locationId, MANAGER_ALERTS_GROUP);
    const iha = await this.c.groups.findGroup(locationId, INSIGHTS_HUB_ACCESS_GROUP);
    const upset = await this.c.firstAlert.findRule(locationId, UPSET_CUSTOMER_RULE);
    const threat = await this.c.firstAlert.findRule(locationId, CUSTOMER_THREAT_RULE);
    const conn = await this.bestConnector(locationId);
    return {
      companyId,
      companyName: company.company_name ?? "",
      locationId,
      locationName: loc.location_name ?? "",
      groups: { managerAlerts: ma?.id ?? null, insightsHubAccess: iha?.id ?? null },
      rules: { upsetCustomer: upset?.id ?? null, customerThreat: threat?.id ?? null },
      connectorId: conn?.id ?? null,
      connectorStatus: conn?.status ?? null,
      connectorStateReason: conn?.state_reason ?? null,
    };
  }

  /**
   * Create (or finish) a Base Intelligence Seat customer. Idempotent: objects that already exist
   * (found by name) are kept, so a re-run completes a half-built customer.
   */
  async provisionSeatCustomer(spec: SeatCustomerSpec): Promise<ProvisionResult> {
    const c = this.c;
    if (!spec?.companyName || !spec.primaryAdmin || !spec.location?.name) {
      throw new FilterError("companyName, primaryAdmin and location are required.");
    }
    const phrases = [...(spec.threatPhrases ?? [])];
    const created: string[] = [];
    const existing: string[] = [];
    const partial: Record<string, unknown> = { created, existing };

    const resellerId =
      spec.resellerId ??
      (await step("whoami", partial, async () => {
        const me = await c.whoami();
        if (!me.reseller_id) throw new IntelligenceCloudError("This login has no reseller id; pass resellerId.");
        return me.reseller_id;
      }));

    // 1. company: an explicit id, or a name match whose contact email also matches. A same-named
    // company with another contact is never adopted.
    type CompanyRow = { id?: string; is_active?: boolean; company_name?: string };
    let company: CompanyRow | null;
    if (spec.companyId) {
      const id = spec.companyId;
      company = await step("get_company", partial, async () => (await c.companies.getCompany(id)).data?.attributes ?? null);
      if (!company?.id) throw new NotFoundError(404, "NOT_FOUND", "Company not found.");
    } else {
      const sameName = await step("find_company", partial, () => c.companies.findCompanies(resellerId, spec.companyName));
      const want = norm(spec.primaryAdmin.email);
      const matches: CompanyRow[] = [];
      for (const row of sameName) {
        if (!row.id) continue;
        const id = row.id;
        const detail = await step("find_company", partial, async () => (await c.companies.getCompany(id)).data?.attributes);
        if (detail && norm(detail.primary_admin_contact_email) === want) matches.push(detail);
      }
      if (sameName.length && matches.length !== 1) {
        throw new ConflictError(409, "company_name_conflict", companyNameConflictMessage(spec.companyName));
      }
      company = matches[0] ?? null;
    }
    if (company?.id && company.is_active === false) {
      if (!spec.reactivate) {
        throw new FilterError("The company exists but is deactivated. Set reactivate: true to reactivate it.");
      }
      const id = company.id;
      await step("reactivate_company", partial, () => c.companies.reactivateCompany(id));
    }
    // a new customer needs the Customer Threat phrases: refuse before anything is created
    if (!company && phrases.length === 0) throw new FilterError(THREAT_PHRASES_MISSING);
    if (!company) {
      company = await step("create_company", partial, async () => {
        const r = await c.companies.createCompany(resellerId, {
          company_name: spec.companyName,
          company_code: spec.companyCode,
          primary_admin_contact_name: spec.primaryAdmin.name,
          primary_admin_contact_email: spec.primaryAdmin.email,
          primary_admin_contact_phone: spec.primaryAdmin.phone,
          enabled_products: ALL_PRODUCTS,
        });
        created.push("company");
        return r.data!.attributes!;
      });
    } else {
      existing.push("company");
    }
    const companyId = company.id!;
    partial.companyId = companyId;

    // 2. MFA off only for an integration-user company, then read it back
    if (spec.mfaOff) {
      await step("mfa_off", partial, async () => {
        const cur = (await c.companies.getCompany(companyId)).data?.attributes;
        if (cur?.mfa_enforced !== false) await c.companies.updateCompany(companyId, { mfa_enforced: false });
        const check = (await c.companies.getCompany(companyId)).data?.attributes;
        if (check?.mfa_enforced !== false) throw new IntelligenceCloudError("MFA is still on after the update.");
      });
    }

    // 3. After Call, First Alert and Insights Hub on the company
    await step("company_products", partial, () => c.companies.addProducts(companyId, ALL_PRODUCTS));

    // 4. the single location, with the three products
    let loc = await step("find_location", partial, () => c.locations.findLocation(companyId, spec.location.name));
    if (!loc) {
      loc = await step("create_location", partial, async () => {
        let verticalId = spec.location.verticalId;
        if (!verticalId) {
          const key = spec.location.verticalKey ?? DEFAULT_VERTICAL_KEY;
          const v = ((await c.locations.listVerticals()).data ?? []).find((x) => x.key === key);
          if (!v?.id) throw new IntelligenceCloudError(`No industry with key "${key}".`);
          verticalId = v.id;
        }
        const r = await c.locations.createLocation(companyId, {
          location_name: spec.location.name,
          street: spec.location.street,
          city: spec.location.city,
          state: spec.location.state,
          country: spec.location.country,
          zipcode: spec.location.zipcode,
          vertical_id: verticalId,
          enabled_products: ALL_PRODUCTS,
        });
        created.push("location");
        return r.data!.attributes!;
      });
    } else {
      if (loc.is_active === false) {
        if (!spec.reactivate) {
          throw new FilterError("The location exists but is deactivated. Set reactivate: true to reactivate it.");
        }
        const lid = loc.id!;
        await step("reactivate_location", partial, () => c.locations.reactivateLocation(companyId, lid));
      }
      await step("location_products", partial, () => c.locations.addProducts(companyId, loc!.id!, ALL_PRODUCTS));
    }
    const locationId = loc.id!;
    partial.locationId = locationId;

    // 5. groups
    const ensureGroup = (name: string) =>
      step(`group:${name}`, partial, async () => {
        const found = await c.groups.findGroup(locationId, name);
        if (found?.id) return found.id;
        const r = await c.groups.createUserGroup(locationId, { group_name: name });
        created.push(`group:${name}`);
        return r.data!.attributes!.id!;
      });
    const managerAlerts = await ensureGroup(MANAGER_ALERTS_GROUP);
    const ihAccess = await ensureGroup(INSIGHTS_HUB_ACCESS_GROUP);
    partial.groups = { managerAlerts, insightsHubAccess: ihAccess };

    // 6. the two rules, created disabled and routed to Manager Alerts
    const ensureRule = (name: string, body: () => ReturnType<typeof upsetCustomerRule> | ReturnType<typeof customerThreatRule> | null) =>
      step(`rule:${name}`, partial, async () => {
        const found = await c.firstAlert.findRule(locationId, name);
        if (!found?.id) {
          const r = await c.firstAlert.createAlertRule(locationId, body()!);
          created.push(`rule:${name}`);
          return r.data!.attributes!.id!;
        }
        // keep an existing rule routed to Manager Alerts, and its triggers current (e.g. a new phrase list)
        const rule = (await c.firstAlert.getAlertRule(locationId, found.id)).data?.attributes ?? {};
        if (!(rule.groups ?? []).some((g) => g.id === managerAlerts)) {
          await c.firstAlert.addRuleGroups(locationId, found.id, [managerAlerts]);
        }
        const want = body();
        if (want) {
          const cur = (rule.triggers ?? []).map((t) => ({ trigger_type: t.trigger_type, config: t.config }));
          if (canonical(cur) !== canonical(want.triggers)) {
            await c.firstAlert.updateAlertRule(locationId, found.id, { triggers: want.triggers });
          }
        }
        return found.id;
      });
    if (phrases.length === 0 && !(await c.firstAlert.findRule(locationId, CUSTOMER_THREAT_RULE))) {
      throw new FilterError(THREAT_PHRASES_MISSING);
    }
    const rules = {
      upsetCustomer: await ensureRule(UPSET_CUSTOMER_RULE, () => upsetCustomerRule([managerAlerts])),
      customerThreat: await ensureRule(CUSTOMER_THREAT_RULE, () =>
        phrases.length ? customerThreatRule([managerAlerts], phrases) : null,
      ),
    };
    partial.rules = rules;

    // 7. Insights Hub: group access, every call at the location
    await step("insights_hub", partial, async () => {
      const setup = (await c.insightsHub.getInsightsHubSetup(locationId)).data?.attributes;
      if (!(setup?.group_access ?? []).includes(ihAccess)) await c.insightsHub.addGroups(locationId, [ihAccess]);
      const cfg = (await c.insightsHub.getInsightsHubConfig(locationId)).data?.attributes;
      if (cfg?.monitor_all_numbers !== true) {
        await c.insightsHub.updateInsightsHubConfig(locationId, { monitor_all_numbers: true });
      }
    });

    // 8. optional connector, then monitored numbers once it is active
    let connectorId: string | null = null;
    let connectorStatus: string | null = null;
    let connectorStateReason: string | null = null;
    if (spec.connector) {
      const cs = spec.connector;
      const name = cs.name ?? `${spec.location.name} - NetSapiens`;
      type Conn = { id?: string; status?: string; state_reason?: string; name?: string; config?: { api_url?: string; domain?: string } };
      const conn = await step("connector", partial, async (): Promise<Conn | null> => {
        // match on the phone-system domain (one connector per domain), else on the name
        let byDomain: Conn | null = null;
        let byName: Conn | null = null;
        for await (const row of c.connectors.iterLocationConnectors(locationId)) {
          if (!row.id) continue;
          const detail = ((await c.connectors.getConnector(locationId, row.id)).data ?? row) as Conn;
          const rank = (x: Conn | null) => (x ? (CONNECTOR_RANK[x.status ?? ""] ?? 9) : 99);
          if (norm(detail.config?.domain) === norm(cs.domain) && rank(detail) < rank(byDomain)) byDomain = detail;
          if (detail.name === name && rank(detail) < rank(byName)) byName = detail;
        }
        const found = byDomain ?? byName;
        const wait = { timeout: cs.timeout };
        try {
          if (!found?.id) {
            const r = await c.connectors.createConnector(
              locationId,
              { name, type: "netsapiens", config: { api_url: cs.apiUrl, domain: cs.domain, api_key: cs.apiKey } },
              wait,
            );
            created.push("connector");
            return (r.data ?? null) as Conn | null;
          }
          existing.push("connector");
          const fid = found.id;
          const unchanged =
            found.name === name && found.config?.api_url === cs.apiUrl && norm(found.config?.domain) === norm(cs.domain);
          if (unchanged && found.status === "active") return found;
          if (unchanged && found.status === "connecting") {
            return (await c.connectors.waitForStatus(locationId, fid, ["active", "error"], wait)) as Conn;
          }
          // in error, inactive, or changed: apply the settings (and the key), then restart if needed
          await c.connectors.updateConnector(
            locationId,
            fid,
            { name, config: { api_url: cs.apiUrl, domain: cs.domain, api_key: cs.apiKey } },
            { wait: false },
          );
          existing.push("connector:updated");
          if (found.status === "inactive") {
            return ((await c.connectors.reactivateConnector(locationId, fid, wait)).data ?? null) as Conn | null;
          }
          const settled = (await c.connectors.waitForStatus(locationId, fid, ["active", "error", "inactive"], wait)) as Conn;
          if (settled.status === "active") return settled;
          if (settled.status !== "inactive") await c.connectors.deactivateConnector(locationId, fid, wait);
          return ((await c.connectors.reactivateConnector(locationId, fid, wait)).data ?? null) as Conn | null;
        } catch (err) {
          // a connector in error (or still connecting) is recorded on the result, not raised
          if (!(err instanceof ConnectorError)) throw err;
          if (!found) created.push("connector");
          return (err.connector ?? null) as Conn | null;
        }
      });
      connectorId = conn?.id ?? null;
      connectorStatus = conn?.status ?? null;
      connectorStateReason = conn?.state_reason ?? null;
      partial.connectorId = connectorId;
      if (connectorId && connectorStatus === "active" && cs.monitoredNumbers?.length) {
        await step("monitored_numbers", partial, async () => {
          await c.firstAlert.addMonitoredNumbers(locationId, connectorId!, cs.monitoredNumbers!);
          await c.insightsHub.addNumbers(locationId, connectorId!, cs.monitoredNumbers!);
        });
      }
    } else {
      const found = await step("connector", partial, () => this.bestConnector(locationId));
      connectorId = found?.id ?? null;
      connectorStatus = found?.status ?? null;
      connectorStateReason = found?.state_reason ?? null;
    }

    // 9. optional single sign-on: claim the domain
    let ssoTxtRecord: ProvisionResult["ssoTxtRecord"] = null;
    if (spec.sso?.domain) {
      ssoTxtRecord = await step("sso_domain", partial, async () => {
        const d = (await c.sso.claimCompanyDomain(companyId, { domain: spec.sso!.domain })).data;
        return { type: d?.verification?.type ?? "TXT", name: d?.verification?.name ?? "", value: d?.verification?.value ?? "" };
      });
    }

    // The two rules stay off until a manager is in place: addManager switches them on
    // (activateAlerts: true), or call activateSeatAlerts yourself.

    return {
      companyId,
      companyName: spec.companyName,
      locationId,
      locationName: spec.location.name,
      groups: { managerAlerts, insightsHubAccess: ihAccess },
      rules,
      connectorId,
      connectorStatus,
      connectorStateReason,
      created,
      existing,
      ssoTxtRecord,
    };
  }

  /**
   * Switch on the customer's two alert rules (Upset Customer, Customer Threat). Rules already on are
   * left as they are. Returns the ids of the rules this call switched on.
   */
  async activateSeatAlerts(ref: CustomerRef): Promise<string[]> {
    const c = this.c;
    const customer = await this.resolve(ref);
    const switched: string[] = [];
    await step("activate_alerts", { switched }, async () => {
      for (const id of [customer.rules.upsetCustomer, customer.rules.customerThreat]) {
        if (!id) continue;
        const r = (await c.firstAlert.getAlertRule(customer.locationId, id)).data?.attributes;
        if (r?.enabled !== true) {
          await c.firstAlert.updateAlertRule(customer.locationId, id, { enabled: true });
          switched.push(id);
        }
      }
    });
    return switched;
  }

  /**
   * End user: create (or find) the user without an invitation (frontline, After Call only, at the
   * location), alert email off, map their extension, then add the extension to every manager's
   * mapping and to the First Alert and Insights Hub numbers, and last email the invitation (unless
   * `user.sendInvitation` is false). A refused mapping stops before managers, First Alert and
   * Insights Hub are touched and throws ExtensionMappingError; no invitation has been sent.
   */
  async addFrontlineUser(ref: CustomerRef, user: NewUser, extension: string): Promise<UserResult> {
    const c = this.c;
    const ext = String(extension ?? "").trim();
    if (!ext) throw new FilterError("extension is required.");
    const customer = await this.resolve(ref);
    if (!customer.connectorId) throw new FilterError("This customer has no connector; add one before adding end users.");
    const connectorId = customer.connectorId;
    const partial: Record<string, unknown> = {};
    const { id: userId, created, status } = await step("create_user", partial, () => this.ensureUser(customer, user));
    partial.userId = userId;
    await step("enable_after_call", partial, () => c.products.enableUserProduct(customer.locationId, userId, "after-call-copilot"));
    await step("alert_email_off", partial, () =>
      c.firstAlert.setAlertEmailPreferences(customer.locationId, userId, { masterEnabled: false, alerts: [] }),
    );
    await step("map_extension", partial, () => this.mapNumbers(customer, userId, [ext]));
    const managersUpdated: string[] = [];
    partial.managersUpdated = managersUpdated;
    await step("managers", partial, async () => {
      for (const m of await this.lineHolders(customer)) {
        if (m.id === userId) continue;
        const cur = await c.users.userNumbers(customer.companyId, m.id, connectorId);
        if (cur.includes(ext)) continue;
        await this.mapNumbers(customer, m.id, [...cur, ext]);
        managersUpdated.push(m.id);
      }
    });
    await step("first_alert_numbers", partial, () => c.firstAlert.addMonitoredNumbers(customer.locationId, connectorId, [ext]));
    await step("insights_hub_numbers", partial, () => c.insightsHub.addNumbers(customer.locationId, connectorId, [ext]));
    const invited = await step("invitation", partial, () => this.invite(customer, user, userId, status));
    return {
      userId, email: user.email, kind: "frontline", extensions: [ext], managersUpdated, created, invited, alertsActivated: [],
    };
  }

  /**
   * Manager: create (or find) the user without an invitation, with After Call, First Alert and
   * Insights Hub at the location, both groups, alert email on for every rule they receive, and a
   * mapping of exactly the end-user lines at the location. The manager's own phone line is not
   * captured on the Seat: it is never mapped, nor added to First Alert or Insights Hub, and an
   * extension passed as the third argument throws FilterError. Then, with `activateAlerts`
   * (default true), switch the customer's two alert rules on (see activateSeatAlerts), and last
   * email the invitation (unless `user.sendInvitation` is false). A refused mapping throws
   * ExtensionMappingError: the rules stay as they were and no invitation has been sent.
   */
  async addManager(ref: CustomerRef, user: NewUser, options: AddManagerOptions = {}): Promise<UserResult> {
    const c = this.c;
    const opts: AddManagerOptions = options ?? {};
    if (typeof opts !== "object" || Object.keys(opts).some((k) => k !== "activateAlerts")) {
      throw new FilterError("A manager's own phone line is not captured on the Seat: addManager takes no extension.");
    }
    const customer = await this.resolve(ref);
    const partial: Record<string, unknown> = {};
    const { id: userId, created, status } = await step("create_user", partial, () => this.ensureUser(customer, user));
    partial.userId = userId;
    await step("enable_products", partial, async () => {
      for (const key of ALL_PRODUCTS) await c.products.enableUserProduct(customer.locationId, userId, key);
    });
    await step("groups", partial, async () => {
      const ids = [customer.groups.managerAlerts, customer.groups.insightsHubAccess].filter((x): x is string => Boolean(x));
      if (ids.length) await c.groups.addUserToGroups(customer.locationId, userId, ids);
    });
    await step("alert_email_on", partial, async () => {
      const prefs = await c.firstAlert.getAlertNotificationPreferences(customer.locationId, userId);
      const alerts = (prefs.emailNotifications?.alerts ?? [])
        .filter((a) => a.alertId)
        .map((a) => ({ alertId: a.alertId!, emailEnabled: true }));
      await c.firstAlert.setAlertEmailPreferences(customer.locationId, userId, { masterEnabled: true, alerts });
    });
    const lines = await step("read_lines", partial, () => this.locationLines(customer));
    const all = [...lines];
    if (all.length) await step("map_all_lines", partial, () => this.mapNumbers(customer, userId, all));
    const alertsActivated = (opts.activateAlerts ?? true) ? await this.activateSeatAlerts(customer) : [];
    partial.alertsActivated = alertsActivated;
    const invited = await step("invitation", partial, () => this.invite(customer, user, userId, status));
    return { userId, email: user.email, kind: "manager", extensions: all, managersUpdated: [], created, invited, alertsActivated };
  }

  /**
   * Integration user (reads calls, alerts and insights for another system; never a seat or a
   * manager): create (or find) the user without an invitation, tag it `department: "integration"`,
   * switch on After Call, First Alert and Insights Hub, add it to both groups, switch every alert
   * email off, map all lines, and last email the invitation (unless `user.sendInvitation` is false;
   * the person who holds the integration's password accepts it). Integration users keep every line
   * as end users come and go (like managers) and release no lines when removed. The user must sign
   * in with a password (`authMethod: "password"`). Never switches alerts on.
   */
  async addIntegrationUser(ref: CustomerRef, user: NewUser): Promise<UserResult> {
    const c = this.c;
    if ((user?.authMethod ?? "password") !== "password") {
      throw new FilterError("An integration user signs in with a password (authMethod: \"password\").");
    }
    const customer = await this.resolve(ref);
    const partial: Record<string, unknown> = {};
    const { id: userId, created, status } = await step("create_user", partial, () => this.ensureUser(customer, user));
    partial.userId = userId;
    await step("tag_integration", partial, () =>
      c.users.updateCompanyUser(customer.companyId, userId, { department: INTEGRATION_DEPARTMENT }),
    );
    await step("enable_products", partial, async () => {
      for (const key of ALL_PRODUCTS) await c.products.enableUserProduct(customer.locationId, userId, key);
    });
    await step("groups", partial, async () => {
      const ids = [customer.groups.managerAlerts, customer.groups.insightsHubAccess].filter((x): x is string => Boolean(x));
      if (ids.length) await c.groups.addUserToGroups(customer.locationId, userId, ids);
    });
    await step("alert_email_off", partial, () =>
      c.firstAlert.setAlertEmailPreferences(customer.locationId, userId, { masterEnabled: false, alerts: [] }),
    );
    const lines = await step("read_lines", partial, () => this.locationLines(customer));
    if (lines.length) await step("map_all_lines", partial, () => this.mapNumbers(customer, userId, lines));
    const invited = await step("invitation", partial, () => this.invite(customer, user, userId, status));
    return { userId, email: user.email, kind: "integration", extensions: lines, managersUpdated: [], created, invited, alertsActivated: [] };
  }

  /** Move an end user from one extension to another: their mapping, every manager and integration user, First Alert, Insights Hub. */
  async changeUserExtension(ref: CustomerRef, userId: string, oldExtension: string, newExtension: string): Promise<ChangeResult> {
    const c = this.c;
    const oldExt = String(oldExtension ?? "").trim();
    const newExt = String(newExtension ?? "").trim();
    if (!oldExt || !newExt) throw new FilterError("oldExtension and newExtension are required.");
    const customer = await this.resolve(ref);
    const connectorId = this.requireConnector(customer);
    const swap = (cur: string[]) => [...new Set([...cur.filter((n) => n !== oldExt), newExt])];
    const partial: Record<string, unknown> = { userId };
    await step("user_mapping", partial, async () =>
      this.mapNumbers(customer, userId, swap(await c.users.userNumbers(customer.companyId, userId, connectorId))),
    );
    const managersUpdated: string[] = [];
    partial.managersUpdated = managersUpdated;
    await step("managers", partial, async () => {
      for (const m of await this.lineHolders(customer)) {
        if (m.id === userId) continue;
        const cur = await c.users.userNumbers(customer.companyId, m.id, connectorId);
        const target = swap(cur);
        if (sameSet(cur, target)) continue;
        await this.mapNumbers(customer, m.id, target);
        managersUpdated.push(m.id);
      }
    });
    await step("first_alert_numbers", partial, async () => {
      const cfg = (await c.firstAlert.getFirstAlertConfig(customer.locationId)).data;
      await c.firstAlert.setMonitoredNumbers(customer.locationId, connectorId, swap(numbersFor(cfg?.connector_mappings, connectorId)));
    });
    await step("insights_hub_numbers", partial, async () => {
      const setup = (await c.insightsHub.getInsightsHubSetup(customer.locationId)).data?.attributes;
      await c.insightsHub.setNumbers(customer.locationId, connectorId, swap(numbersFor(setup?.connector_mappings, connectorId)));
    });
    return { userId, oldExtension: oldExt, newExtension: newExt, managersUpdated };
  }

  /**
   * Remove a user, in this order: leave every group, clear their number mapping, take their line off
   * managers, integration users, First Alert and Insights Hub (unless `keepExtensions`), then
   * deactivate. Products are left as they are.
   *
   * Only an end user releases a line, and only a line no other end user at the location still
   * holds. Managers, integration users (`department: "integration"`), excluded users and any
   * non-manager holding more than one line release nothing: every other line stays where it is.
   */
  async removeUser(ref: CustomerRef, userId: string, options: { keepExtensions?: boolean } = {}): Promise<RemoveResult> {
    const c = this.c;
    const customer = await this.resolve(ref);
    const partial: Record<string, unknown> = { userId };
    const row = await step("read_user", partial, async () => (await c.users.getLocationUser(customer.locationId, userId)).data?.attributes ?? {});
    const detail = await step("read_user", partial, async () => (await c.users.getCompanyUser(customer.companyId, userId)).data?.attributes ?? {});
    const u = { enabledProducts: [...(row.enabled_products ?? [])], department: detail.department ?? null };
    const connectorId = customer.connectorId;
    const mappings = await step("read_mapping", partial, async () => (await c.users.getUserNumberMappings(customer.companyId, userId)).data ?? []);
    const own = connectorId ? numbersFor(mappings, connectorId) : [];
    const kind: UserKind =
      isIntegration(u) || this.excluded(customer, userId, detail.email ?? row.email)
        ? "integration"
        : isManager(u)
          ? "manager"
          : own.length > 1
            ? "integration"
            : "frontline";
    let release: string[] = [];
    if (kind === "frontline" && !options.keepExtensions && connectorId && own.length) {
      // a line another end user still holds stays where it is
      const held = new Set<string>();
      await step("read_end_user_lines", partial, async () => {
        for (const f of await this.listFrontlineUsers(customer)) {
          if (f.id === userId) continue;
          for (const n of await c.users.userNumbers(customer.companyId, f.id, connectorId)) held.add(n);
        }
      });
      release = own.filter((n) => !held.has(n));
    }
    await step("groups", partial, () => c.groups.removeUserFromGroups(customer.locationId, userId));
    if (mappings.length) {
      await step("clear_mapping", partial, () => c.users.setUserNumberMappings(customer.companyId, userId, { mappings: [] }));
    }
    const managersUpdated: string[] = [];
    if (release.length && connectorId) {
      partial.managersUpdated = managersUpdated;
      await step("managers", partial, async () => {
        for (const m of await this.lineHolders(customer)) {
          if (m.id === userId) continue;
          const cur = await c.users.userNumbers(customer.companyId, m.id, connectorId);
          if (!cur.some((n) => release.includes(n))) continue;
          await this.mapNumbers(customer, m.id, cur.filter((n) => !release.includes(n)));
          managersUpdated.push(m.id);
        }
      });
      await step("first_alert_numbers", partial, () => c.firstAlert.removeMonitoredNumbers(customer.locationId, connectorId, release));
      await step("insights_hub_numbers", partial, () => c.insightsHub.removeNumbers(customer.locationId, connectorId, release));
    }
    await step("deactivate", partial, async () => {
      try {
        await c.users.deactivateCompanyUser(customer.companyId, userId);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err; // already deactivated
      }
    });
    return { userId, kind, extensionsReleased: release, managersUpdated };
  }

  /** End users: invited or active frontline users with After Call only (integration and excluded users left out). */
  async listFrontlineUsers(ref: CustomerRef): Promise<SeatUser[]> {
    const customer = await this.resolve(ref);
    return (await this.seatUsers(customer)).filter(isFrontline);
  }

  /** Managers: invited or active frontline users with After Call, First Alert and Insights Hub (integration and excluded users left out). */
  async listManagers(ref: CustomerRef): Promise<SeatUser[]> {
    const customer = await this.resolve(ref);
    return (await this.seatUsers(customer)).filter(isManager);
  }

  /** Integration users at the location: users tagged `department: "integration"`. */
  async listIntegrationUsers(ref: CustomerRef): Promise<SeatUser[]> {
    const customer = await this.resolve(ref);
    return (await this.seatUsers(customer)).filter(isIntegration);
  }

  /**
   * A customer leaves. In order: pause the After Call webhook (the address is kept; it can't be
   * deleted), clear the First Alert webhook address (numbers kept), deactivate the connector (which
   * stops call capture), deactivate the integration users, and deactivate the company (unless
   * `deactivateCompany: false`). Steps already done are skipped, so it is safe to run again.
   * Ask your Tresic contact about the retention of the customer's data.
   */
  async offboardCustomer(ref: CustomerRef, options: { deactivateCompany?: boolean } = {}): Promise<OffboardResult> {
    const c = this.c;
    const customer = await this.resolve(ref);
    const loc = customer.locationId;
    const result: OffboardResult = {
      webhookPaused: false,
      firstAlertWebhookCleared: false,
      connectorDeactivated: false,
      integrationUsersDeactivated: [],
      companyDeactivated: false,
    };
    const partial = result as unknown as Record<string, unknown>;
    const already = (err: unknown) => {
      if (!(err instanceof ConflictError)) throw err;
    };
    await step("pause_after_call_webhook", partial, async () => {
      let hook: { webhook_url?: string | null; enabled?: boolean } | null = null;
      try {
        hook = (await c.webhooks.getAfterCallWebhook(loc)).data ?? null;
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
      if (hook?.webhook_url && hook.enabled !== false) {
        await c.webhooks.saveAfterCallWebhook(loc, { webhook_url: hook.webhook_url, enabled: false });
        result.webhookPaused = true;
      }
    });
    await step("clear_first_alert_webhook", partial, async () => {
      const cfg = (await c.firstAlert.getFirstAlertConfig(loc)).data;
      if (cfg?.webhook_url) {
        await c.firstAlert.setWebhookUrl(loc, null);
        result.firstAlertWebhookCleared = true;
      }
    });
    await step("deactivate_connector", partial, async () => {
      const conn = customer.connectorId
        ? (((await c.connectors.getConnector(loc, customer.connectorId)).data ?? null) as { id?: string; status?: string } | null)
        : await this.bestConnector(loc);
      if (conn?.id && conn.status !== "inactive" && conn.status !== "deactivating") {
        try {
          await c.connectors.deactivateConnector(loc, conn.id);
          result.connectorDeactivated = true;
        } catch (err) {
          already(err);
        }
      }
    });
    await step("deactivate_integration_users", partial, async () => {
      for (const u of await this.listIntegrationUsers(customer)) {
        try {
          await c.users.deactivateCompanyUser(customer.companyId, u.id);
          result.integrationUsersDeactivated.push(u.id);
        } catch (err) {
          already(err);
        }
      }
    });
    if (options.deactivateCompany ?? true) {
      await step("deactivate_company", partial, async () => {
        try {
          await c.companies.deactivateCompany(customer.companyId);
          result.companyDeactivated = true;
        } catch (err) {
          already(err);
        }
      });
    }
    return result;
  }

  /**
   * Recompute the union of end-user extensions (end users holding exactly one line) and push it to
   * every manager, integration user, First Alert and Insights Hub. Managers and integration users end up with exactly
   * these lines; any other number on their mapping is removed. `dryRun: true` returns the diff without writing.
   */
  async syncNumbers(ref: CustomerRef, options: { dryRun?: boolean } = {}): Promise<SyncResult> {
    const c = this.c;
    const customer = await this.resolve(ref);
    const connectorId = this.requireConnector(customer);
    const partial: Record<string, unknown> = {};
    const lines = await step("read_frontline_numbers", partial, () => this.endUserLines(customer, connectorId));
    const union = [...lines].sort();
    const fa = await step("read_first_alert", partial, async () =>
      numbersFor((await c.firstAlert.getFirstAlertConfig(customer.locationId)).data?.connector_mappings, connectorId),
    );
    const ih = await step("read_insights_hub", partial, async () =>
      numbersFor(
        (await c.insightsHub.getInsightsHubSetup(customer.locationId)).data?.attributes?.connector_mappings,
        connectorId,
      ),
    );
    const managers: SyncResult["managers"] = [];
    await step("read_managers", partial, async () => {
      for (const m of await this.lineHolders(customer)) {
        const cur = await c.users.userNumbers(customer.companyId, m.id, connectorId);
        // managers and integration users hold exactly the lines
        const target = union;
        const d = diff(cur, target);
        if (d.add.length || d.remove.length) managers.push({ userId: m.id, ...d });
      }
    });
    const result: SyncResult = {
      dryRun: Boolean(options.dryRun),
      lines: union,
      managers,
      firstAlert: diff(fa, union),
      insightsHub: diff(ih, union),
    };
    if (options.dryRun) return result;
    await step("apply_managers", partial, async () => {
      for (const m of managers) {
        const cur = await c.users.userNumbers(customer.companyId, m.userId, connectorId);
        await this.mapNumbers(customer, m.userId, [...cur.filter((n) => !m.remove.includes(n)), ...m.add]);
      }
    });
    if (result.firstAlert.add.length || result.firstAlert.remove.length) {
      await step("apply_first_alert", partial, () => c.firstAlert.setMonitoredNumbers(customer.locationId, connectorId, union));
    }
    if (result.insightsHub.add.length || result.insightsHub.remove.length) {
      await step("apply_insights_hub", partial, () => c.insightsHub.setNumbers(customer.locationId, connectorId, union));
    }
    return result;
  }
}
