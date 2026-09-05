import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    // Contract suites are imported by adapter specs; keep them out of direct discovery.
    exclude: ["test/contract/**"],
    testTimeout: 20_000,
  },
})
