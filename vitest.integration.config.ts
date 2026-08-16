import { defineConfig } from "vitest/config";

/**
 * The integration suite. Separate from `vitest.config.ts` on purpose: it needs
 * a live SodaMem daemon, so CI — which has none — must never pick it up.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test-integration/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
