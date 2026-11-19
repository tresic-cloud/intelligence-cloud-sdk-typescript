import { Core, type BodyOf, type ClientOptions, type ItemOf, type ResponseOf } from "./core.js";
import { ConnectorError, FilterError, ValidationError } from "./errors.js";
import type { components } from "./generated/openapi.js";
import {
  makeAccount,
  makeAfterCallSettings,
  makeAlerts,
  makeCalls,
  makeCompanies,
  makeConnectors,
  makeFirstAlert,
  makeGroups,
  makeInsights,
  makeInsightsHub,
  makeLocations,
  makeProducts,
  makeResellers,
  makeSso,
  makeTasks,
  makeUsers,
  makeWebhooks,
} from "./generated/resources.js";
import {
  Intelligence,
  type AlertSearch,
  type CallSearch,
  type TaskSearch,
  type TopicCallSearch,
} from "./intelligence.js";
import { mergeMappings, numbersFor, uuid4 } from "./util.js";
import { Workflows } from "./workflows.js";

type S = components["schemas"];
export type ProductKey = S["ProductKey"];
export type Connector = S["Connector"];

export interface ConnectorWaitOptions {
  /** Wait until the connector settles. Default true. */
  wait?: boolean;
  /** Seconds to wait before giving up. Default 600 (10 minutes). */
  timeout?: number;
  /** Seconds between status checks. Default 10. */
  checkInterval?: number;
}

export interface IntelligenceClientOptions extends ClientOptions {
  /**
   * Before the first conversation-data helper call, check once that this login is a frontline user
   * (admin logins get empty lists by design). Default true.
   */
  checkRole?: boolean;
}

type ConnectorData = NonNullable<ResponseOf<"getConnector">["data"]>;
type FaConfig = NonNullable<ResponseOf<"getFirstAlertConfig">["data"]>;

function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

/**
 * Intelligence Cloud partner API client. One client per credential.
 *
 * - Customer lifecycle (admin credentials): low-level namespaces mirroring the API reference
 *   (`companies`, `locations`, `users`, …) and the Base Intelligence Seat workflows
 *   (`client.workflows.provisionSeatCustomer(…)`, also on the client itself).
 * - Conversation intelligence (frontline credentials): `client.intelligence.searchCalls(…)`,
 *   also on the client itself (`client.searchCalls(…)`).
 *
 *     const ic = new Client({ email: process.env.IC_EMAIL!, password: process.env.IC_PASSWORD! });
 */
export class Client {
  /** @internal transport, auth, retries, projection */
  readonly core: Core;

  readonly resellers;
  readonly companies;
  readonly sso;
  readonly products;
  readonly locations;
  readonly groups;
  readonly connectors;
  readonly firstAlert;
  readonly insightsHub;
  readonly users;
  readonly afterCallSettings;
  readonly account;
  readonly calls;
  readonly alerts;
  readonly tasks;
  readonly insights;
  readonly webhooks;
  /** Conversation intelligence helpers (frontline credentials). */
  readonly intelligence: Intelligence;
  /** Base Intelligence Seat workflows (admin credentials). */
  readonly workflows: Workflows;

