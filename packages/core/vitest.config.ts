import { defineConfig } from "vitest/config";

// Every test file boots its own in-process Postgres (PGlite, ~150–300 MB each). Unbounded workers
// (one per CPU core) exhausted memory on a 12-core machine, so cap parallelism. Override with
// BO_TEST_WORKERS for larger or smaller machines (CI uses the default).
const maxWorkers = Number(process.env.BO_TEST_WORKERS ?? 4);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
