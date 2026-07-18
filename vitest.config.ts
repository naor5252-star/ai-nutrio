import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/contracts/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