  constructor(options: IntelligenceClientOptions) {
    const c = (this.core = new Core(options));

    this.resellers = makeResellers(c);
    this.sso = makeSso(c);
    this.products = makeProducts(c);
    this.account = makeAccount(c);
    this.calls = makeCalls(c);
    this.alerts = makeAlerts(c);
    this.tasks = makeTasks(c);
    this.insights = makeInsights(c);
    this.webhooks = makeWebhooks(c);
    this.afterCallSettings = makeAfterCallSettings(c);

    // ---------------------------------------------------------------- companies
    const companies = makeCompanies(c);
    const companyProducts = async (companyId: string) =>
      (await companies.getCompany(companyId)).data?.attributes?.enabled_products ?? [];
    this.companies = {
      ...companies,
      /** Turn products on for a company, keeping the others (`enabled_products` is a full replacement). */
      addProducts: async (companyId: string, productKeys: ProductKey[]) => {
        const cur = await companyProducts(companyId);
        const next = uniq([...cur, ...productKeys]);
        if (next.length === cur.length) return companies.getCompany(companyId);
        return companies.updateCompany(companyId, { enabled_products: next });
      },
      /** Turn products off for a company, keeping the others. A company keeps at least one product. */
      removeProducts: async (companyId: string, productKeys: ProductKey[]) => {
        const cur = await companyProducts(companyId);
        const next = cur.filter((k) => !productKeys.includes(k));
        if (next.length === 0) throw new FilterError("A company keeps at least one product; the API ignores an empty list.");
        if (next.length === cur.length) return companies.getCompany(companyId);
        return companies.updateCompany(companyId, { enabled_products: next });
      },
      /**
       * The first company with exactly this name (the list search is a prefix match), or null.
       * Company names are not unique: use `findCompanies` and check the contact email, or keep the id.
       */
      findCompany: async (resellerId: string, companyName: string) => {
        for await (const row of companies.iterCompanies(resellerId, { search: companyName })) {
          if (row.company_name === companyName) return row;
        }
        return null;
      },
      /** Every company with exactly this name under the reseller (names are not unique). */
      findCompanies: async (resellerId: string, companyName: string) => {
        const out: ItemOf<"listCompanies">[] = [];
        for await (const row of companies.iterCompanies(resellerId, { search: companyName })) {
          if (row.company_name === companyName) out.push(row);
        }
        return out;
      },
    };

    // ---------------------------------------------------------------- locations
    const locations = makeLocations(c);
    const locationProducts = async (companyId: string, locationId: string) =>
      (await locations.getLocation(companyId, locationId)).data?.attributes?.enabled_products ?? [];
    this.locations = {
      ...locations,
      /** Turn products on for a location, keeping the others. They must be on for the company. */
      addProducts: async (companyId: string, locationId: string, productKeys: ProductKey[]) => {
        const cur = await locationProducts(companyId, locationId);
        const next = uniq([...cur, ...productKeys]);
        if (next.length === cur.length) return locations.getLocation(companyId, locationId);
        return locations.updateLocation(companyId, locationId, { enabled_products: next });
      },
      removeProducts: async (companyId: string, locationId: string, productKeys: ProductKey[]) => {
        const cur = await locationProducts(companyId, locationId);
        const next = cur.filter((k) => !productKeys.includes(k));
        if (next.length === cur.length) return locations.getLocation(companyId, locationId);
        return locations.updateLocation(companyId, locationId, { enabled_products: next });
      },
      /** The location with exactly this name, or null. */
      findLocation: async (companyId: string, locationName: string) => {
        for await (const row of locations.iterCompanyLocations(companyId, { search: locationName })) {
          if (row.location_name === locationName) return row;
        }
        return null;
      },
    };

    // ---------------------------------------------------------------- groups
    const groups = makeGroups(c);
    const memberIds = async (locationId: string, groupId: string) =>
      ((await groups.getUserGroup(locationId, groupId)).data?.attributes?.members ?? []).map((m) => m.id!).filter(Boolean);
    const userGroupIds = async (locationId: string, userId: string) =>
      ((await groups.getUserGroupMembership(locationId, userId)).data ?? []).filter((g) => g.is_member).map((g) => g.id!);
    this.groups = {
      ...groups,
      /** Add members to a group (`member_ids` is a full replacement underneath). */
      addMembers: async (locationId: string, groupId: string, userIds: string[]) =>
        groups.updateUserGroup(locationId, groupId, { member_ids: uniq([...(await memberIds(locationId, groupId)), ...userIds]) }),
      removeMembers: async (locationId: string, groupId: string, userIds: string[]) =>
        groups.updateUserGroup(locationId, groupId, {
          member_ids: (await memberIds(locationId, groupId)).filter((id) => !userIds.includes(id)),
        }),
      /** Ids of the groups the user is in at this location. */
      userGroupIds,
      /** Add a user to groups at a location (`group_ids` is a full replacement underneath). */
      addUserToGroups: async (locationId: string, userId: string, groupIds: string[]) =>
        groups.setUserGroupMembership(locationId, userId, {
          group_ids: uniq([...(await userGroupIds(locationId, userId)), ...groupIds]),
        }),
      /** Remove a user from some groups, or from every group when `groupIds` is omitted. */
      removeUserFromGroups: async (locationId: string, userId: string, groupIds?: string[]) =>
        groups.setUserGroupMembership(locationId, userId, {
          group_ids: groupIds ? (await userGroupIds(locationId, userId)).filter((id) => !groupIds.includes(id)) : [],
        }),
      /** The group with exactly this name at the location, or null. */
      findGroup: async (locationId: string, groupName: string) => {
        for await (const row of groups.iterUserGroups(locationId, { search: groupName })) {
          if (row.group_name === groupName) return row;
        }
        return null;
      },
    };

    // ---------------------------------------------------------------- connectors
    const connectors = makeConnectors(c);
    /**
     * Check the connector every `checkInterval` seconds (10) until its status is one of `final`,
     * for up to `timeout` seconds (600). Throws ConnectorError when it lands in
     * `error` (unless `raiseOnError` is false or `error` is in `final`) or does not settle in time.
     */
    const waitForStatus = async (
      locationId: string,
      connectorId: string,
      final: string[],
      o: { timeout?: number; checkInterval?: number; raiseOnError?: boolean } = {},
    ): Promise<ConnectorData> => {
      const deadline = c.now() + (o.timeout ?? 600) * 1000;
      for (;;) {
        const conn = ((await connectors.getConnector(locationId, connectorId)).data ?? {}) as ConnectorData;
        const st = conn.status ?? null;
        if (st === "error" && (o.raiseOnError ?? true) && !final.includes("error")) {
          throw new ConnectorError(
            `Connector is in error${conn.state_reason ? ` (${conn.state_reason})` : ""}.`,
            conn.state_reason ?? null,
            st,
            conn as Record<string, unknown>,
          );
        }
        if (st && final.includes(st)) return conn;
        if (c.now() >= deadline) {
          throw new ConnectorError(`Connector did not settle in time (status ${st ?? "unknown"}).`, null, st, conn as Record<string, unknown>);
        }
        await c.sleep((o.checkInterval ?? 10) * 1000);
      }
    };
    const settle = async (locationId: string, first: ResponseOf<"getConnector">, final: string[], o: ConnectorWaitOptions, raiseOnError = true) => {
      if (o.wait === false || !first.data?.id) return first;
      return { data: await waitForStatus(locationId, first.data.id, final, { ...o, raiseOnError }) };
    };
    this.connectors = {
      ...connectors,
      waitForStatus,
      /**
       * Create a connector (202) and, by default, wait until it is `active`.
       * Throws `ConnectorError` with `stateReason` (e.g. `invalid_permissions`) when it ends in `error`.
       */
      createConnector: async (locationId: string, body: BodyOf<"createConnector">, o: ConnectorWaitOptions = {}) =>
        settle(locationId, await connectors.createConnector(locationId, body), ["active"], o),
      /** Update a connector; when it reconnects (202), wait until it is `active`. */
      updateConnector: async (locationId: string, connectorId: string, body: BodyOf<"updateConnector">, o: ConnectorWaitOptions = {}) => {
        const r = await connectors.updateConnector(locationId, connectorId, body);
        return r.data?.status === "connecting" ? settle(locationId, r, ["active"], o) : r;
      },
      /** Restart a connector and, by default, wait until it is `active` (ConnectorError on `error`). */
      reactivateConnector: async (locationId: string, connectorId: string, o: ConnectorWaitOptions = {}) =>
        settle(locationId, await connectors.reactivateConnector(locationId, connectorId), ["active"], o),
      /** Stop a connector and, by default, wait until it is `inactive`. */
      deactivateConnector: async (locationId: string, connectorId: string, o: ConnectorWaitOptions = {}) =>
        settle(locationId, await connectors.deactivateConnector(locationId, connectorId), ["inactive"], o, false),
      /** The connector with exactly this name at the location, or null. */
      findConnector: async (locationId: string, name: string) => {
        for await (const row of connectors.iterLocationConnectors(locationId, { search: name })) {
          if (row.name === name) return row;
        }
        return null;
      },
    };

    // ---------------------------------------------------------------- First Alert
    const firstAlert = makeFirstAlert(c);
    const faSave = async (locationId: string, change: (cfg: FaConfig) => { webhook_url: string | null; connector_mappings: { connector_id: string; monitored_numbers: string[] }[] }) => {
      const cfg = ((await firstAlert.getFirstAlertConfig(locationId)).data ?? {}) as FaConfig;
      return firstAlert.saveFirstAlertConfig(locationId, change(cfg));
    };
    const ruleGroupIds = async (locationId: string, ruleId: string) =>
      ((await firstAlert.getAlertRule(locationId, ruleId)).data?.attributes?.groups ?? []).map((g) => g.id!).filter(Boolean);
    this.firstAlert = {
      ...firstAlert,
      /** Add monitored numbers for one connector, keeping the webhook URL and every other number. */
      addMonitoredNumbers: (locationId: string, connectorId: string, numbers: string[]) =>
        faSave(locationId, (cfg) => ({
          webhook_url: cfg.webhook_url ?? null,
          connector_mappings: mergeMappings(cfg.connector_mappings, connectorId, numbers),
        })),
      removeMonitoredNumbers: (locationId: string, connectorId: string, numbers: string[]) =>
        faSave(locationId, (cfg) => ({
          webhook_url: cfg.webhook_url ?? null,
          connector_mappings: mergeMappings(cfg.connector_mappings, connectorId, [], numbers),
        })),
      /** Replace the monitored numbers of one connector; other connectors and the webhook URL are kept. */
      setMonitoredNumbers: (locationId: string, connectorId: string, numbers: string[]) =>
        faSave(locationId, (cfg) => ({
          webhook_url: cfg.webhook_url ?? null,
          connector_mappings: mergeMappings(
            (cfg.connector_mappings ?? []).filter((m) => m.connector_id !== connectorId),
            connectorId,
            numbers,
          ),
        })),
      /** Set (null clears) the location alert webhook URL, keeping the monitored numbers. */
      setWebhookUrl: (locationId: string, url: string | null) =>
        faSave(locationId, (cfg) => ({ webhook_url: url, connector_mappings: mergeMappings(cfg.connector_mappings, "") })),
      /** Route a rule to more groups (`group_ids` is a full replacement underneath). */
      addRuleGroups: async (locationId: string, ruleId: string, groupIds: string[]) =>
        firstAlert.updateAlertRule(locationId, ruleId, { group_ids: uniq([...(await ruleGroupIds(locationId, ruleId)), ...groupIds]) }),
      removeRuleGroups: async (locationId: string, ruleId: string, groupIds: string[]) =>
        firstAlert.updateAlertRule(locationId, ruleId, {
          group_ids: (await ruleGroupIds(locationId, ruleId)).filter((id) => !groupIds.includes(id)),
        }),
      /** The rule with exactly this name at the location, or null. */
      findRule: async (locationId: string, name: string) => {
        for await (const row of firstAlert.iterAlertRules(locationId)) {
          if (row.name === name) return row;
        }
        return null;
      },
    };

    // ---------------------------------------------------------------- Insights Hub
    const insightsHub = makeInsightsHub(c);
    const ihSetup = async (locationId: string) => (await insightsHub.getInsightsHubSetup(locationId)).data?.attributes ?? {};
    this.insightsHub = {
      ...insightsHub,
      /** Add numbers to the location's Insights Hub for one connector (read, merge, PATCH). */
      addNumbers: async (locationId: string, connectorId: string, numbers: string[]) =>
        insightsHub.updateInsightsHubSetup(locationId, {
          connector_mappings: mergeMappings((await ihSetup(locationId)).connector_mappings, connectorId, numbers),
        }),
      removeNumbers: async (locationId: string, connectorId: string, numbers: string[]) =>
        insightsHub.updateInsightsHubSetup(locationId, {
          connector_mappings: mergeMappings((await ihSetup(locationId)).connector_mappings, connectorId, [], numbers),
        }),
      setNumbers: async (locationId: string, connectorId: string, numbers: string[]) =>
        insightsHub.updateInsightsHubSetup(locationId, {
          connector_mappings: mergeMappings(
            ((await ihSetup(locationId)).connector_mappings ?? []).filter((m) => m.connector_id !== connectorId),
            connectorId,
            numbers,
          ),
        }),
      /** Give groups Insights Hub access, keeping the others. Saves the setup (upsert) so it works on a new location. */
      addGroups: async (locationId: string, groupIds: string[]) => {
        const cur = await ihSetup(locationId);
        return insightsHub.saveInsightsHubSetup(locationId, {
          connector_mappings: mergeMappings(cur.connector_mappings, ""),
          group_access: uniq([...(cur.group_access ?? []), ...groupIds]),
        });
      },
      removeGroups: async (locationId: string, groupIds: string[]) =>
        insightsHub.updateInsightsHubSetup(locationId, {
          group_access: ((await ihSetup(locationId)).group_access ?? []).filter((g) => !groupIds.includes(g)),
        }),
    };

    // ---------------------------------------------------------------- users
    const users = makeUsers(c);
    const findUserByEmail = async (companyId: string, email: string) => {
      const want = email.trim().toLowerCase();
      for await (const row of users.iterCompanyUsers(companyId, { search: email.trim() })) {
        if ((row.email ?? "").toLowerCase() === want) return row;
      }
      return null;
    };
    const currentMappings = async (companyId: string, userId: string) =>
      (await users.getUserNumberMappings(companyId, userId)).data ?? [];
    const userLocationIds = async (companyId: string, userId: string) =>
      ((await users.getCompanyUser(companyId, userId)).data?.attributes?.locations ?? []).map((l) => l.location_id!).filter(Boolean);
    this.users = {
      ...users,
      /**
       * Create a user. Always sends an `Idempotency-Key` (a new UUID unless you pass one), reused on
       * retries. A 422 can leave the user behind: the SDK then finds the user by email and applies
       * `location_ids` (and role) with PATCH, returning the user. The one-time sign-in link the API
       * may include is never returned.
       */
      createCompanyUser: async (
        companyId: string,
        body: BodyOf<"createCompanyUser">,
        o: { idempotencyKey?: string } = {},
      ): Promise<ResponseOf<"getCompanyUser">> => {
        const key = o.idempotencyKey ?? (await uuid4());
        try {
          return await c.call("createCompanyUser", [companyId], { body, idempotencyKey: key });
        } catch (err) {
          if (!(err instanceof ValidationError) || err.status !== 422 || !body.email) throw err;
          const found = await findUserByEmail(companyId, body.email);
          if (!found?.id) throw err;
          const patch: BodyOf<"updateCompanyUser"> = { role: body.role };
          if (body.location_ids?.length) patch.location_ids = body.location_ids;
          try {
            return await users.updateCompanyUser(companyId, found.id, patch);
          } catch {
            throw err;
          }
        }
      },
      /** The user with exactly this email, or null. */
      findUserByEmail,
      /** Assign the user to more locations (`location_ids` is a full replacement underneath). */
      addLocations: async (companyId: string, userId: string, locationIds: string[]) =>
        users.updateCompanyUser(companyId, userId, { location_ids: uniq([...(await userLocationIds(companyId, userId)), ...locationIds]) }),
      removeLocations: async (companyId: string, userId: string, locationIds: string[]) =>
        users.updateCompanyUser(companyId, userId, {
          location_ids: (await userLocationIds(companyId, userId)).filter((id) => !locationIds.includes(id)),
        }),
      /** The numbers mapped to the user (for one connector, or all). */
      userNumbers: async (companyId: string, userId: string, connectorId?: string) => {
        const cur = await currentMappings(companyId, userId);
        return connectorId ? numbersFor(cur, connectorId) : uniq(cur.flatMap((m) => m.monitored_numbers ?? []));
      },
      /** Map more numbers to the user for one connector (read, merge, PUT). The connector must be `active`. */
      addNumbers: async (companyId: string, userId: string, connectorId: string, numbers: string[]) =>
        users.setUserNumberMappings(companyId, userId, {
          mappings: mergeMappings(await currentMappings(companyId, userId), connectorId, numbers),
        }),
      removeNumbers: async (companyId: string, userId: string, connectorId: string, numbers: string[]) =>
        users.setUserNumberMappings(companyId, userId, {
          mappings: mergeMappings(await currentMappings(companyId, userId), connectorId, [], numbers),
        }),
      /** Replace the user's numbers on one connector; other connectors are kept. */
      setNumbers: async (companyId: string, userId: string, connectorId: string, numbers: string[]) =>
        users.setUserNumberMappings(companyId, userId, {
          mappings: mergeMappings(
            (await currentMappings(companyId, userId)).filter((m) => m.connector_id !== connectorId),
            connectorId,
            numbers,
          ),
        }),
      /** Swap one number for another in the user's mapping, in a single write. */
      replaceNumber: async (companyId: string, userId: string, connectorId: string, oldNumber: string, newNumber: string) =>
        users.setUserNumberMappings(companyId, userId, {
          mappings: mergeMappings(await currentMappings(companyId, userId), connectorId, [newNumber], [oldNumber]),
        }),
    };

    this.intelligence = new Intelligence(this, options.checkRole ?? true);
    this.workflows = new Workflows(this);
  }

