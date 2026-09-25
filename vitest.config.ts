import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/**/src/**/*.ts"],
      exclude: [
        "packages/**/src/index.ts",
        "packages/**/src/ports.ts",
        "packages/strategy-sdk/src/**/*.ts",
      ],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
    include: ["packages/**/test/**/*.test.ts", "workers/**/test/**/*.test.ts"],
  },
});
