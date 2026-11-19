import { defineConfig } from "vitest/config";

const live = process.env.IC_LIVE === "1";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: live ? 300_000 : 15_000,
    hookTimeout: live ? 300_000 : 15_000,
    // the live suite signs in once per client: never run its files in parallel
    fileParallelism: !live,
  },
});