  // ================================================================ session
  /** Ends ALL sessions of this user (web app and other jobs too). The SDK never calls it on its own. */
  logout(): Promise<void> {
    return this.core.logout();
  }

  /** Forget this client's tokens. Does not sign out on the server. */
  close(): Promise<void> {
    return this.core.close();
  }

  // ================================================================ intelligence shortcuts
  whoami() { return this.intelligence.whoami(); }
  requireFrontline() { return this.intelligence.requireFrontline(); }
  searchCalls(filters?: CallSearch) { return this.intelligence.searchCalls(filters); }
  iterCalls(filters?: Omit<CallSearch, "cursor"> & { maxItems?: number }) { return this.intelligence.iterCalls(filters); }
  getCall(callId: string) { return this.intelligence.getCall(callId); }
  getTranscript(callId: string) { return this.intelligence.getTranscript(callId); }
  getRecordingUrl(callId: string) { return this.intelligence.getRecordingUrl(callId); }
  searchAlerts(filters?: AlertSearch) { return this.intelligence.searchAlerts(filters); }
  iterAlerts(filters?: Omit<AlertSearch, "cursor"> & { maxItems?: number }) { return this.intelligence.iterAlerts(filters); }
  getAlert(alertId: string, options?: { withCall?: boolean }) { return this.intelligence.getAlert(alertId, options); }
  getAlertsDashboard(filters?: Parameters<Intelligence["getAlertsDashboard"]>[0]) { return this.intelligence.getAlertsDashboard(filters); }
  listTasks(filters?: TaskSearch) { return this.intelligence.listTasks(filters); }
  iterTasks(filters?: Omit<TaskSearch, "cursor"> & { maxItems?: number }) { return this.intelligence.iterTasks(filters); }
  getInsightsDashboard(filters: Parameters<Intelligence["getInsightsDashboard"]>[0]) { return this.intelligence.getInsightsDashboard(filters); }
  listTopicCalls(slug: string, filters?: TopicCallSearch) { return this.intelligence.listTopicCalls(slug, filters); }
  iterTopicCalls(slug: string, filters?: Omit<TopicCallSearch, "cursor"> & { maxItems?: number }) { return this.intelligence.iterTopicCalls(slug, filters); }
  getAfterCallWebhook(locationId: string) { return this.intelligence.getAfterCallWebhook(locationId); }
  setAfterCallWebhook(locationId: string, url: string, enabled = true) { return this.intelligence.setAfterCallWebhook(locationId, url, enabled); }
  testAfterCallWebhook(locationId: string) { return this.intelligence.testAfterCallWebhook(locationId); }
  getFirstAlertWebhook(locationId: string) { return this.intelligence.getFirstAlertWebhook(locationId); }
  setFirstAlertWebhook(locationId: string, url: string | null) { return this.intelligence.setFirstAlertWebhook(locationId, url); }
  testFirstAlertWebhook(locationId: string, url?: string) { return this.intelligence.testFirstAlertWebhook(locationId, url); }

