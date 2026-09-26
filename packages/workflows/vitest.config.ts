import { defineConfig } from "vitest/config";

// Database-backed suites boot PGlite per file; keep parallelism bounded (see packages/core).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: Number(process.env.BO_TEST_WORKERS ?? 4),
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
