// Server-only Intelligence Cloud client for a Next.js app (route handlers, server actions).
// One client per process: it signs in once and reuses its tokens.
import "server-only";
import { Client } from "@intelligence-cloud/sdk";

const globalForIc = globalThis as unknown as { icClient?: Client };

export const ic =
  globalForIc.icClient ??
  new Client({
    email: process.env.IC_DATA_EMAIL!,
    password: process.env.IC_DATA_PASSWORD!,
    userAgent: "riverbend-portal/1.0",
  });

if (process.env.NODE_ENV !== "production") globalForIc.icClient = ic;
