// Provision a Base Intelligence Seat customer with an admin (reseller admin) login.
//   IC_ADMIN_EMAIL=... IC_ADMIN_PASSWORD=... IC_THREAT_PHRASES_FILE=phrases.json node examples/node/provision-seat.mjs
// The Customer Threat phrases are provided by your Tresic contact (a JSON array of strings).
import { readFileSync } from "node:fs";
import { Client, ConflictError, ExtensionMappingError, WorkflowError } from "../../dist/index.js";

const ic = new Client({ email: process.env.IC_ADMIN_EMAIL, password: process.env.IC_ADMIN_PASSWORD });
const threatPhrases = JSON.parse(readFileSync(process.env.IC_THREAT_PHRASES_FILE, "utf8"));

try {
  const customer = await ic.provisionSeatCustomer({
    // Store the company id the first run prints and pass it on every re-run (IC_COMPANY_ID).
    companyId: process.env.IC_COMPANY_ID || undefined,
    companyName: "Northgate Dental",
    primaryAdmin: { name: "Avery Chen", email: "avery.chen@example.com", phone: "+15555550150" },
    location: { name: "Northgate Dental - Main", street: "12 Elm St", city: "Springfield", state: "IL", country: "United States", zipcode: "62704" },
    threatPhrases,
    connector: {
      apiUrl: "https://pbx.example.com/ns-api/v2",
      domain: "northgate.example",
      apiKey: process.env.PHONE_SYSTEM_KEY,
    },
  });
  console.log(`Company ${customer.companyId}. Created:`, customer.created.join(", ") || "nothing (already provisioned)");
  if (customer.connectorStatus !== "active") {
    // e.g. invalid_permissions: the phone-system key must be read/write
    console.log(`Connector is ${customer.connectorStatus} (${customer.connectorStateReason ?? "no reason given"}); fix it, then re-run.`);
    process.exit(1);
  }

  // End users first; each invitation is emailed only after the user's line is mapped.
  const agent = await ic.addFrontlineUser(customer, { email: "front.desk@example.com", firstName: "Alex", lastName: "Kim" }, "2101");
  // The first manager switches both alerts on, then gets the invitation.
  const manager = await ic.addManager(customer, { email: "office.manager@example.com", firstName: "Sam", lastName: "Ortiz" });
  console.log(`End user ${agent.userId} on ${agent.extensions.join(", ")}, manager ${manager.userId}; alerts switched on: ${manager.alertsActivated.length}`);
} catch (err) {
  if (err instanceof ConflictError && err.code === "company_name_conflict") {
    console.error("Another company already has this name. Pass its id in IC_COMPANY_ID if it is this customer, or pick a different name.");
    process.exit(1);
  }
  if (err instanceof ExtensionMappingError) {
    console.error(`User ${err.userId} was created but their numbers were not mapped, and no invitation was sent. Fix the connector, then re-run.`);
    process.exit(1);
  }
  if (err instanceof WorkflowError) {
    console.error(`Stopped at ${err.step}.`);
    process.exit(1);
  }
  throw err;
}
