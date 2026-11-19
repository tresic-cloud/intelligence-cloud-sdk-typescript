import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  target: "node20",
  platform: "node",
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
});
