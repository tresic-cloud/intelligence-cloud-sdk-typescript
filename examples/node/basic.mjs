// Plain Node 20+ example. Run from the SDK folder after `npm run build`:
//   IC_DATA_EMAIL=... IC_DATA_PASSWORD=... node examples/node/basic.mjs
// Use a frontline integration user (MFA off for its company). Prints counts, not call content.
import { Client, FrontlineRequiredError } from "../../dist/index.js";

const ic = new Client({ email: process.env.IC_DATA_EMAIL, password: process.env.IC_DATA_PASSWORD, userAgent: "riverbend-bi-sync/1.0" });

try {
  const me = await ic.requireFrontline();
  console.log(`Signed in as a ${me.role} with ${me.location_ids?.length ?? 0} location(s).`);
} catch (err) {
  if (err instanceof FrontlineRequiredError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

// One page with totals for the whole filter
const since = new Date(Date.now() - 24 * 3600 * 1000);
const page = await ic.searchCalls({ dateFrom: since, limit: 10 });
console.log(`Calls in the last 24 h: ${page.summary.total_calls}`);

// Every call that matches, following cursors 100 at a time
let negative = 0;
for await (const call of ic.iterCalls({ dateFrom: since, sentiment: "very_negative" })) negative++;
console.log(`Very negative calls: ${negative}`);

// Calls with one number (any format, partial digits work)
const byPhone = await ic.searchCalls({ phone: "555-0142", dateFrom: since });
console.log(`Calls with 555-0142: ${byPhone.summary.total_calls}`);

// First Alert hits for one rule, then one alert with its call
const alerts = await ic.searchAlerts({ alertName: "Upset Customer", dateFrom: since });
console.log(`Upset Customer alerts: ${alerts.total}`);
if (alerts.items[0]) {
  const alert = await ic.getAlert(alerts.items[0].id, { withCall: true });
  console.log(`Alert ${alert?.id} is on call ${alert?.call?.id}`);
}

// Open follow-up tasks
const tasks = await ic.listTasks({ status: "open" });
console.log(`Open tasks: ${tasks.summary.total}`);