  // ================================================================ workflow shortcuts
  provisionSeatCustomer(...a: Parameters<Workflows["provisionSeatCustomer"]>) { return this.workflows.provisionSeatCustomer(...a); }
  getSeatCustomer(...a: Parameters<Workflows["getSeatCustomer"]>) { return this.workflows.getSeatCustomer(...a); }
  addFrontlineUser(...a: Parameters<Workflows["addFrontlineUser"]>) { return this.workflows.addFrontlineUser(...a); }
  addManager(...a: Parameters<Workflows["addManager"]>) { return this.workflows.addManager(...a); }
  activateSeatAlerts(...a: Parameters<Workflows["activateSeatAlerts"]>) { return this.workflows.activateSeatAlerts(...a); }
  changeUserExtension(...a: Parameters<Workflows["changeUserExtension"]>) { return this.workflows.changeUserExtension(...a); }
  removeUser(...a: Parameters<Workflows["removeUser"]>) { return this.workflows.removeUser(...a); }
  listFrontlineUsers(...a: Parameters<Workflows["listFrontlineUsers"]>) { return this.workflows.listFrontlineUsers(...a); }
  listManagers(...a: Parameters<Workflows["listManagers"]>) { return this.workflows.listManagers(...a); }
  addIntegrationUser(...a: Parameters<Workflows["addIntegrationUser"]>) { return this.workflows.addIntegrationUser(...a); }
  listIntegrationUsers(...a: Parameters<Workflows["listIntegrationUsers"]>) { return this.workflows.listIntegrationUsers(...a); }
  offboardCustomer(...a: Parameters<Workflows["offboardCustomer"]>) { return this.workflows.offboardCustomer(...a); }
  syncNumbers(...a: Parameters<Workflows["syncNumbers"]>) { return this.workflows.syncNumbers(...a); }
}
